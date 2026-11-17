// The sandbox strategy file (vault D28, CL-0071): ONE editable JSON file, `stockman.strategy.json` in the data folder, checked against a
// schema and hot-reloaded when it changes. A bad edit is refused loudly (the error is kept and shown) and the LAST GOOD version keeps running.
// The file can never switch trading on: the three switches (online.broker, broker.enabled, sandbox.enabled) live elsewhere and the schema has no
// key for them (an unknown key is an error). Every version is identified by a short hash of its canonical JSON; the build id is `sbx-<hash>`.
// SANDBOX, USER-EDITED, NOT EVIDENCE OF AN EDGE: the weekly momentum and reversal tuning found no edge (CL-0047, CL-0057) and the preset below
// is unproven. Nothing here feeds calibration, the shadow log or the holdout.
const fs = require('node:fs');
const crypto = require('node:crypto');

const PRESET = Object.freeze({
  version: 1,
  name: 'preset: 12-1 momentum + trend + low volatility (UNPROVEN)',
  note: 'Sandbox, user-edited, not evidence of an edge. Edit this file; a bad edit is refused and the last good version keeps running.',
  universe: { index: 'both', minPrice: 10, minAvgDollarVolume: 20000000, minVolPct: 0.3, excludeEarningsDays: 3 },
  signals: {
    momentum: { enabled: true, weight: 0.6, lookback: 252, skip: 21, volScale: true },
    reversal: { enabled: false, weight: 0, lookback: 5, volScale: true },
    trend: { enabled: true, weight: 0.2, days: 200 },
    lowVol: { enabled: true, weight: 0.2, days: 60 },
  },
  regime: { enabled: true, days: 200, below: 'halfSize' },
  portfolio: { topN: 15, weighting: 'invVol', volFloorPct: 0.5, rebalance: 'monthly:first' },
  exits: { timeExitSessions: 21, stopLossPct: null, takeProfitPct: null, trailingPct: null },
  risk: { capitalUsd: 10000, maxPositionPct: 8, maxGrossPct: 100, maxPositions: 20, maxOrderNotionalUsd: 1000, maxOrdersPerDay: 40, dailyLossKillPct: 3 },
  execution: { order: 'day', limitBps: 5, dryRun: true },
  tuning: { enabled: false, minImprovement: 0.0005, params: {
    'signals.momentum.lookback': { min: 126, max: 252, step: 63 },
    'portfolio.topN': { min: 10, max: 25, step: 5 },
    'regime.days': { min: 100, max: 200, step: 50 },
  } },
});

const DOWS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const nullableNum = (v, lo, hi) => v === null || num(v, lo, hi);

// section → key → [check, description]
const RULES = {
  universe: { index: [v => ['both', 'sp500', 'ndx100'].includes(v), 'both, sp500 or ndx100'], minPrice: [v => num(v, 1, 100000), 'dollars, 1 to 100000'], minAvgDollarVolume: [v => num(v, 0, 1e12), 'dollars of average daily volume, 0 to 1e12'], minVolPct: [v => num(v, 0, 20), 'a percent of daily volatility over 60 sessions, 0 to 20 (leaves out names that barely move, such as a pending deal)'], excludeEarningsDays: [v => int(v, 0, 30), 'whole days, 0 to 30'] },
  regime: { enabled: [v => typeof v === 'boolean', 'true or false'], days: [v => int(v, 20, 400), 'sessions, 20 to 400'], below: [v => ['cash', 'halfSize'].includes(v), 'cash or halfSize'] },
  portfolio: { topN: [v => int(v, 1, 100), 'a whole number, 1 to 100'], weighting: [v => ['equal', 'invVol'].includes(v), 'equal or invVol'], volFloorPct: [v => num(v, 0.01, 20), 'a percent a day: invVol never weights with a volatility below this'], rebalance: [v => v === 'daily' || (typeof v === 'string' && (/^weekly:(mon|tue|wed|thu|fri)$/.test(v) || /^monthly:(first|last)$/.test(v))), 'daily, weekly:<mon..fri> or monthly:<first|last>'] },
  exits: { timeExitSessions: [v => int(v, 1, 252), 'sessions, 1 to 252'], stopLossPct: [v => nullableNum(v, 0.5, 90), 'null or a percent, 0.5 to 90'], takeProfitPct: [v => nullableNum(v, 0.5, 1000), 'null or a percent, 0.5 to 1000'], trailingPct: [v => nullableNum(v, 0.5, 90), 'null or a percent, 0.5 to 90'] },
  risk: { capitalUsd: [v => num(v, 100, 1e7), 'dollars, 100 to 1e7'], maxPositionPct: [v => num(v, 0.5, 100), 'percent of capital, 0.5 to 100'], maxGrossPct: [v => num(v, 1, 200), 'percent, 1 to 200'], maxPositions: [v => int(v, 1, 200), 'a whole number, 1 to 200'], maxOrderNotionalUsd: [v => num(v, 1, 100000), 'dollars, 1 to 100000'], maxOrdersPerDay: [v => int(v, 1, 500), 'a whole number, 1 to 500'], dailyLossKillPct: [v => num(v, 0.1, 50), 'percent, 0.1 to 50'] },
  execution: { order: [v => ['day', 'opg', 'limit'].includes(v), 'day, opg or limit'], limitBps: [v => num(v, 0, 200), 'basis points, 0 to 200'], dryRun: [v => typeof v === 'boolean', 'true or false'] },
};
const SIGNAL_RULES = {
  momentum: { enabled: [v => typeof v === 'boolean', 'true or false'], weight: [v => num(v, 0, 10), 'a weight, 0 to 10'], lookback: [v => int(v, 5, 400), 'sessions, 5 to 400'], skip: [v => int(v, 0, 100), 'sessions, 0 to 100'], volScale: [v => typeof v === 'boolean', 'true or false'] },
  reversal: { enabled: [v => typeof v === 'boolean', 'true or false'], weight: [v => num(v, 0, 10), 'a weight, 0 to 10'], lookback: [v => int(v, 1, 60), 'sessions, 1 to 60'], volScale: [v => typeof v === 'boolean', 'true or false'] },
  trend: { enabled: [v => typeof v === 'boolean', 'true or false'], weight: [v => num(v, 0, 10), 'a weight, 0 to 10'], days: [v => int(v, 5, 400), 'sessions, 5 to 400'] },
  lowVol: { enabled: [v => typeof v === 'boolean', 'true or false'], weight: [v => num(v, 0, 10), 'a weight, 0 to 10'], days: [v => int(v, 10, 252), 'sessions, 10 to 252'] },
};

