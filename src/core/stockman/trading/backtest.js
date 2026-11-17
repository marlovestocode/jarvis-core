// Feature "backtest" (vault Phase 5, note 06, D21): runs the engine on the stored data, enforces the rules that keep the result honest, and
// writes the outcome into stockman.db. A backtest is a simulation of past data, not a prediction.
//   - PERIODS are fixed: backtest 2020-03 to 2026-11-13; the HOLDOUT is the last 100 non-overlapping 5-session windows ending 2026-11-13;
//     the TUNING period is everything before it. A tuning run never reads a bar after the holdout starts (the last tuning basket exits
//     the session before the first holdout window), and a basket that would span the border belongs to neither (it is purged).
//   - The HOLDOUT is LOCKED: it runs only with allowHoldout = true, is recorded when it runs, and the same variant can never run on it
//     twice (a unique index enforces it, so a crash mid-run still counts as the one look).
//   - VARIANTS: at most six exist (engine.ALL_VARIANTS). Every variant that has been run is logged; its count is part of every result.
//   - Every trade goes into the paper ledger with source 'backtest'; a re-run replaces that variant-and-period's earlier simulated rows.
const { StockmanError } = require('../errors');
const E = require('./engine');
const { BASE_BPS, REPORT_BPS, MODEL_VERSION } = require('./costs');
const { gapReport, summarize } = E;

const MIGRATION_VERSION = 9;
const PERIODS = Object.freeze({ START: '2020-03-01', END: '2026-11-13', HOLDOUT_WINDOWS: 100 });
const BENCHMARK = 'SPY';

class HoldoutLockedError extends StockmanError { constructor(m) { super(m, { code: 'HOLDOUT_LOCKED' }); } }

const migration = {
  version: MIGRATION_VERSION, name: 'backtest',
  up(raw) {
    raw.exec(`
      -- every variant ever run (at most six exist); the count of these rows is shown next to every result
      CREATE TABLE backtest_variant(
        variant_key TEXT PRIMARY KEY, lookback INTEGER NOT NULL, vol_scale INTEGER NOT NULL, first_run_at INTEGER NOT NULL);
      CREATE TABLE backtest_run(
        id TEXT PRIMARY KEY,
        variant_key TEXT NOT NULL REFERENCES backtest_variant(variant_key),
        period TEXT NOT NULL CHECK(period IN ('tuning','holdout')),
        status TEXT NOT NULL CHECK(status IN ('running','done','failed')),
        started_at INTEGER NOT NULL, finished_at INTEGER,
        scoring_build TEXT NOT NULL, cost_model TEXT NOT NULL,
        variants_tried INTEGER NOT NULL,        -- distinct variants run so far, counting this one
        params TEXT, summary TEXT, note TEXT);
      CREATE INDEX backtest_run_variant ON backtest_run(variant_key, period);
      -- the holdout can be looked at ONCE per variant: this index refuses a second row, whatever the first one's status
      CREATE UNIQUE INDEX backtest_holdout_once ON backtest_run(variant_key) WHERE period = 'holdout';
      -- survivorship gap (vault G24): per signal day, how many point-in-time members had no bars at all
      CREATE TABLE backtest_day(
        run_id TEXT NOT NULL REFERENCES backtest_run(id), day TEXT NOT NULL,
        members INTEGER NOT NULL, no_bars INTEGER NOT NULL, no_bar_on_day INTEGER NOT NULL,
        eligible INTEGER NOT NULL, selected INTEGER NOT NULL, skip TEXT,
        PRIMARY KEY(run_id, day)) WITHOUT ROWID;
    `);
  },
};

// session indexes of the periods, from the fixed dates. Pure, so tests can check the border.
function periodIndexes(sessions, { start = PERIODS.START, end = PERIODS.END, holdoutWindows = PERIODS.HOLDOUT_WINDOWS } = {}) {
  const gridEnd = sessions.indexOf(end);
  if (gridEnd < 0) throw new StockmanError(`the bars do not include the end date ${end} (SPY has no bar that day); run the data history first`);
  const holdoutFirstEntry = gridEnd - 5 * (holdoutWindows - 1) - 4;
  const firstSignal = Math.max(sessions.findIndex(d => d >= start), E.GAP_WINDOW);
  if (holdoutFirstEntry - 1 <= firstSignal) throw new StockmanError('not enough sessions for the holdout plus a tuning period');
  return {
    gridEnd, holdoutFirstEntry,
    tuning: { first: firstSignal, last: holdoutFirstEntry - 6 },      // the last tuning basket exits on holdoutFirstEntry - 1
    holdout: { first: holdoutFirstEntry - 1, last: gridEnd - 5 },     // signal on the day before the first holdout entry
  };
}

