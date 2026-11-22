// Model mode for scripts/intelligence-eval.js (--model fake|ollama): each row goes through the REAL Phase 2 pipeline
// (selectGroups -> gate -> cards -> interpret -> merge in skills/discover.js resolveSelection) as the owner.
//   fake   = a deterministic stand-in "oracle" that answers the way a perfect reader of the row's label would, plus a
//            seeded share of wrong / malformed / failing answers (--noise, default 0.15). It measures the pipeline: gating,
//            validation, merge and fallbacks. It says NOTHING about how well a real local model reads requests.
//   ollama = the real local provider (config DEFAULTS.ollama); skipped with a message when Ollama is not reachable.
// Simple commands (cat 'direct' rows whose rule match is high: the Global Constraints' no-call case) must stay model-free and as fast as
// the old rule layer: the run fails (exit 1) when one calls the model or its rule-path p95 is more than 1 ms over the old path's p95,
// measured in the same run. Direct rows with a weaker rule match are listed (they may call the model by design: gate opens on medium).
const { loadGroups, buildCatalog } = require('../src/core/skills');
const { selectGroups } = require('../src/core/skills/select');
const { clarify } = require('../src/core/skills/clarify');
const { resolveSelection } = require('../src/core/skills/discover');
const { toolDeps } = require('../test/helpers/tool-deps');
const { createFakeProvider } = require('../test/helpers/fake-provider');

const PASSIVE = new Set(['core', 'knowledge']);
const SIMPLE = 'direct';
const NOISE = ['malformed', 'invented', 'wrong-group', 'throw', 'hang'];
const LATENCY_SLACK_MS = 1;
const isSimple = (row, catalog) => row.cat === SIMPLE && selectGroups(row.text, { lastGroups: row.lastGroups || [] }, catalog).confidence === 'high';

// mulberry32: tiny seeded PRNG so a noisy run is repeatable
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// "All services up" environment (sysmon answers, browser extension connected): availability is then decided per row by
// its optional `down` list, so an unavailable-capability row can test the honest card decline.
function modelCatalog() {
  const deps = toolDeps();
  const cfg = deps.getConfig();
  return buildCatalog(loadGroups({ ...deps, fetch: async () => ({ ok: true, json: async () => ({}) }), getConfig: () => ({ ...cfg, browser: { ...(cfg.browser || {}), enabled: true } }), browserLink: { ...deps.browserLink, connected: true } }));
}

function withDown(catalog, down) {
  if (!down?.length) return catalog;
  return { ...catalog, cardsNow: async () => (await catalog.cardsNow()).map(c => (down.includes(c.id) ? { ...c, available: false, missingReason: 'not running right now' } : c)) };
}

// What a model that understood the row would answer, in the intent schema. Built from the label only.
function oracleAnswer(row, ids) {
  const e = row.expect;
  const cont = (row.lastGroups || []).length > 0;
  const kind = /^\W*(?:actually|no[,.]?\s|not that|i meant|wrong)/i.test(row.text) ? 'correction' : cont ? 'followup' : 'new';
  if (row.down?.length) return { kind, groups: row.down.slice(0, 3), confidence: 0.9, reasoning: 'needs a capability that is down' };
  if (e === 'ask' || e === 'model') return { kind, groups: [], confidence: 0.3, ask: 'What exactly would you like me to do?', missing: ['target'] };
  if (e === 'decline') return { kind: 'new', groups: [], confidence: 0.9, decline: "I don't have a tool for that." };
  if (e === 'answer') return { kind: 'chat', groups: [], confidence: 0.9, reasoning: 'talk, not an order' };
  return { kind, groups: e.act.filter(g => ids.includes(g)).slice(0, 3), confidence: 0.9 };
}

function noisy(type, r, ids, row) {
  if (type === 'malformed') return [null, 'groups: media', { foo: 1 }, []][Math.floor(r() * 4)];
  if (type === 'invented') return { kind: 'new', groups: ['smart_home', 'core'], confidence: 0.95 };
  if (type === 'wrong-group') {
    const want = typeof row.expect === 'object' ? row.expect.act : [];
    const pool = ids.filter(id => !want.includes(id));
    return { kind: 'new', groups: [pool[Math.floor(r() * pool.length)]], confidence: 0.9 };
  }
  if (type === 'throw') throw new Error('oracle noise: provider failed');
  return new Promise(() => {});   // hang: the interpreter budget must cut it
}

function fakeProvider({ noise, seed }) {
  const r = rng(seed);
  const state = { row: null, ids: [], noiseHits: 0 };
  const provider = createFakeProvider([{ type: 'done' }], {
    constrain: async () => {
      if (noise > 0 && r() < noise) { state.noiseHits++; return noisy(NOISE[Math.floor(r() * NOISE.length)], r, state.ids, state.row); }
      return oracleAnswer(state.row, state.ids);
    },
  });
  return { provider, state };
}