const clone = o => JSON.parse(JSON.stringify(o));
const canonical = v => (Array.isArray(v) ? v.map(canonical) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v);
const hashOf = strategy => crypto.createHash('sha256').update(JSON.stringify(canonical(strategy))).digest('hex').slice(0, 8);
const buildIdOf = strategy => `sbx-${hashOf(strategy)}`;

const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function setPath(o, p, v) { const ks = p.split('.'); let a = o; for (const k of ks.slice(0, -1)) a = a[k]; a[ks.at(-1)] = v; return o; }

// raw parsed JSON → { ok, errors: [string], value } with omitted keys filled from the preset. Unknown keys are errors (a typo must not be ignored).
function normalize(raw) {
  const errors = [];
  if (!isObj(raw)) return { ok: false, errors: ['the file must hold one JSON object'], value: null };
  const out = clone(PRESET);
  const known = new Set(['version', 'name', 'note', 'universe', 'signals', 'regime', 'portfolio', 'exits', 'risk', 'execution', 'tuning']);
  for (const k of Object.keys(raw)) if (!known.has(k)) errors.push(`unknown key "${k}"`);
  if (raw.version !== undefined) { if (raw.version !== 1) errors.push('version must be 1'); }
  for (const k of ['name', 'note']) if (raw[k] !== undefined) { if (typeof raw[k] === 'string' && raw[k].length <= 300) out[k] = raw[k]; else errors.push(`${k} must be text of at most 300 characters`); }
  const fill = (section, rules, src, dst, path) => {
    if (src === undefined) return;
    if (!isObj(src)) { errors.push(`${path} must be an object`); return; }
    for (const k of Object.keys(src)) if (!rules[k]) errors.push(`unknown key "${path}.${k}"`);
    for (const [k, [check, why]] of Object.entries(rules)) if (src[k] !== undefined) { if (check(src[k])) dst[k] = src[k]; else errors.push(`${path}.${k}: expected ${why}, got ${JSON.stringify(src[k])}`); }
  };
  for (const [section, rules] of Object.entries(RULES)) fill(section, rules, raw[section], out[section], section);
  if (raw.signals !== undefined) {
    if (!isObj(raw.signals)) errors.push('signals must be an object');
    else { for (const k of Object.keys(raw.signals)) if (!SIGNAL_RULES[k]) errors.push(`unknown signal "${k}"`); for (const [name, rules] of Object.entries(SIGNAL_RULES)) fill(name, rules, raw.signals[name], out.signals[name], `signals.${name}`); }
  }
  if (raw.tuning !== undefined) {
    if (!isObj(raw.tuning)) errors.push('tuning must be an object');
    else {
      for (const k of Object.keys(raw.tuning)) if (!['enabled', 'minImprovement', 'params'].includes(k)) errors.push(`unknown key "tuning.${k}"`);
      if (raw.tuning.enabled !== undefined) { if (typeof raw.tuning.enabled === 'boolean') out.tuning.enabled = raw.tuning.enabled; else errors.push('tuning.enabled must be true or false'); }
      if (raw.tuning.minImprovement !== undefined) { if (num(raw.tuning.minImprovement, 0, 0.1)) out.tuning.minImprovement = raw.tuning.minImprovement; else errors.push('tuning.minImprovement must be a number from 0 to 0.1 (a mean excess return per period)'); }
      if (raw.tuning.params !== undefined) {
        if (!isObj(raw.tuning.params)) errors.push('tuning.params must be an object');
        else {
          const params = {};
          for (const [path, b] of Object.entries(raw.tuning.params)) {
            const cur = getPath(out, path);
            if (typeof cur !== 'number' || path.startsWith('tuning.')) { errors.push(`tuning.params: "${path}" is not a tunable number in this file`); continue; }
            if (!isObj(b) || !['min', 'max', 'step'].every(k => typeof b[k] === 'number' && Number.isFinite(b[k])) || !(b.step > 0) || b.min > b.max) { errors.push(`tuning.params.${path} needs min, max and step (step above 0, min not above max)`); continue; }
            params[path] = { min: b.min, max: b.max, step: b.step };
          }
          out.tuning.params = params;
        }
      }
    }
  }
  // cross-field checks
  const sig = out.signals, enabled = Object.values(sig).filter(s => s.enabled && s.weight > 0);
  if (!enabled.length) errors.push('at least one signal must be enabled with a weight above 0');
  if (out.risk.maxPositions < out.portfolio.topN) errors.push(`risk.maxPositions (${out.risk.maxPositions}) must be at least portfolio.topN (${out.portfolio.topN})`);
  if (out.execution.order === 'opg' && out.execution.dryRun === false) { /* allowed: sent before 9:28 New York time, by the scheduler */ }
  return { ok: errors.length === 0, errors, value: errors.length ? null : out };
}

