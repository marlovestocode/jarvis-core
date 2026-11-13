// Offline benchmark of how JARVIS decides what a request needs (no model, no GPU). Cases: test/fixtures/orchestration-cases.json.
//   node scripts/orchestration-bench.js          scores + every miss
//   node scripts/orchestration-bench.js --json   one JSON line (to diff before/after)
// Sections: route (tier / tools / thinking per request), instant (answered with no model call), ask (asks before acting on a
// request that lacks what it needs), context (a short follow-up keeps the skill area of the turn before), models (which installed
// Ollama model serves a turn), runtime (scripted failures through the real orchestrator: what runs, how many model calls).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cases = require('../test/fixtures/orchestration-cases.json');
const { route } = require('../src/core/brain/router');
const { clarify } = require('../src/core/skills/clarify');
const { loadGroups, buildCatalog } = require('../src/core/skills');
const { selectGroups } = require('../src/core/skills/select');
const { toolDeps } = require('../test/helpers/tool-deps');

const miss = [];
const sec = {};
const score = (name, ok, label, detail) => { const s = (sec[name] ||= { n: 0, ok: 0 }); s.n++; if (ok) s.ok++; else miss.push(`[${name}] ${label}${detail ? ' -> ' + detail : ''}`); };

// route
let over = 0, under = 0;
for (const c of cases.route) {
  const r = route(c.text, { source: c.source || 'text' });
  const got = { tier: r.tier, tools: r.tools !== false, think: !!r.think };
  if (got.think && !c.think) over++;
  if (!got.think && c.think) under++;
  score('route', got.tier === c.tier && got.tools === c.tools && got.think === c.think, `"${c.text.slice(0, 60)}"${c.source === 'voice' ? ' (voice)' : ''}`, JSON.stringify(got));
}

// instant
let instant = null;
try { instant = require('../src/core/brain/instant').instant; } catch { /* not there before the change */ }
for (const c of cases.instant) {
  let r = null;
  try { r = instant ? instant(c.text, { now: new Date(2026, 10, 12, 15, 42) }) : null; } catch { r = null; }
  score('instant', !!r === c.instant, `"${c.text}"`, r ? `answered: ${r.reply}` : 'goes to the model');
}

// live instant: argument-free read-only tools answered without the model choosing or phrasing
const { liveIntent } = require('../src/core/brain/instant-live');
for (const c of cases.live) { const r = liveIntent(c.text); score('live', (r?.tool || null) === c.tool, `"${c.text}"`, r ? r.tool : 'goes to the model'); }

// ask
for (const c of cases.ask) {
  const r = clarify(c.text, { lastGroups: [] });
  score('ask', c.outcome === 'ask' ? r?.kind === 'ask' : !r, `"${c.text}"`, r ? `${r.kind}: ${r.reply}` : 'no question');
}

// context
const catalog = buildCatalog(loadGroups(toolDeps()));
const sel = (text, lastGroups = []) => selectGroups(text, { lastGroups, source: 'text' }, catalog);
const real = ids => ids.filter(id => id !== 'core' && id !== 'knowledge');
for (const c of cases.context) {
  const prev = real(sel(c.prev));
  const got = sel(c.text, prev);
  const kept = prev.length > 0 && prev.some(id => got.includes(id));
  score('context', c.carry ? kept : !kept, `"${c.prev}" -> "${c.text}"`, `prev ${prev.join('+') || '-'}, got ${got.join('+')}`);
}

// tool pick: is the right tool among the top 3 the ranker offers first, inside the groups the selector loaded?
// "learned" repeats it after the ranker has seen the requests that worked in the default set (what a long-running JARVIS accumulates),
// scored on the two sets it never saw.
const { createRanker } = require('../src/core/skills/rank');
const toolSets = ['skill-requests', 'skill-requests-heldout', 'skill-requests-fresh'].map(n => ({ n, rows: require('../test/fixtures/' + n + '.json').filter(r => r.tool) }));
let top1 = 0, top1n = 0;
function pickScore(section, rk, rows, label) {
  for (const r of rows) {
    const g = sel(r.text);
    const only = new Set(catalog.groups.filter(x => g.includes(x.id)).flatMap(x => x.tools.map(t => t.name)));
    const order = rk.rank(r.text, { only }).map(a => a.name);
    const at = order.indexOf(r.tool);
    if (section === 'tool') { top1n++; if (at === 0) top1++; }
    score(section, at >= 0 && at < 3, `${label} "${r.text}"`, `wanted ${r.tool}, got ${order.slice(0, 3).join(',') || '-'}`);
  }
}
const plain = createRanker(catalog.tools);
for (const t of toolSets) pickScore('tool', plain, t.rows, t.n);
const taught = createRanker(catalog.tools);
for (const r of toolSets[0].rows) taught.learn(r.text, r.tool);
for (const t of toolSets.slice(1)) pickScore('tool-learned', taught, t.rows, t.n);

