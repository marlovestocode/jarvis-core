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

const { speakerReason } = require('./speaker');
const { firstSentence } = require('./constrain');
const { ledgerGate, ledgerRecord, ledgerTimeout } = require('./ledger');

// Guest turns (turn.speaker 'guest': speaker recognition heard a voice that is not the owner's) are DEFAULT DENY: only these
// tools run, everything else is refused with the guest text, before its arguments are checked or its group is loaded. Allowed:
// pure or public lookups that read nothing of the owner's (no memory, chats, music, media, timers, browser, clipboard, files,
// windows, PC or system settings, JARVIS's own config and logs, analytics, tasks). A value names an argument the guest must give
// itself: without it the tool would fall back to the owner's home or followed teams. A new tool stays denied until added here.
const GUEST_TOOLS = new Map([
  ['get_time', null], ['more_skills', null],
  ['lookup_knowledge', null], ['read_article', null], ['web_search', null], ['web_open', null], ['news_headlines', null],
  ['get_weather', 'place'], ['weather_alerts', 'place'], ['sports_scores', 'team'],
  ['calculate', null], ['solve_equation', null], ['integrate', null], ['differentiate', null], ['statistics', null],
  ['convert_units', null], ['physics_constant', null], ['date_calc', null],
  ['find_song_by_lyric', null],
]);
// null = the tool may run for this turn; otherwise the refusal
function guestRefusal(tool, args, ctx) {
  if (ctx.turn?.speaker !== 'guest') return null;
  if (!GUEST_TOOLS.has(tool.name)) return { ok: false, denied: true, text: `Error: ${speakerReason(ctx.turn)}` };
  const need = GUEST_TOOLS.get(tool.name);
  const v = need && args && typeof args === 'object' ? args[need] : undefined;
  if (need && !(typeof v === 'string' && v.trim())) return { ok: false, denied: true, text: `Error: name the ${need}. For a guest I never use my owner's ${need === 'place' ? 'home' : 'teams'}.` };
  return null;
}

// Why discovery should not offer a tool this turn, or null. ADVISORY: it hides tools the model could not run anyway;
// exec() and guestRefusal() above still decide, so a wrong answer here can never grant anything.
function eligibility(tool, turn = {}) {
  if (turn.speaker === 'guest' && !GUEST_TOOLS.has(tool.name)) return 'guest';
  if (turn.tainted && (tool.risk === 'confirm' || tool.needsClean === true)) return 'tainted';
  return null;
}

const DIRECT_MAX = 300;     // a result longer than this still goes through the model
const MAX_EXTRA_LOADS = 2;   // more_skills and auto-load share this cap per turn
const norm = s => String(s ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/_?(?:skills?|group)$/, '');