// the paths whose values differ between two strategies, as [path, from, to]
function diff(a, b) {
  const out = [];
  const walk = (x, y, p) => {
    if (isObj(x) && isObj(y)) { for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], p ? `${p}.${k}` : k); return; }
    if (JSON.stringify(canonical(x)) !== JSON.stringify(canonical(y))) out.push([p, x, y]);
  };
  walk(a, b, '');
  return out;
}

// the store: reads the file, keeps the last good version, reloads when the file changes (mtime and size)
function createStrategyStore({ file, now = Date.now, log = () => {}, readFile = p => fs.readFileSync(p, 'utf8'), statFile = p => fs.statSync(p), writeFile = (p, t) => fs.writeFileSync(p, t) } = {}) {
  if (!file) throw new TypeError('strategy store needs a file path');
  let good = null, goodHash = null, loadedAt = null, lastError = null, sig = null, errorSig = null;

  function load() {
    let text, st;
    try { st = statFile(file); text = readFile(file); } catch (err) {
      if (err.code === 'ENOENT') { writeFile(file, `${JSON.stringify(PRESET, null, 2)}\n`); log(`strategy: no ${file}; the preset was written (dryRun true)`); return load(); }
      lastError = { at: now(), errors: [`cannot read the file: ${err.message}`] }; return state();
    }
    sig = `${st.mtimeMs}:${st.size}`;
    let raw;
    try { raw = JSON.parse(text.replace(/^﻿/, '')); } catch (err) { lastError = { at: now(), errors: [`not valid JSON: ${err.message}`] }; errorSig = sig; log(`strategy: refused, ${lastError.errors[0]}; the last good version keeps running`); return state(); }
    const n = normalize(raw);
    if (!n.ok) { lastError = { at: now(), errors: n.errors }; errorSig = sig; log(`strategy: refused ${n.errors.length} problem(s): ${n.errors.slice(0, 3).join('; ')}; the last good version keeps running`); return state(); }
    const h = hashOf(n.value);
    if (h !== goodHash) log(`strategy: version ${h} loaded${goodHash ? ` (was ${goodHash})` : ''}`);
    good = n.value; goodHash = h; loadedAt = now(); lastError = null; errorSig = null;
    return state();
  }
  // cheap: only re-reads when the file's mtime or size changed
  function check() {
    try { const st = statFile(file); if (`${st.mtimeMs}:${st.size}` === sig) return { changed: false, ...state() }; } catch { /* load() reports a missing file */ }
    const before = goodHash, s = load();
    return { changed: s.hash !== before || Boolean(s.error), ...s };
  }
  function state() { return { strategy: good ? clone(good) : null, hash: goodHash, buildId: good ? `sbx-${goodHash}` : null, loadedAt, error: lastError }; }
  // rewrite the file with a new strategy (the tuner's adoption); validated first, never leaves an invalid file
  function save(strategy) {
    const n = normalize(strategy);
    if (!n.ok) throw new Error(`refused to write an invalid strategy: ${n.errors.join('; ')}`);
    writeFile(file, `${JSON.stringify(n.value, null, 2)}\n`);
    sig = null;
    return load();
  }
  return { load, check, state, save, file };
}

module.exports = { PRESET, normalize, hashOf, buildIdOf, diff, getPath, setPath, createStrategyStore, DOWS };
