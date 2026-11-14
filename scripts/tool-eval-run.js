'use strict';
// Runs fixture rows through the REAL orchestrator twice: 'baseline' (intelligence:false, no toolIndex / ledger / workmem: groups are
// offered whole, today's loop) and 'new' (all of Phase 2B). The model is the scripted oracle of test/helpers/oracle-provider.js, so
// this measures the pipeline (discovery, recovery, duplicates, refusals), never the quality of a real LLM.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadGroups, buildCatalog } = require('../src/core/skills');
const { selectGroups } = require('../src/core/skills/select');
const { createToolIndex } = require('../src/core/skills/toolindex');
const { createToolRunner, eligibility } = require('../src/core/tools/registry');
const { createLedger } = require('../src/core/tools/ledger');
const { createWorkMem } = require('../src/core/context/workmem');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { createBus } = require('../src/core/bus');
const { DEFAULTS } = require('../src/core/config');
const { createFakeEmbedder } = require('../src/core/cortex/embedder');
const { NEEDS_OK } = require('../src/core/brain/guard');
const { toolContract } = require('../src/core/skills/toolcards');
const { toolDeps } = require('../test/helpers/tool-deps');
const { makeSynthRegistry } = require('../test/helpers/synth-registry');
const { createOracleProvider } = require('../test/helpers/oracle-provider');

const REPAIR = /You tried to call|Give only its arguments/;
// a string hash per row, so the noise draws of different rows are not correlated by id length
const hash = s => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const names = e => (typeof e === 'string' ? [e] : e.oneOf);
const quant = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]) : 0; };
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const tokens = o => (JSON.stringify(o) || '').length * 1.3 / 4;

let realBase = null;
// the vocabulary seed per set: held-out rows use the second vocabulary, so dev tuning cannot leak into them
function baseGroups(registry, set) {
  if (!realBase) {   // "all services up" like intelligence-eval-model.js: availability is then decided by the row's faults, not the test stubs
    const deps = toolDeps(), cfg = deps.getConfig();
    realBase = loadGroups({ ...deps, fetch: async () => ({ ok: true, json: async () => ({}) }), getConfig: () => ({ ...cfg, browser: { ...(cfg.browser || {}), enabled: true } }), browserLink: { ...deps.browserLink, connected: true } });
  }
  if (registry === 'real') return { groups: realBase, synonyms: {} };
  const n = Number(registry.replace('synth', ''));
  const s = makeSynthRegistry({ n, seed: set === 'heldout' ? 7 : 1, vocab: set === 'heldout' ? 'b' : 'a' });
  return { groups: [realBase.find(g => g.id === 'core'), ...s.groups], synonyms: s.synonyms };
}

// Stub tools: same spec as the original, a run() that follows the row's faults and counts what really ran.
function stubGroups(groups, row, rec, baseline) {
  const f = row.faults || {};
  const seen = {};
  return groups.map(g => ({ ...g, tools: g.tools.filter(t => !(baseline && t.name === 'find_tools')).map(t => {
    if (t.name === 'more_skills' || t.name === 'find_tools') return t;
    const bad = (f[t.name] || []).includes('badargs');
    return { ...t, ...(bad ? { params: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } : {}), ...((f[t.name] || []).includes('timeout') ? { timeoutMs: 40 } : {}),
      async run(args, ctx) {
        const n = (seen[t.name] = (seen[t.name] || 0) + 1), list = f[t.name] || [];
        rec.runs.push({ name: t.name, key: t.name + JSON.stringify(args || {}), risk: t.risk, effect: toolContract(t).effect, fresh: !!ctx?.fresh, tainted: !!ctx?.turn?.tainted, speaker: ctx?.turn?.speaker || 'owner' });
        if (list.includes('unavailable')) throw new Error('the Chrome extension is not connected');
        if (list.includes('transient') && n === 1) throw new Error('ECONNRESET temporary failure');
        if (list.includes('timeout') && n === 1) await new Promise(() => {});
        if (list.includes('wrongpick')) return '';
        if (t.risk === 'confirm') return NEEDS_OK + `Do ${t.name}?`;
        return `${t.name} ok`;
      } };
  }) }));
}

