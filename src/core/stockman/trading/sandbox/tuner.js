// The sandbox tuner (vault D28, CL-0071): DETERMINISTIC CODE, not a language model. LLMs never write these numbers; a Claude /loop may only read and report.
// Once a week at most (on the strategy's rebalance day) it re-scores a small neighbourhood of the strategy's parameters on past data and moves each parameter
// by AT MOST ONE STEP, only when the candidate beats the current settings on the later (out-of-sample) part by `tuning.minImprovement`.
//   data:   the 2020-03 .. tuning-end sessions (note 06 periods). It NEVER READS THE HOLDOUT: bars after the tuning period's last exit are not loaded.
//           Live data after 2026-11-13 joins only once it holds at least LIVE_MIN_PERIODS completed rebalance periods; until then it is not used (and the
//           result says so). Earnings exclusion and the dollar-volume filter are not applied in the simulation (assumptions, stated in the record).
//   search: for each tunable path in `tuning.params` (min, max, step): {current - step, current, current + step} within bounds; the product of those,
//           at most MAX_CANDIDATES, fewest changed parameters first.
//   score:  walk-forward: the periods split 60/40 in time; a candidate is scored on the LATER 40%: mean excess return over SPY per rebalance period after
//           10 bps a side on turnover, with the block-bootstrap lower bound of trading/stats.js. The earlier 60% only vetoes a candidate that was clearly
//           worse there (by more than minImprovement).
//   adopt:  best candidate's later-part mean >= current's + minImprovement, no change in the last 5 sessions, strategy not killed. Adoption rewrites
//           stockman.strategy.json (new hash, logged); a failure changes nothing and is logged loudly.
//   record: every candidate and its scores go to the engine log and to stockman.sandbox-tuning.json (last 40 runs). No table.
//   SANDBOX, IN-SAMPLE-ADJACENT, NOT EVIDENCE: the search looks at the same history the strategy was written against.
const fs = require('node:fs');
const path = require('node:path');
const { blockBootstrapMean, mean } = require('../stats');
const { periodIndexes, PERIODS } = require('../backtest');
const E = require('../engine');
const { simulate, isRebalanceDay } = require('./engine');
const { normalize, hashOf, getPath, setPath } = require('./strategy');
const { nextTradingDay } = require('../../features/calendar-rules');

const MAX_CANDIDATES = 50, LIVE_MIN_PERIODS = 4, MIN_PERIODS = 12, LABEL = 'sandbox, in-sample-adjacent, not evidence';
const yieldNow = () => new Promise(r => setImmediate(r));
const clone = o => JSON.parse(JSON.stringify(o));
const sessionsAfter = (day, n) => { let d = day; for (let i = 0; i < n; i++) d = nextTradingDay(d); return d; };

// every neighbour set of the tunable parameters: [{ changes: { path: value }, strategy }] including the unchanged strategy first
function candidatesOf(strategy) {
  const axes = Object.entries(strategy.tuning.params).map(([p, b]) => {
    const cur = getPath(strategy, p), isInt = Number.isInteger(cur) && Number.isInteger(b.step);
    const vals = [cur - b.step, cur, cur + b.step].filter(v => v >= b.min - 1e-12 && v <= b.max + 1e-12).map(v => (isInt ? Math.round(v) : Math.round(v * 1e6) / 1e6));
    return { p, cur, vals: [...new Set(vals)] };
  });
  let combos = [{}];
  for (const a of axes) combos = combos.flatMap(c => a.vals.map(v => ({ ...c, [a.p]: v })));
  const withN = combos.map(c => ({ changes: Object.fromEntries(Object.entries(c).filter(([p, v]) => v !== getPath(strategy, p))), full: c }));
  withN.sort((x, y) => Object.keys(x.changes).length - Object.keys(y.changes).length);
  const out = [];
  for (const c of withN) {
    if (out.length >= MAX_CANDIDATES) break;
    const s = clone(strategy);
    for (const [p, v] of Object.entries(c.changes)) setPath(s, p, v);
    const n = normalize(s);
    if (n.ok) out.push({ changes: c.changes, strategy: n.value });
  }
  return out;
}