// models
async function models() {
  const { createOllamaProvider } = require('../src/core/providers/ollama');
  const inst = cases.models.installed;
  const tags = { models: inst.map(m => ({ name: m.name, model: m.name, details: { parameter_size: m.size }, capabilities: m.caps, ...(m.remote ? { remote_model: 'x', remote_host: 'y' } : {}) })) };
  for (const c of cases.models.cases) {
    const fetch = async url => {
      if (String(url).endsWith('/api/ps')) { if (!c.loaded) throw new Error('no ps'); return { ok: true, status: 200, json: async () => ({ models: c.loaded.map(name => ({ name })) }) }; }
      return { ok: true, status: 200, json: async () => (String(url).endsWith('/api/tags') ? tags : {}) };
    };
    const p = createOllamaProvider({ getConfig: () => ({ ollama: { host: 'http://127.0.0.1:11434', auto: true, think: false, ...c.cfg } }), fetch });
    try { await p.status(); } catch { /* a missing main model is part of some cases */ }   // fills what the provider knows about the installed models
    let got;
    try { got = p.resolveModel(c.hints); } catch (err) { got = 'ERR ' + err.message; }
    const ok = c.want ? c.want.includes(got) : !c.wantNot.includes(got);
    score('models', ok, c.id, got);
  }
}

// runtime: scripted failures through the real orchestrator
async function runtime() {
  const { createBus } = require('../src/core/bus');
  const { createSessionStore } = require('../src/core/session');
  const { createRegistry } = require('../src/core/providers/provider');
  const { NullProvider } = require('../src/core/providers/null-provider');
  const { createToolRunner } = require('../src/core/tools/registry');
  const { DEFAULTS } = require('../src/core/config');
  const { createOrchestrator } = require('../src/core/orchestrator');
  const { createFakeProvider } = require('../test/helpers/fake-provider');
  async function play(script, toolDefs, text = 'do the thing please') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-bench-'));
    const bus = createBus();
    const fp = createFakeProvider(script);
    const providers = createRegistry(); providers.add(NullProvider); providers.add(fp);
    const orc = createOrchestrator({ bus, sessions: createSessionStore(dir), providers, tools: createToolRunner(toolDefs), getConfig: () => ({ ...DEFAULTS, provider: 'fake' }), maxToolRounds: 5 });
    const res = await orc.send(null, text, { source: 'text' });
    fs.rmSync(dir, { recursive: true, force: true });
    return { res, fp };
  }
  const call = (name, args) => ({ type: 'tool_call', id: 'c', name, args });
  const rt = (label, ok, detail) => score('runtime', ok, label, detail);
  // 1. a tool that keeps failing: the model tries it with new arguments each round
  let ran = 0;
  const flaky = { name: 'flaky', description: 'x', params: { type: 'object', properties: { n: { type: 'number' } } }, async run() { ran++; throw new Error('backend is down'); } };
  const fail = Array.from({ length: 4 }, (_, i) => [call('flaky', { n: i }), { type: 'done' }]).concat([[{ type: 'token', text: 'It failed.' }, { type: 'done' }]]);
  let r = await play(fail, [flaky]);
  rt('a tool that failed twice is not run again this turn', ran <= 2, `ran ${ran}x, ${r.fp.calls.length} model calls`);
  const sawGone = r.fp.calls.slice(2).every(c => !c.tools || !c.tools.some(t => t.name === 'flaky'));
  rt('...and is no longer offered to the model', sawGone, 'still offered');
  // 2. the model call itself fails once (a crash, an HTTP 500): one retry beats an error
  r = await play([[{ type: 'throw', message: 'Ollama HTTP 500' }], [{ type: 'token', text: 'Back.' }, { type: 'done' }]], []);
  rt('a failed model call is retried once before giving up', r.res.reply === 'Back.' && !r.res.error, `reply "${r.res.reply}" error ${r.res.error || '-'}`);
  // 3. the model never stops asking for tools
  const echo = { name: 'echo', description: 'x', params: { type: 'object', properties: { n: { type: 'number' } } }, async run(a) { return 'ok ' + a.n; } };
  const loop = Array.from({ length: 6 }, (_, i) => [call('echo', { n: i }), { type: 'done' }]).concat([[{ type: 'token', text: 'Here is what I have.' }, { type: 'done' }]]);
  r = await play(loop, [echo]);
  rt('hitting the tool-round limit still ends in an answer', !r.res.error && !!r.res.reply, `reply "${r.res.reply}" error ${r.res.error || '-'}`);
}

(async () => {
  await models();
  await runtime();
  const total = Object.values(sec).reduce((a, b) => a + b.n, 0), ok = Object.values(sec).reduce((a, b) => a + b.ok, 0);
  const accuracy = Math.round(ok / total * 1000) / 10;
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ accuracy, sections: sec, overthink: over, underthink: under, toolTop1: top1 + '/' + top1n })); return; }
  console.log(`orchestration accuracy: ${accuracy}% (${ok}/${total})`);
  for (const [k, v] of Object.entries(sec)) console.log(`  ${k.padEnd(8)} ${v.ok}/${v.n}`);
  console.log(`  thinking: over ${over}, under ${under}; tool top-1 ${top1}/${top1n}`);
  for (const m of miss) console.log('  miss ' + m);
})();