async function ollamaProvider() {
  const { createOllamaProvider } = require('../src/core/providers/ollama');
  const { DEFAULTS } = require('../src/core/config');
  const host = DEFAULTS.ollama.host;
  try { const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(1500) }); if (!res.ok) throw new Error(`HTTP ${res.status}`); } catch (err) {
    return { skip: `ollama not reachable at ${host} (${err.message}); model=ollama skipped, nothing measured` };
  }
  return { provider: createOllamaProvider({ getConfig: () => DEFAULTS }), state: { row: null, ids: [], noiseHits: 0 } };
}

function judgeResult(row, res, catalog) {
  const e = row.expect;
  const acting = res.action === 'act' ? res.groups.filter(g => !PASSIVE.has(g)) : [];
  let ok;
  if (e === 'ask' || e === 'decline') ok = res.action === e;
  else if (e === 'answer') ok = res.action === 'act' && acting.length === 0;
  else if (e === 'model') ok = res.action === 'ask' || (res.action === 'act' && acting.length === 0);   // asked, or loaded nothing by guess
  else ok = res.action === 'act' && e.act.every(g => res.groups.includes(g));
  if (ok && row.mustNotAct) ok = acting.length === 0;
  if (ok && row.confirmTool) { const t = catalog.tools.find(x => x.name === row.confirmTool); ok = !!t && t.risk === 'confirm'; }
  const falseAction = !ok && typeof e === 'string' && acting.length > 0;
  return { ok, got: res.action === 'act' ? res.groups.join('+') : res.action, falseAction };
}

const pct = (a, n) => (n ? Math.round(a / n * 1000) / 10 : 0);
const quant = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 1000) / 1000 : 0; };

// p50/p95 of the old rule layer (selectGroups + clarify) vs the new rule path (resolveSelection, gate closed) per simple row
async function latency(rows, ruleCatalog, catalog, provider, reps = 200) {
  const before = [], after = [];
  const ns = () => process.hrtime.bigint();
  for (let i = 0; i < 20; i++) for (const row of rows) { selectGroups(row.text, { lastGroups: [] }, ruleCatalog); await resolveSelection({ text: row.text, catalog, provider, owner: true }); }
  for (let i = 0; i < reps; i++) {
    for (const row of rows) {
      const lg = row.lastGroups || [];
      let t = ns(); const p = selectGroups(row.text, { lastGroups: lg, source: 'text' }, ruleCatalog); clarify(row.text, { lastGroups: lg, picked: p, catalog: ruleCatalog }); before.push(Number(ns() - t) / 1e6);
      t = ns(); await resolveSelection({ text: row.text, lastGroups: lg, catalog, provider, owner: true }); after.push(Number(ns() - t) / 1e6);
    }
  }
  return { before: { p50: quant(before, 0.5), p95: quant(before, 0.95) }, after: { p50: quant(after, 0.5), p95: quant(after, 0.95) } };
}

async function runModel({ set, rows, mode, noise = 0.15, seed = 1, budgetMs, judge, ruleCatalog, baseline }) {
  const got = mode === 'fake' ? fakeProvider({ noise, seed }) : await ollamaProvider();
  if (got.skip) return { skip: got.skip };
  const { provider, state } = got;
  const catalog = modelCatalog();
  const budget = budgetMs || (mode === 'fake' ? 100 : 4000);
  const by = {}, misses = [], statuses = {};
  let calls = 0, ruleFalse = 0, modelFalse = 0, mnaRegressions = 0, simpleCalls = 0;
  const directCalls = [];
  for (const row of rows) {
    const rule = judge(row);
    state.row = row; state.ids = catalog.ids.filter(id => id !== 'core');
    const n0 = calls;
    const res = await resolveSelection({ text: row.text, lastGroups: row.lastGroups || [], catalog: withDown(catalog, row.down), provider: countCalls(provider, () => calls++), owner: true, budgetMs: budget });
    const called = calls > n0;
    const simple = isSimple(row, ruleCatalog);
    if (called && simple) simpleCalls++;
    if (called && row.cat === SIMPLE && !simple) directCalls.push(row.id);
    const m = judgeResult(row, res, catalog);
    const b = (by[row.cat] ||= { n: 0, rule: 0, model: 0, called: 0 });
    b.n++; if (rule.ok) b.rule++; if (m.ok) b.model++; if (called) b.called++;
    if (rule.falseAction) ruleFalse++;
    if (m.falseAction) modelFalse++;
    if (row.mustNotAct && rule.ok && !m.ok) mnaRegressions++;
    statuses[res.decision.status] = (statuses[res.decision.status] || 0) + 1;
    if (!m.ok) misses.push({ id: row.id, text: row.text, want: row.expect, got: m.got, why: res.decision.why, status: res.decision.status });
  }
  const simpleRows = rows.filter(r => isSimple(r, ruleCatalog));
  // timing loop: a counting provider that is never meant to be reached (any call there is a simple-command model call too)
  const lat = simpleRows.length ? await latency(simpleRows, ruleCatalog, catalog, countCalls(provider, () => simpleCalls++)) : null;
  const n = rows.length;
  const ruleOk = Object.values(by).reduce((a, x) => a + x.rule, 0), modelOk = Object.values(by).reduce((a, x) => a + x.model, 0);
  const latencyOk = !lat || lat.after.p95 <= lat.before.p95 + LATENCY_SLACK_MS;
  const out = {
    version: set.version, mode, noise: mode === 'fake' ? noise : null, seed: mode === 'fake' ? seed : null,
    note: mode === 'fake' ? 'fake = deterministic oracle built from the row labels: measures pipeline/gating/merge logic, not real LLM quality' : 'real local model',
    total: n, rule: { passed: ruleOk, accuracy: pct(ruleOk, n), falseActions: ruleFalse }, model: { passed: modelOk, accuracy: pct(modelOk, n), falseActions: modelFalse },
    delta: Math.round((pct(modelOk, n) - pct(ruleOk, n)) * 10) / 10,
    baseline: baseline ? { accuracy: baseline.accuracy, delta: Math.round((pct(modelOk, n) - baseline.accuracy) * 10) / 10 } : null,
    modelCalls: calls, gateRate: pct(Object.values(by).reduce((a, x) => a + x.called, 0), n), statuses, noiseHits: state.noiseHits,
    mustNotActRegressions: mnaRegressions, simple: { rows: simpleRows.length, modelCalls: simpleCalls, directMediumCalls: directCalls, latencyMs: lat, slackMs: LATENCY_SLACK_MS, ok: simpleCalls === 0 && latencyOk },
    byCategory: by, misses,
  };
  return { out, code: out.simple.ok ? 0 : 1 };
}