function createToolRunner(tools, { timeoutMs = 10000, groups = null, toolIndex = null } = {}) {
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
  const pageText = { ok: false, denied: true, text: "Error: I won't start that from text I read. Ask me directly." };
  // a turn tainted by who is speaking (speaker recognition: unsure or guest) says so; a page or file taint keeps the text above
  const taintedText = ctx => { const r = speakerReason(ctx.turn); return r ? { ok: false, denied: true, text: `Error: ${r}` } : pageText; };

  function specs() {
    return tools.map(({ name, description, params }) => ({ name, description, params }));
  }

  async function exec(tool, name, args, ctx) {
    // a guest turn runs only the allowlisted tools (GUEST_TOOLS)
    const guest = guestRefusal(tool, args, ctx);
    if (guest) return guest;
    // confirm tools only start from the user's own words (see brain/guard.js)
    if (tainted(tool, ctx)) return taintedText(ctx);
    // the arguments must fit the tool's own schema before its code runs ("5" becomes 5; a missing or impossible value is refused, not guessed)
    const flag = tool.untrusted === true ? { untrusted: true } : {};   // only set when true, so results of ordinary tools stay { ok, text }
    const checked = checkArgs(tool, args);
    if (!checked.ok) return note(tool, { ok: false, text: checked.text, badArgs: true, ...flag });
    args = checked.args;
    // after every refusal above, so a denied or badly-formed call never reaches the ledger (owner turns only; see ledger.js)
    const g = ledgerGate(tool, name, args, ctx); if (g.res) return g.res;
    let timer;
    try {
      const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => rej(Object.assign(new Error(`tool ${name} timed out`), { timedOut: true })), tool.timeoutMs || timeoutMs);
      });
      const text = String(await Promise.race([Promise.resolve().then(() => tool.run(args || {}, ctx)), timeout]));
      ledgerRecord(g, ctx, name, args, text, flag.untrusted);
      return note(tool, { ok: true, text, ...flag });
    } catch (err) {
      ledgerTimeout(g, ctx, name, args, err);
      return note(tool, { ok: false, text: `Error: ${err?.message || err}`, ...(err?.timedOut && { timedOut: true }), ...flag });
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
    // offered: once discovery ran, specs() shows only these tools plus the meta tools. Narrowing lives in specs() alone:
    // authorization (scopedRun, exec) never looks at it, so a tool outside it still runs by name under the same checks.
    let offered = null;
    const META = ['find_tools', 'more_skills'];
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
      if (loaded.includes(id)) {
        if (offered) for (const t of g.tools) offered.add(t.name);   // narrowed by discovery: asking for the group shows it whole
        return { ok: true, text: `Already loaded ${g.label}: ${list}.` };
      }
      if (extra >= MAX_EXTRA_LOADS) return { ok: false, text: `Cannot load more skills this turn (limit ${MAX_EXTRA_LOADS}). Answer with what you have.` };
      extra++;
      add(id);
      if (offered) for (const t of g.tools) offered.add(t.name);   // asked for by the model: its tools are shown whole
      return { ok: true, text: `Loaded ${g.label}: ${list}.` };
    }

    // discovery narrows from "everything in the loaded groups" to what was found
    const startOffer = () => { if (!offered) offered = new Set(META); return offered; };
    function offerNames(names, turn, charge) {
      const set = startOffer();
      const out = [];
      for (const n of names) {
        const tool = byName.get(n);
        if (!tool || eligibility(tool, turn || {})) continue;
        const gid = catalog.groupOf(tool.name);
        if (gid && !loaded.includes(gid)) {
          if (charge && extra >= MAX_EXTRA_LOADS - 1) continue;   // auto-offer keeps one unit for the model's own find_tools/more_skills
          if (charge) extra++;
          add(gid);
        }
        set.add(tool.name);
        out.push(tool.name);
      }
      return out;
    }
    const offer = (names, { turn } = {}) => offerNames(names, turn, true);

    // find_tools: one unit of the same per-turn budget as more_skills; candidates come from the global index with the caller's own turn
    async function find(query, ctx = {}) {
      if (!toolIndex) throw new Error('Tool search is not available.');
      if (extra >= MAX_EXTRA_LOADS) throw new Error(`Cannot load more skills this turn (limit ${MAX_EXTRA_LOADS}). Answer with what you have.`);
      extra++;
      const t = ctx.turn || {};
      const r = await toolIndex.find(String(query ?? ''), { groups: null, speaker: t.speaker || 'owner', tainted: !!t.tainted, exclude: offered ? new Set(offered) : new Set() });
      if (r.outcome === 'unavailable') throw new Error('Tool search is busy. Use the tools you have.');
      if (r.outcome === 'none') return 'No tool can do that. Do not invent one; say you cannot.';
      if (r.outcome === 'not_permitted') return 'I am not allowed to do that in this turn.';
      if (!offered) { offered = new Set(META); for (const id of loaded) for (const x of group(id).tools) offered.add(x.name); }
      const names = offerNames(r.tools.map(x => x.name), t, false);   // already paid for above
      return names.map(n => `${n}: ${byName.get(n).summary || firstSentence(byName.get(n).description, 140)}`).join('\n');
    }

    async function scopedRun(name, args, ctx = {}) {
      const tool = byName.get(name);
      if (!tool) {
        const alt = resolveInvented(name, tools, groupList());
        if (alt?.tool) return reroute(await scopedRun(alt.tool, { ...(args || {}), ...alt.args }, ctx), name, alt.tool);
        if (alt?.group) {          // a group's name called as a tool: load the group and say which tools it has
          const r = load(alt.group);
          return r.ok ? { ok: true, groupLoad: true, text: `${name} is a skill group, not a tool. ${r.text} Call one of those tools.` } : r;
        }
        return unknown(name);
      }
      const c = { ...ctx, skills: { ...view, load, loaded: () => [...loaded], find } };
      if (!inScope(tool)) {
        // refuse before loading anything: auto-load never gets around risk, taint or the guest allowlist
        const guest = guestRefusal(tool, args, c);
        if (guest) return guest;
        if (tainted(tool, c)) return taintedText(c);
        const gid = catalog.groupOf(tool.name);
        if (gid) {
          const r = load(gid);
          if (!r.ok) return r;
        }
      }
      return exec(tool, name, args, c);
    }

    return {
      specs: () => loaded.flatMap(id => group(id).tools).filter(t => !offered || offered.has(t.name)).map(({ name, description, params }) => ({ name, description, params })),
      offer,
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
  return { specs, run, turn, resolves, direct, stats: view.stats, get: n => byName.get(n) };   // get: the tool itself, for the round's parallel-safety check
}

module.exports = { createToolRunner, eligibility, MAX_EXTRA_LOADS };
