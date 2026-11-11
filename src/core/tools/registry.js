// Tool definitions + runner. Tool: { name, description, params: JSONSchema, async run(args, ctx) → string, timeoutMs?, aliases?, untrusted? }
// aliases: names the model has made up in the past for this tool.
// untrusted: the result is text from outside (taints the turn, never backs an action claim).
const { buildCatalog } = require('../skills');

const MAX_EXTRA_LOADS = 2;   // more_skills and auto-load share this cap per turn
const norm = s => String(s ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/_?(?:skills?|group)$/, '');

function createToolRunner(tools, { timeoutMs = 10000, groups = null } = {}) {
  const byName = new Map(tools.map(t => [t.name, t]));
  const names = [...byName.keys()];
  for (const t of tools) for (const a of t.aliases || []) if (!byName.has(a)) byName.set(a, t);
  const catalog = groups ? buildCatalog(groups) : null;

  const unknown = name => ({ ok: false, text: `Error: unknown tool ${name}. Tools that exist: ${names.join(', ')}. Use one of those, or say you cannot do it.` });
  const tainted = (tool, ctx) => tool.risk === 'confirm' && (!ctx.turn || ctx.turn.tainted);
  const taintedText = { ok: false, text: "Error: I won't start that from text I read. Ask me directly." };

  function specs() {
    return tools.map(({ name, description, params }) => ({ name, description, params }));
  }

  async function exec(tool, name, args, ctx) {
    // confirm tools only start from the user's own words (see brain/guard.js)
    if (tainted(tool, ctx)) return taintedText;
    const flag = tool.untrusted === true ? { untrusted: true } : {};   // only set when true, so results of ordinary tools stay { ok, text }
    let timer;
    try {
      const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`tool ${name} timed out`)), tool.timeoutMs || timeoutMs);
      });
      const text = await Promise.race([Promise.resolve().then(() => tool.run(args || {}, ctx)), timeout]);
      return { ok: true, text: String(text), ...flag };
    } catch (err) {
      return { ok: false, text: `Error: ${err?.message || err}`, ...flag };
    } finally {
      clearTimeout(timer);
    }
  }

  async function run(name, args, ctx = {}) {
    const tool = byName.get(name);
    return tool ? exec(tool, name, args, ctx) : unknown(name);
  }

  // One turn's view: only the loaded groups' tools are offered; more can be loaded (cap of 2) by more_skills
  // or by the model calling a tool of an unloaded group. Without groups every tool is always in scope.
  function turn(ids = []) {
    if (!catalog) return { specs, run, loaded: () => [], hints: () => [] };
    const loaded = [];
    const add = id => { if (!loaded.includes(id)) loaded.push(id); };
    for (const id of ids) if (catalog.ids.includes(id)) add(id);
    let extra = 0;
    const group = id => catalog.groups.find(g => g.id === id);
    const inScope = tool => loaded.some(id => group(id).tools.includes(tool));

    function resolveGroup(want) {
      const key = norm(want);
      const hit = catalog.groups.find(g => norm(g.id) === key || norm(g.label) === key);
      if (hit) return hit.id;
      return catalog.byName.get(String(want ?? '').trim())?.groupId ?? catalog.byName.get(key)?.groupId ?? null;
    }

    function load(want) {
      const id = resolveGroup(want);
      if (!id) return { ok: false, text: `Unknown group. Groups: ${catalog.ids.join(', ')}.` };
      const g = group(id);
      const list = g.tools.map(t => t.name).join(', ');
      if (loaded.includes(id)) return { ok: true, text: `Already loaded ${g.label}: ${list}.` };
      if (extra >= MAX_EXTRA_LOADS) return { ok: false, text: `Cannot load more skills this turn (limit ${MAX_EXTRA_LOADS}). Answer with what you have.` };
      extra++;
      add(id);
      return { ok: true, text: `Loaded ${g.label}: ${list}.` };
    }

    async function scopedRun(name, args, ctx = {}) {
      const tool = byName.get(name);
      if (!tool) return unknown(name);
      const c = { ...ctx, skills: { load } };
      if (!inScope(tool)) {
        // refuse before loading anything: auto-load never gets around risk or taint
        if (tainted(tool, c)) return taintedText;
        const gid = catalog.groupOf(tool.name);
        if (gid) {
          const r = load(gid);
          if (!r.ok) return r;
        }
      }
      return exec(tool, name, args, c);
    }

    return {
      specs: () => loaded.flatMap(id => group(id).tools).map(({ name, description, params }) => ({ name, description, params })),
      run: scopedRun,
      loaded: () => [...loaded],
      hints: () => loaded.map(id => group(id).hint).filter(Boolean),
    };
  }

  return { specs, run, turn };
}

module.exports = { createToolRunner, MAX_EXTRA_LOADS };
