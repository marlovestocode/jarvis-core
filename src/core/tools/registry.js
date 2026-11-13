// Tool definitions + runner. Tool: { name, description, params: JSONSchema, async run(args, ctx) → string, timeoutMs?, hint?, aliases?, mistakes?, untrusted?, risk? }
// A tool is the ONE place that says what it is: hint = the guidance line the prompt shows while it is in scope, aliases = wrong names the
// model has used (resolved to the tool), mistakes = wrong names with an obvious meaning ({ match: RegExp, args?: m => arguments }).
// The prompt, the capabilities line and the unknown-tool handling are generated from tools and groups; test/tool-registry-consistency.test.js
// fails when a copy of any of it drifts.
// ctx.skills = { catalog, stats(), load?(group), loaded?() }: load and loaded only inside a turn with skill groups.
// aliases: names the model has made up in the past for this tool.
// untrusted: the result is text from outside (taints the turn, never backs an action claim).
const { buildCatalog } = require('../skills');
const { resolveInvented, closest } = require('./invented');
const { checkArgs } = require('./args');

const DIRECT_MAX = 300;      // a result longer than this still goes through the model
const MAX_EXTRA_LOADS = 2;   // more_skills and auto-load share this cap per turn
const norm = s => String(s ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/_?(?:skills?|group)$/, '');

function createToolRunner(tools, { timeoutMs = 10000, groups = null } = {}) {
  const byName = new Map(tools.map(t => [t.name, t]));
  const names = [...byName.keys()];
  for (const t of tools) for (const a of t.aliases || []) if (!byName.has(a)) byName.set(a, t);
  const catalog = groups ? buildCatalog(groups) : null;
  // what tools see as ctx.skills: the catalog calls are dispatched from, and how each tool has done since start
  const stats = new Map();   // tool name → { calls, fails, lastError, lastAt }
  const view = { catalog: catalog || buildCatalog([{ id: 'all', label: 'All tools', triggers: [], tools }]), stats: () => new Map(stats) };
  function note(tool, res) {
    const s = stats.get(tool.name) || { calls: 0, fails: 0, lastError: '', lastAt: 0 };
    s.calls++;
    s.lastAt = Date.now();
    if (!res.ok) { s.fails++; s.lastError = res.text; if (res.badArgs) s.badArgs = (s.badArgs || 0) + 1; }
    stats.set(tool.name, s);
    return res;
  }

  const unknown = name => {
    const near = closest(name, names);
    return { ok: false, text: `Error: unknown tool ${name}.${near.length ? ` Did you mean ${near.join(' or ')}?` : ''} Tools that exist: ${names.join(', ')}. Use one of those, or say you cannot do it.` };
  };
  // a name the model made up, with an obvious real meaning: run the real tool and say what its name is
  const reroute = (res, name, real) => (res.ok ? { ...res, text: `${res.text}
(The tool is called ${real}, not ${name}.)` } : res);
  const groupList = () => (catalog ? catalog.groups.map(g => ({ id: g.id, label: g.label })) : []);
  // confirm tools need a known clean turn; durable-state tools (needsClean: memory) only refuse a turn known to be tainted
  const tainted = (tool, ctx) => (tool.risk === 'confirm' && (!ctx.turn || ctx.turn.tainted)) || (tool.needsClean === true && !!ctx.turn?.tainted);
  const taintedText = { ok: false, text: "Error: I won't start that from text I read. Ask me directly." };

  function specs() {
    return tools.map(({ name, description, params }) => ({ name, description, params }));
  }

  async function exec(tool, name, args, ctx) {
    // confirm tools only start from the user's own words (see brain/guard.js)
    if (tainted(tool, ctx)) return taintedText;
    // the arguments must fit the tool's own schema before its code runs ("5" becomes 5; a missing or impossible value is refused, not guessed)
    const flag = tool.untrusted === true ? { untrusted: true } : {};   // only set when true, so results of ordinary tools stay { ok, text }
    const checked = checkArgs(tool, args);
    if (!checked.ok) return note(tool, { ok: false, text: checked.text, badArgs: true, ...flag });
    args = checked.args;
    let timer;
    try {
      const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`tool ${name} timed out`)), tool.timeoutMs || timeoutMs);
      });
      const text = await Promise.race([Promise.resolve().then(() => tool.run(args || {}, ctx)), timeout]);
      return note(tool, { ok: true, text: String(text), ...flag });
    } catch (err) {
      return note(tool, { ok: false, text: `Error: ${err?.message || err}`, ...flag });
    } finally {
      clearTimeout(timer);
    }
  }

  async function run(name, args, ctx = {}) {
    const tool = byName.get(name);
    if (tool) return exec(tool, name, args, { ...ctx, skills: view });
    const alt = resolveInvented(name, tools, groupList());
    if (alt?.tool) return reroute(await run(alt.tool, { ...(args || {}), ...alt.args }, ctx), name, alt.tool);
    if (alt?.group) {
      const g = catalog.groups.find(x => x.id === alt.group);
      return { ok: true, text: `${name} is a skill group, not a tool. Its tools: ${g.tools.map(t => t.name).join(', ')}. Call one of those.` };
    }
    return unknown(name);
  }

  // One turn's view: only the loaded groups' tools are offered; more can be loaded (cap of 2) by more_skills
  // or by the model calling a tool of an unloaded group. Without groups every tool is always in scope.
  function turn(ids = []) {
    if (!catalog) return { specs, run, resolves, direct, loaded: () => [], hints: () => [] };
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
      if (!tool) {
        const alt = resolveInvented(name, tools, groupList());
        if (alt?.tool) return reroute(await scopedRun(alt.tool, { ...(args || {}), ...alt.args }, ctx), name, alt.tool);
        if (alt?.group) {          // a group's name called as a tool: load the group and say which tools it has
          const r = load(alt.group);
          return r.ok ? { ok: true, text: `${name} is a skill group, not a tool. ${r.text} Call one of those tools.` } : r;
        }
        return unknown(name);
      }
      const c = { ...ctx, skills: { ...view, load, loaded: () => [...loaded] } };
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
      resolves,
      loaded: () => [...loaded],
      hints: () => loaded.map(id => group(id).hint).filter(Boolean),
      direct,
    };
  }

  // direct(name, text) → the reply to give as it is (a tool whose result already reads as the answer), or null
  const direct = (name, text) => {
    const d = byName.get(name)?.direct;
    if (!d) return null;
    const out = d === true ? String(text) : String(d(String(text)));
    return out && out.length <= DIRECT_MAX && out.split('\n').length <= 6 ? out : null;
  };
  const resolves = name => byName.has(name) || !!resolveInvented(name, tools, groupList());
  return { specs, run, turn, resolves, direct, stats: view.stats };
}

module.exports = { createToolRunner, MAX_EXTRA_LOADS };