async function runRow(row, mode, o, ctx) {
  const baseline = mode === 'baseline';
  const rec = { runs: [], embeds: 0 };
  const { groups: base, synonyms } = ctx.cache(row.registry);
  const groups = stubGroups(base, row, rec, baseline);
  const catalog = buildCatalog(groups);
  const fake = createFakeEmbedder({ synonyms });
  const embed = o.embedder === 'none' ? null : (t, x) => { rec.embeds++; return fake.embed(t, x); };
  const provider = createOracleProvider({ noise: o.noise, seed: hash(o.seed + ':' + row.id), delayMs: o.modelDelayMs, groupOf: n => catalog.groupOf(n), ids: catalog.ids });
  const providers = createRegistry(); providers.add(NullProvider); providers.add(provider);
  const toolIndex = baseline ? null : createToolIndex({ catalog, embed, embedMs: 250, eligible: eligibility });
  const bus = createBus(), ends = [];
  bus.on('tool', e => { if (e.phase === 'end') ends.push(e); });
  const orc = createOrchestrator({
    bus, sessions: ctx.sessions, providers, tools: createToolRunner(groups.flatMap(g => g.tools), { groups, ...(toolIndex ? { toolIndex } : {}) }), catalog,
    ...(baseline ? { intelligence: false } : { toolIndex, ledger: createLedger({}), workmem: createWorkMem() }),
    getConfig: () => ({ ...DEFAULTS, provider: 'oracle' }), selectGroups: (t, x) => selectGroups(t, x, catalog),
    route: () => ({ tier: 'deep', think: false, tools: true, steps: Math.min(3, (row.want.tools || []).length || 1), reason: 'eval' }),
  });
  const s = ctx.sessions.create(); ctx.sessions.save(s);
  const as = (r, speaker) => { provider.state.row = r; return orc.send(s.id, r.text, speaker ? { speaker } : {}); };
  for (const h of row.history || []) { await as({ text: h.text, want: { tools: h.tools, order: 'seq', outcome: 'done' }, faults: {} }); }
  const before = { calls: provider.calls.length, con: provider.constrained.length, runs: rec.runs.length, ends: ends.length, emb: rec.embeds };
  const t0 = performance.now();
  const res = await as(row, row.speaker);
  const ms = performance.now() - t0;
  const runs = rec.runs.slice(before.runs), chats = provider.calls.slice(before.calls), cons = provider.constrained.slice(before.con);
  const sess = ctx.sessions.load(s.id), last = sess.messages.at(-1);
  const extra = cons.filter(q => !REPAIR.test(q.messages.at(-1)?.content || '')).length;
  const w = row.want, allowed = new Set((w.tools || []).flatMap(names));
  // verify reads (ctx.fresh) are the loop's own checks of a write, not the model's choices: they do not count as unnecessary
  const real = runs.filter(r => !r.fresh);
  // a duplicate write: the same non-read call executed again, in this turn or after an earlier turn of the session
  let dupes = 0;
  rec.runs.forEach((r, i) => { if (i >= before.runs && r.effect !== 'read' && rec.runs.slice(0, i).some(x => x.key === r.key)) dupes++; });
  const unnecessary = real.filter(r => !allowed.has(r.name)).length + dupes;
  const wanted = (w.tools || []);
  const permanent = new Set(Object.keys(row.faults || {}).filter(n => row.faults[n].includes('unavailable')));
  // the ledger answering "Already done" is a completed task too: the write ran in an earlier turn
  const turnMsgs = sess.messages.slice(sess.messages.map(m => m.role).lastIndexOf('user') + 1);
  const ledgered = new Set(turnMsgs.filter(m => m.role === 'tool' && /^Already done/i.test(String(m.content))).map(m => m.name));
  const offeredEver = new Set(chats.flatMap(c => (c.tools || []).map(t => t.name)));
  // a wanted tool counts as selected when it was on offer in some round of the turn and then really ran (a repaired call counts)
  const hit = e => names(e).some(n => offeredEver.has(n) && (runs.some(r => r.name === n) || ledgered.has(n)));
  const selectable = wanted.length && ['done', 'ask'].includes(w.outcome);
  const reply = String(res.reply || '');
  const ranOk = e => names(e).some(n => runs.some(r => r.name === n) || ledgered.has(n));
  let met;
  if (w.outcome === 'decline') met = !runs.some(r => !['get_time'].includes(r.name)) && /cannot|can't|don't have|not able/i.test(reply);
  else if (w.outcome === 'ask') met = !!last?.pending && wanted.every(ranOk);
  else if (w.outcome === 'not_permitted') met = !runs.some(r => r.risk === 'confirm') && /could not|not allowed|only do that|cannot|can't|not permitted|my owner/i.test(reply);
  else met = wanted.filter(e => !names(e).some(n => permanent.has(n))).every(ranOk) && (!permanent.size || /could not|couldn.t|not connected|unavailable/i.test(reply));
  const ok = met && !(w.mustNot || []).some(n => runs.some(r => r.name === n));
  const ev = ends.slice(before.ends);
  return {
    id: row.id, cat: row.cat, registry: row.registry, ok, selected: selectable ? wanted.every(hit) : null, unnecessary, dupes,
    failures: ev.filter(e => e.ok === false && !e.skipped).length, ms, chats: chats.length, extra, repairs: cons.length - extra,
    embeds: rec.embeds - before.emb, specTokens: chats.map(c => tokens(c.tools || [])), promptTokens: chats.reduce((a, c) => a + tokens(c.messages) + tokens(c.tools || []), 0),
    unsafe: runs.filter(r => r.risk === 'confirm' && (r.tainted || r.speaker !== 'owner')).length, reply: reply.slice(0, 80), offered: chats.map(c => (c.tools || []).map(t => t.name)), ran: runs.map(r => r.name),
  };
}