// a real provider has no call log: count constrain calls on a thin wrapper
function countCalls(provider, inc) {
  return { ...provider, constrain: (...a) => { inc(); return provider.constrain(...a); } };
}

function print(out, baseline) {
  const L = [];
  L.push(`intelligence eval v${out.version}, model=${out.mode}${out.mode === 'fake' ? ` (noise ${out.noise}, seed ${out.seed})` : ''}`);
  L.push(`  NOTE: ${out.note}`);
  L.push(`  overall: rule-only ${out.rule.accuracy}% (${out.rule.passed}/${out.total}) -> rule+model ${out.model.accuracy}% (${out.model.passed}/${out.total}), delta ${out.delta >= 0 ? '+' : ''}${out.delta} pts${out.baseline ? `; vs baseline json ${out.baseline.accuracy}%: ${out.baseline.delta >= 0 ? '+' : ''}${out.baseline.delta} pts` : ''}`);
  L.push(`  model called on ${Object.values(out.byCategory).reduce((a, x) => a + x.called, 0)}/${out.total} rows (gate rate ${out.gateRate}%), ${out.modelCalls} calls, noise hits ${out.noiseHits}, statuses ${JSON.stringify(out.statuses)}`);
  L.push(`  false actions: rule-only ${out.rule.falseActions} -> rule+model ${out.model.falseActions}; must-not-act regressions ${out.mustNotActRegressions}`);
  L.push(`  ${'category'.padEnd(22)} ${'base'.padStart(5)} ${'rule'.padStart(5)} ${'model'.padStart(5)} ${'delta'.padStart(6)} called`);
  for (const [k, v] of Object.entries(out.byCategory)) {
    const b = baseline?.byCategory?.[k];
    L.push(`  ${k.padEnd(22)} ${(b ? `${b.ok}/${b.n}` : '-').padStart(5)} ${`${v.rule}/${v.n}`.padStart(5)} ${`${v.model}/${v.n}`.padStart(5)} ${`${v.model - v.rule >= 0 ? '+' : ''}${v.model - v.rule}`.padStart(6)} ${v.called}`);
  }
  const s = out.simple, l = s.latencyMs;
  L.push(`  simple commands (${s.rows} '${SIMPLE}' rows with a high rule match): model calls ${s.modelCalls}; rule path p50/p95 before ${l ? `${l.before.p50}/${l.before.p95}` : '-'} ms, after ${l ? `${l.after.p50}/${l.after.p95}` : '-'} ms (limit p95 <= before + ${s.slackMs} ms): ${s.ok ? 'PASS' : 'FAIL'}`);
  if (s.directMediumCalls.length) L.push(`  direct rows with a medium rule match that called the model (gate opens on medium): ${s.directMediumCalls.join(', ')}`);
  for (const m of out.misses) L.push(`  miss ${m.id}: "${m.text}" wanted ${JSON.stringify(m.want)} got ${m.got} [${m.status}; ${m.why}]`);
  return L.join('\n');
}

module.exports = { runModel, print, oracleAnswer, judgeResult, SIMPLE };