function createBacktest({ ledger, data = {}, now = Date.now, opts = {} } = {}) {
  let db = null, log = null;
  const o = { ...PERIODS, benchmark: BENCHMARK, boot: {}, ...opts };
  const need = () => { if (!db) throw new StockmanError('backtest: not started'); return db; };
  const num = sql => Number(need().stmt(sql).get().n);

  const variantsTried = () => num('SELECT COUNT(*) AS n FROM backtest_variant');
  const holdoutRun = key => need().stmt("SELECT id, status, started_at AS startedAt FROM backtest_run WHERE variant_key = ? AND period = 'holdout'").get(key) || null;

  function loadSessions() {
    return need().stmt('SELECT day FROM bar WHERE symbol = ? ORDER BY day').all(o.benchmark).map(r => r.day);
  }
  // every symbol's bars aligned to the SPY session grid, in one pass over the table
  function loadSeries(sessions) {
    const index = new Map(sessions.map((d, i) => [d, i]));
    const series = new Map();
    let sym = null, rows = [];
    const flush = () => { if (sym !== null) series.set(sym, E.alignSeries(sessions, index, rows)); rows = []; };
    for (const r of need().stmt('SELECT symbol, day, open, close, adj_close FROM bar WHERE day >= ? AND day <= ? ORDER BY symbol, day').iterate(sessions[0], sessions.at(-1))) {
      if (r.symbol !== sym) { flush(); sym = r.symbol; }
      rows.push(r);
    }
    flush();
    return series;
  }
  function memberSet(day) {
    const m = data.universe.membersAsOf(day), out = new Set();
    let any = false;
    for (const idx of Object.values(m)) if (idx) { any = true; for (const s of idx.symbols) out.add(s); }
    if (!any) throw new StockmanError(`no point-in-time membership list on or before ${day}; run the universe backfill first`);
    return [...out];
  }

  // run one variant on one period. Returns the stored result.
  //   period 'tuning' (default) or 'holdout'. The holdout needs allowHoldout: true (the user's call, never a default).
  function run({ variant, period = 'tuning', allowHoldout = false, onProgress = null } = {}) {
    const d = need();
    if (!data.universe || !data.earnings) throw new StockmanError('backtest: the universe and earnings APIs are needed (register the data layer)');
    const v = typeof variant === 'string' ? E.parseVariant(variant) : E.parseVariant(E.variantKey(variant || { lookback: 5, volScale: true }));
    if (period !== 'tuning' && period !== 'holdout') throw new RangeError('period is tuning or holdout');
    if (period === 'holdout') {
      if (allowHoldout !== true) throw new HoldoutLockedError('the holdout is locked: it runs only when you ask for it explicitly (allowHoldout), once per variant');
      const prior = holdoutRun(v.key);
      if (prior) throw new HoldoutLockedError(`the holdout was already run for ${v.key} (${prior.id}, ${prior.status}); a second look is refused. Tuning on it is not allowed (note 06, criterion 5)`);
    }
    const sessions = loadSessions();
    if (sessions.length < 200) throw new StockmanError(`the benchmark ${o.benchmark} has only ${sessions.length} bars; run the data history first`);
    const p = periodIndexes(sessions, o);
    const range = p[period];
    // log the variant and take the lock BEFORE any result exists, so a crash cannot give a second look
    const id = `bt-${v.key}-${period}-${now()}`;
    d.tx(() => {
      d.stmt('INSERT OR IGNORE INTO backtest_variant(variant_key, lookback, vol_scale, first_run_at) VALUES (?,?,?,?)').run(v.key, v.lookback, v.volScale ? 1 : 0, now());
      d.stmt('INSERT INTO backtest_run(id, variant_key, period, status, started_at, scoring_build, cost_model, variants_tried, params) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, v.key, period, 'running', now(), E.buildId(v), MODEL_VERSION, variantsTried(), JSON.stringify({ range: [sessions[range.first], sessions[range.last]], gridEnd: sessions[p.gridEnd], holdoutFirstEntry: sessions[p.holdoutFirstEntry], benchmark: o.benchmark }));
    });
    try {
      const series = loadSeries(sessions);
      const r = E.runBacktest({
        sessions, series, benchmark: o.benchmark, variant: v, signalRange: range, gridEnd: p.gridEnd,
        membersAsOf: memberSet, flags: a => data.earnings.flags(a),
        onDay: onProgress ? row => onProgress(row) : null,
      });
      const sum = summarize(r.baskets, { boot: o.boot });
      const gap = gapReport(r.days);
      const tried = variantsTried();
      const result = {
        runId: id, variant: v.key, buildId: E.buildId(v), period, variantsTried: tried, variantsAllowed: E.ALL_VARIANTS.length,
        firstSignalDay: sessions[range.first], lastSignalDay: sessions[range.last],
        firstEntryDay: r.baskets[0]?.entryDay ?? null, lastExitDay: r.baskets.at(-1)?.exitDay ?? null,
        tradingDaysRun: r.days.length, skippedDays: r.totals.skippedDays, summary: sum, survivorship: gap, totals: r.totals,
        data: { sessions: sessions.length, firstSession: sessions[0], lastSession: sessions.at(-1), symbolsWithBars: series.size },
        costLevels: REPORT_BPS, baseBps: BASE_BPS,
        caveat: 'A simulation of past data, not a prediction. Members whose bars the provider no longer serves (delisted, renamed) are missing, which likely makes a reversal rule look better than it was (vault G24).',
      };
      d.tx(() => {
        // replace this variant-and-period's earlier simulated rows, then write the new ones
        const prior = d.stmt("SELECT id FROM backtest_run WHERE variant_key = ? AND period = ? AND id <> ? AND status = 'done'").all(v.key, period, id).map(x => x.id);
        ledger.deleteBacktestRuns(prior);
        const rows = [];
        for (const b of r.baskets) for (const n of b.names) {
          rows.push({
            source: 'backtest', runId: id, basketId: `${v.key}:${b.signalDay}`, sleeve: b.sleeve, scoringBuild: E.buildId(v), symbol: n.symbol,
            weight: 1 / b.names.length, score: n.score, signalDay: b.signalDay, entryDay: b.entryDay, exitDay: b.exitDay,
            expectedEntryPrice: n.expectedEntry, expectedExitPrice: n.exit, fillEntryPrice: n.entry, fillExitPrice: n.exit,
            grossReturn: n.ret, costBps: BASE_BPS, netReturn: n.ret - BASE_BPS / 10000, benchmarkReturn: b.bench,
            note: 'prices on the adjusted basis',
          });
        }
        ledger.insertClosedBatch(rows);
        const ins = d.stmt('INSERT INTO backtest_day(run_id, day, members, no_bars, no_bar_on_day, eligible, selected, skip) VALUES (?,?,?,?,?,?,?,?)');
        for (const x of r.days) ins.run(id, x.day, x.members, x.noBars, x.noBarOnDay, x.eligible, x.selected, x.skip);
        d.stmt("UPDATE backtest_run SET status = 'done', finished_at = ?, summary = ? WHERE id = ?").run(now(), JSON.stringify({ ...result, summary: sum }), id);
      });
      return result;
    } catch (err) {
      try { d.stmt("UPDATE backtest_run SET status = 'failed', finished_at = ?, note = ? WHERE id = ?").run(now(), String(err.message).slice(0, 500), id); } catch { /* the original error matters more */ }
      log?.warn?.('backtest failed', { id, message: err.message });
      throw err;
    }
  }

  // what has been run, the variant count and which holdouts are spent
  function status() {
    const d = need();
    return {
      variantsTried: variantsTried(), variantsAllowed: E.ALL_VARIANTS.length,
      variants: d.stmt('SELECT variant_key AS variant, first_run_at AS firstRunAt FROM backtest_variant ORDER BY first_run_at').all(),
      runs: d.stmt('SELECT id, variant_key AS variant, period, status, started_at AS startedAt, finished_at AS finishedAt, variants_tried AS variantsTried FROM backtest_run ORDER BY started_at, id').all(),
      holdoutSpent: d.stmt("SELECT variant_key AS variant, id, status FROM backtest_run WHERE period = 'holdout' ORDER BY started_at").all(),
    };
  }
  function lastResult(variant, period = 'tuning') {
    const row = need().stmt("SELECT summary FROM backtest_run WHERE variant_key = ? AND period = ? AND status = 'done' ORDER BY started_at DESC, id DESC LIMIT 1").get(variant, period);
    return row ? JSON.parse(row.summary) : null;
  }

  const api = { run, status, lastResult, periodIndexes, PERIODS, HoldoutLockedError };
  const feature = {
    id: 'backtest', migrations: [migration],
    async start(ctx) { db = ctx.db; log = ctx.log; },
    async stop() { db = null; },
  };
  return { feature, api };
}

module.exports = { createBacktest, periodIndexes, HoldoutLockedError, MIGRATION_VERSION, PERIODS, BENCHMARK };