function metrics(rows) {
  const sel = rows.filter(r => r.selected !== null), sp = rows.flatMap(r => r.specTokens);
  const ns = rows.filter(r => !r.simple);
  return {
    rows: rows.length, selectionAccuracy: sel.length ? sel.filter(r => r.selected).length / sel.length : 1, completion: rows.filter(r => r.ok).length / (rows.length || 1),
    unnecessaryCalls: rows.reduce((a, r) => a + r.unnecessary, 0), dupWrites: rows.reduce((a, r) => a + r.dupes, 0), executionFailures: rows.reduce((a, r) => a + r.failures, 0),
    latencyMs: { p50: quant(rows.map(r => r.ms), 0.5), p95: quant(rows.map(r => r.ms), 0.95) },
    modelCalls: mean(rows.map(r => r.chats + r.repairs + r.extra)), extraCallsMax: Math.max(0, ...ns.map(r => r.extra)),
    specTokens: Math.round(mean(sp)), promptTokens: Math.round(mean(rows.map(r => r.promptTokens))), unsafeExecs: rows.reduce((a, r) => a + r.unsafe, 0),
  };
}

async function runSet({ rows, mode = 'new', modelDelayMs = 30, noise = 0, seed = 1, embedder = 'fake', set = 'v1' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-eval-'));
  const caches = new Map();
  const ctx = { sessions: createSessionStore(dir), cache: reg => { if (!caches.has(reg)) caches.set(reg, baseGroups(reg, set)); return caches.get(reg); } };
  const out = [];
  try { for (const row of rows) out.push({ ...(await runRow(row, mode, { modelDelayMs, noise, seed, embedder }, ctx)), simple: !!row.simple }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return { rows: out, metrics: metrics(out) };
}

module.exports = { runSet, metrics, baseGroups };