function createTuner({ store, data, getDb, sandbox, dataDir, now = Date.now, events = null, log = null, opts = {} } = {}) {
  for (const [n, x] of Object.entries({ store, data, getDb, sandbox })) if (!x) throw new TypeError(`tuner needs the ${n}`);
  const o = { benchmark: 'SPY', costBps: 10, weeklyMs: 7 * 86400000, periods: {}, resultFile: dataDir ? path.join(dataDir, 'stockman.sandbox-tuning.json') : null, ...opts };
  const emit = (level, message, extra) => { try { log?.[level === 'warn' ? 'warn' : 'info']?.(message, extra); events?.append?.({ level, source: 'sandbox-tuner', message, data: extra }); } catch { /* never break a run */ } };

  function loadTuningData(strategy) {
    const db = getDb();
    const all = db.stmt('SELECT day FROM bar WHERE symbol = ? ORDER BY day').all(o.benchmark).map(r => r.day);
    if (all.length < 400) throw new Error(`the benchmark has only ${all.length} bars`);
    const p = periodIndexes(all, o.periods);
    const endIdx = p.tuning.last + 5;                                 // the last tuning basket's exit; nothing after it is read
    const sessions = all.slice(0, endIdx + 1), index = new Map(sessions.map((d, i) => [d, i]));
    const idxs = strategy.universe.index === 'both' ? ['sp500', 'ndx100'] : [strategy.universe.index];
    const cache = new Map();
    const members = d => {
      const key = sessions[d].slice(0, 7);
      if (!cache.has(key)) { const m = data.universe.membersAsOf(sessions[d]), s = new Set(); for (const i of idxs) if (m[i]) for (const x of m[i].symbols) s.add(x); cache.set(key, [...s]); }
      return cache.get(key);
    };
    const need = new Set([o.benchmark]);
    for (let d = Math.max(0, p.tuning.first); d <= endIdx; d += 15) for (const s of members(d)) need.add(s);
    const rows = new Map();
    for (const r of db.stmt('SELECT symbol, day, open, high, low, close, adj_close, volume FROM bar WHERE day <= ? AND symbol IN (SELECT value FROM json_each(?)) ORDER BY symbol, day').all(sessions.at(-1), JSON.stringify([...need]))) {
      let a = rows.get(r.symbol); if (!a) rows.set(r.symbol, a = []); a.push(r);
    }
    const series = new Map([...rows].map(([s, r]) => [s, E.alignSeries(sessions, index, r)]));
    return { sessions, series, bench: series.get(o.benchmark), members, first: p.tuning.first, endIdx, tuningEnd: sessions.at(-1), holdoutEnd: o.periods.end || PERIODS.END };
  }

  function periodsFor(strategy, D) {
    const rule = strategy.portfolio.rebalance;
    const need = Math.max(strategy.signals.momentum.lookback + strategy.signals.momentum.skip + 1, strategy.signals.trend.days + 1, strategy.regime.days + 1, 61);
    const start = Math.max(D.first, need + 5);
    const rebalances = [];
    for (let d = start; d <= D.endIdx; d++) if (isRebalanceDay(rule, D.sessions, d)) rebalances.push(d);
    return simulate(strategy, { rebalances, series: D.series, bench: D.bench, members: D.members, costBps: o.costBps });
  }
  function scoreOf(periods) {
    const k = Math.floor(periods.length * 0.6), fit = periods.slice(0, k), test = periods.slice(k);
    const tx = test.map(p => p.excess), bs = blockBootstrapMean(tx, { block: 3, reps: 2000 });
    return { periods: periods.length, fitMean: fit.length ? mean(fit.map(p => p.excess)) : NaN, testMean: test.length ? mean(tx) : NaN, testLower95: bs.lower95, testN: test.length, firstDay: null };
  }

  function writeResult(rec) {
    if (!o.resultFile) return;
    let list = [];
    try { list = JSON.parse(fs.readFileSync(o.resultFile, 'utf8')); } catch { /* first run */ }
    list.push(rec);
    fs.writeFileSync(o.resultFile, JSON.stringify(list.slice(-40), null, 1));
  }

  // run one tuning pass. force: ignore the weekly and rebalance-day gates (the CLI and the first run); apply: false = score only, never rewrite the file
  async function run({ day = null, force = false, apply = true } = {}) {
    const cur = store.check();
    if (!cur.strategy) return { status: 'no-strategy', label: LABEL };
    const strategy = cur.strategy, st = sandbox.readState(), t = now();
    const today = day || new Date(t).toISOString().slice(0, 10);
    if (!force) {
      if (!strategy.tuning.enabled) return { status: 'off', label: LABEL };
      if (st.killed) return { status: 'killed', note: 'the tuner changes nothing while the kill switch is on', label: LABEL };
      if (st.lastTune && t - st.lastTune.at < o.weeklyMs) return { status: 'waiting', note: 'at most once a week', label: LABEL };
    }
    const rec = { at: t, day: today, label: LABEL, hashBefore: cur.hash, strategyName: strategy.name, assumptions: 'earnings exclusion and the dollar-volume filter are not applied in the simulation; hold from signal close to the next rebalance close; 10 bps a side on turnover', live: { used: false, reason: `fewer than ${LIVE_MIN_PERIODS} completed rebalance periods after ${PERIODS.END}` }, candidates: [] };
    try {
      const D = loadTuningData(strategy);
      rec.data = { tuningFirst: D.sessions[D.first], tuningEnd: D.tuningEnd, holdoutEndNeverRead: D.holdoutEnd, symbols: D.series.size };
      const cands = candidatesOf(strategy);
      let current = null, best = null;
      for (const c of cands) {
        const s = scoreOf(periodsFor(c.strategy, D));
        const row = { changes: c.changes, ...s };
        rec.candidates.push(row);
        if (!Object.keys(c.changes).length) current = row; else if (Number.isFinite(s.testMean) && (!best || s.testMean > best.row.testMean)) best = { row, strategy: c.strategy };
        await yieldNow();
      }
      rec.current = current;
      if (!current || current.periods < MIN_PERIODS) { rec.status = 'too-few-periods'; rec.note = `only ${current?.periods ?? 0} rebalance periods (need ${MIN_PERIODS})`; }
      else {
        const sessionsSince = st.lastChangeDay ? (() => { let n = 0, d = st.lastChangeDay; while (d < today && n < 99) { d = nextTradingDay(d); n++; } return n; })() : 99;
        const margin = strategy.tuning.minImprovement;
        const better = best && best.row.testMean - current.testMean >= margin && best.row.fitMean >= current.fitMean - margin;
        rec.best = best ? best.row : null;
        if (!better) { rec.status = 'kept'; rec.note = best ? `best candidate gained ${(best.row.testMean - current.testMean).toFixed(5)} on the later part (needs ${margin}) or was worse earlier` : 'no candidate'; }
        else if (sessionsSince < 5) { rec.status = 'kept'; rec.note = `a change was made ${sessionsSince} session(s) ago; none in 5`; }
        else if (!apply) { rec.status = 'would-change'; rec.note = 'dry: not applied'; }
        else {
          const before = hashOf(strategy);
          const saved = store.save(best.strategy);
          rec.status = 'changed'; rec.hashAfter = saved.hash; rec.note = `changed ${JSON.stringify(best.row.changes)}; ${before} -> ${saved.hash}`;
          sandbox.patchState(s => { s.lastChangeDay = today; });
        }
      }
    } catch (err) {
      rec.status = 'failed'; rec.note = String(err.message).slice(0, 300);
      emit('warn', `SANDBOX TUNER FAILED, it changes nothing: ${rec.note}`);
    }
    if (rec.status !== 'failed') sandbox.patchState(s => { s.lastTune = { at: t, day: today, status: rec.status, note: rec.note, hashBefore: rec.hashBefore, hashAfter: rec.hashAfter ?? null, current: rec.current && { testMean: rec.current.testMean, periods: rec.current.periods }, best: rec.best && { testMean: rec.best.testMean, changes: rec.best.changes } }; });
    emit('info', `sandbox tuner ${today}: ${rec.status} (${rec.candidates.length} candidates). ${rec.note || ''} [${LABEL}]`, { status: rec.status, hashBefore: rec.hashBefore, hashAfter: rec.hashAfter ?? null });
    try { writeResult(rec); } catch (err) { emit('warn', 'sandbox tuner: result file not written', { message: err.message }); }
    return rec;
  }
  const maybeRun = ({ day }) => run({ day, force: false });
  return { run, maybeRun, candidatesOf, LABEL };
}

module.exports = { createTuner, candidatesOf, LABEL, MAX_CANDIDATES, LIVE_MIN_PERIODS };
