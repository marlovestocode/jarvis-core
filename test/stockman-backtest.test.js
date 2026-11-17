// Tests for the backtest tool (vault note 06 "Scoring model v1 and trade mechanics", D21): the rule, the periods, the holdout lock,
// the variant log, the survivorship report, the statistics. Synthetic data only, in-memory database, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { createStockman } = require('../src/core/stockman/app');
const { createMockProvider } = require('../src/core/stockman/stocks/mock');
const { createBars } = require('../src/core/stockman/features/bars');
const { tradingDays } = require('../src/core/stockman/features/calendar-rules');
const { createTradingLayer } = require('../src/core/stockman/trading');
const { periodIndexes } = require('../src/core/stockman/trading/backtest');
const E = require('../src/core/stockman/trading/engine');
const { blockBootstrapMean, mean, stdev, mulberry32, brierSkill } = require('../src/core/stockman/trading/stats');
const { formatResult } = require('../src/core/stockman/trading/report');

const SESSIONS = tradingDays('2023-01-03', '2024-12-31');
const INDEX = new Map(SESSIONS.map((d, i) => [d, i]));
const NOFLAGS = () => ({ earnings_in_window: false, earnings_possible: false, earnings_data: 'unknown' });

// a price path from daily returns; open = previous close, so an adjusted open differs from the close only by the day's own move
function path(n, start, retFn) {
  const closes = [start];
  for (let i = 1; i < n; i++) closes.push(closes[i - 1] * (1 + retFn(i)));
  return closes;
}
function rowsOf(closes, { adjFactor = () => 1, skip = () => false, from = 0, openOf = (c, i, a) => (i ? a[i - 1] : c) } = {}) {
  const rows = [];
  closes.forEach((c, i) => {
    if (i < from || skip(i)) return;
    rows.push({ day: SESSIONS[i], open: openOf(c, i, closes), high: c * 1.01, low: c * 0.99, close: c, adj_close: c * adjFactor(i), volume: 1000 });
  });
  return rows;
}
function noise(seed, amp = 0.01) { const r = mulberry32(seed); return () => (r() - 0.5) * 2 * amp; }
// 30 ordinary symbols plus SPY, random walks; returns { Map symbol -> rows }
function market({ extra = {} } = {}) {
  const m = new Map();
  for (let k = 0; k < 30; k++) m.set(`S${String(k).padStart(2, '0')}`, rowsOf(path(SESSIONS.length, 50 + k, noise(100 + k))));
  m.set('SPY', rowsOf(path(SESSIONS.length, 400, noise(7, 0.006))));
  for (const [sym, rows] of Object.entries(extra)) m.set(sym, rows);
  return m;
}
const alignAll = m => new Map([...m].map(([s, rows]) => [s, E.alignSeries(SESSIONS, INDEX, rows)]));

// ---- scoring ------------------------------------------------------------------------------------------------------------------------
test('score: -r / (vol20 * sqrt(L)) with volatility scaling, -r without; both use adjusted closes', () => {
  const closes = path(60, 100, noise(1));
  const s = alignAll(new Map([['X', rowsOf(closes, { adjFactor: () => 0.5 })]])).get('X');   // adjusted = half the raw: returns are unchanged
  const d = 40, L = 5;
  const r = closes[d] / closes[d - L] - 1;
  const rets = []; for (let i = d - 19; i <= d; i++) rets.push(closes[i] / closes[i - 1] - 1);
  assert.ok(Math.abs(E.scoreAt(s, d, { lookback: L, volScale: false }) + r) < 1e-12);
  assert.ok(Math.abs(E.scoreAt(s, d, { lookback: L, volScale: true }) - (-r / (stdev(rets) * Math.sqrt(L)))) < 1e-12);
});

test('variants: exactly six exist, keyed by lookback and scaling; an unknown one is refused', () => {
  assert.equal(E.ALL_VARIANTS.length, 6);
  assert.deepEqual(E.ALL_VARIANTS.map(v => v.key).sort(), ['rev-L10-raw', 'rev-L10-vol', 'rev-L3-raw', 'rev-L3-vol', 'rev-L5-raw', 'rev-L5-vol']);
  assert.equal(E.parseVariant('rev-L5-vol').lookback, 5);
  assert.throws(() => E.parseVariant('rev-L7-vol'), /six allowed/);
  assert.equal(E.buildId(E.parseVariant('rev-L3-raw')), 'reversal-v1/L3/raw');
});

// ---- the engine ---------------------------------------------------------------------------------------------------------------------
function engineRun({ extra, members, flags = NOFLAGS, d = 100, topN = 3, variant = E.parseVariant('rev-L5-vol'), mutate = null, sessions = SESSIONS } = {}) {
  const m = market({ extra });
  const series = alignAll(m);
  if (mutate) mutate(series);
  const all = [...m.keys()].filter(s => s !== 'SPY');
  return E.runBacktest({
    sessions, series, benchmark: 'SPY', variant, topN, flags,
    membersAsOf: members || (() => all), signalRange: { first: d, last: d }, gridEnd: d + 5,
  });
}
// a name that fell 3% a day over the last five sessions up to d
const faller = (d, { from = 0, skip, price = 60 } = {}) => rowsOf(path(SESSIONS.length, price, i => (i > d - 5 && i <= d ? -0.03 : noise(i)() * 0.2)), { from, skip });

test('engine: picks the biggest losers per unit of volatility, enters at the NEXT OPEN and exits at the 5th close', () => {
  const d = 100;
  const r = engineRun({ d, extra: { LOSER: faller(d), LOSER2: faller(d, { price: 70 }) } });
  assert.equal(r.baskets.length, 1);
  const b = r.baskets[0];
  assert.equal(b.signalDay, SESSIONS[d]); assert.equal(b.entryDay, SESSIONS[d + 1]); assert.equal(b.exitDay, SESSIONS[d + 5]);
  assert.ok(b.names.slice(0, 2).every(n => n.symbol.startsWith('LOSER')), 'the two fallers rank first');
  const rows = new Map(market({ extra: { LOSER: faller(d), LOSER2: faller(d, { price: 70 }) } }));
  const n = b.names.find(x => x.symbol === 'LOSER'), rr = rows.get('LOSER');
  assert.equal(n.entry, rr[d + 1].open);          // open of D+1 (adjusted factor 1 here)
  assert.equal(n.exit, rr[d + 5].adj_close);      // close of D+5
  assert.equal(n.expectedEntry, rr[d].adj_close); // the price known at the signal
  assert.ok(Math.abs(n.ret - (rr[d + 5].close / rr[d + 1].open - 1)) < 1e-12);
  const spy = market().get('SPY');
  assert.ok(Math.abs(b.bench - (spy[d + 5].close / spy[d + 1].open - 1)) < 1e-12);
  assert.ok(Math.abs(b.gross - mean(b.names.map(x => x.ret))) < 1e-12);   // equal weight
  assert.equal(b.names.length, 3);
});

test('engine: an adjusted open uses the same day\'s adjusted/raw ratio, so a dividend does not look like a return', () => {
  const d = 100;
  const rows = faller(d);
  const adj = 0.9;   // every adjusted close is 90% of its raw close
  const rr = rows.map(x => ({ ...x, adj_close: x.close * adj }));
  const r = engineRun({ d, extra: { LOSER: rr } });
  const n = r.baskets[0].names.find(x => x.symbol === 'LOSER');
  assert.ok(Math.abs(n.entry - rows[d + 1].open * adj) < 1e-9);
  assert.ok(Math.abs(n.ret - (rows[d + 5].close / rows[d + 1].open - 1)) < 1e-9);
});

test('engine: eligibility rules each remove a name that would otherwise rank first', () => {
  const d = 100;
  const extra = {
    CHEAP: faller(d, { price: 4.5 }),                               // close at or below USD 5 (it falls 3% a day, so check the price on d)
    SHORT: faller(d, { from: d - 40 }),                             // 41 bars only
    GAPPY: faller(d, { skip: i => i === d - 10 }),                  // a bar missing in the last 25 sessions
    EARN: faller(d, { price: 61 }), POSS: faller(d, { price: 62 }),
    NOTMEMBER: faller(d, { price: 63 }),
    LOSER: faller(d, { price: 64 }),                                // the one that stays eligible
  };
  // CHEAP starts at 4.5 and only falls, so it is below 5 on d
  const flags = ({ symbol }) => (symbol === 'EARN' ? { earnings_in_window: true, earnings_possible: false, earnings_data: 'confirmed' } : symbol === 'POSS' ? { earnings_in_window: false, earnings_possible: true, earnings_data: 'estimated' } : NOFLAGS());
  const all = ['CHEAP', 'SHORT', 'GAPPY', 'EARN', 'POSS', 'LOSER', ...Array.from({ length: 30 }, (_, k) => `S${String(k).padStart(2, '0')}`)];
  const r = engineRun({ d, extra, flags, members: () => all, topN: 3 });
  const picked = r.baskets[0].names.map(n => n.symbol);
  assert.ok(picked.includes('LOSER'));
  for (const bad of ['CHEAP', 'SHORT', 'GAPPY', 'EARN', 'POSS', 'NOTMEMBER']) assert.ok(!picked.includes(bad), `${bad} must not be picked`);
  const ex = r.totals.excludedBy;
  assert.equal(ex.price_at_or_below_5, 1); assert.equal(ex.short_history, 1); assert.equal(ex.gap_25, 1);
  assert.equal(ex.earnings_in_window, 1); assert.equal(ex.earnings_possible, 1);
});

test('engine: an unknown earnings date does not exclude a name (only in_window and possible do) but is counted', () => {
  const r = engineRun({ d: 100, topN: 3 });
  assert.equal(r.baskets[0].names.length, 3);
  assert.equal(r.totals.earningsUnknown, 3);
});

test('engine: no lookahead; changing every bar after the exit day changes nothing about the basket', () => {
  const d = 100;
  const a = engineRun({ d, topN: 5 });
  const b = engineRun({
    d, topN: 5,
    mutate: series => { for (const s of series.values()) for (let i = d + 6; i < SESSIONS.length; i++) { s.adj[i] *= 7; s.adjOpen[i] *= 7; s.close[i] *= 7; } },
  });
  assert.deepEqual(b.baskets[0].names, a.baskets[0].names);
  assert.equal(b.baskets[0].gross, a.baskets[0].gross);
});

test('engine: signal-day data only; changing the future entry bar does not change which names are picked', () => {
  const d = 100;
  const a = engineRun({ d, topN: 5 });
  const b = engineRun({ d, topN: 5, mutate: series => { for (const s of series.values()) { s.adjOpen[d + 1] *= 1.5; s.adj[d + 3] *= 0.5; } } });
  assert.deepEqual(b.baskets[0].names.map(n => n.symbol), a.baskets[0].names.map(n => n.symbol));
});

test('engine: survivorship gap is reported per day: members with no bars at all are counted, never dropped silently', () => {
  const all = [...Array.from({ length: 30 }, (_, k) => `S${String(k).padStart(2, '0')}`), 'GHOST1', 'GHOST2'];
  const r = engineRun({ d: 100, members: () => all, topN: 3 });
  assert.equal(r.days[0].members, 32); assert.equal(r.days[0].noBars, 2);
  const g = E.gapReport(r.days);
  assert.equal(g.avgNoBars, 2); assert.equal(g.maxNoBars, 2);
  assert.ok(Math.abs(g.shareNoBars - 2 / 32) < 1e-12);
  assert.equal(g.years['2023'].days, 1);
});

test('engine: a picked name with no D+5 bar is dropped and counted; a day without enough candidates is skipped with a reason', () => {
  const d = 100;
  const r = engineRun({ d, extra: { LOSER: faller(d, { skip: i => i === d + 5 }) }, topN: 3 });
  assert.equal(r.totals.lostNames, 1);
  assert.ok(!r.baskets[0].names.some(n => n.symbol === 'LOSER'));
  const few = engineRun({ d, topN: 3, members: () => ['S00', 'S01'] });
  assert.equal(few.baskets.length, 0);
  assert.equal(few.days[0].skip, 'fewer_than_3_candidates');
});

test('engine: sleeves and the window grid: one basket per session, five sleeves, grid baskets exit on gridEnd - 5k', () => {
  const m = market(), series = alignAll(m), all = [...m.keys()].filter(s => s !== 'SPY');
  const gridEnd = 120;
  const r = E.runBacktest({ sessions: SESSIONS, series, benchmark: 'SPY', variant: E.parseVariant('rev-L5-vol'), topN: 3, flags: NOFLAGS, membersAsOf: () => all, signalRange: { first: 100, last: 114 }, gridEnd });
  assert.equal(r.baskets.length, 15);
  assert.deepEqual([...new Set(r.baskets.map(b => b.sleeve))].sort(), [0, 1, 2, 3, 4]);
  const grid = r.baskets.filter(b => b.grid);
  assert.equal(grid.length, 3);
  assert.deepEqual(grid.map(b => SESSIONS.indexOf(b.exitDay)), [105, 110, 115].map(x => x));   // 120 - 5k: 105, 110, 115 within the range
  // within one sleeve a basket exits before the next one enters: no overlap
  const s0 = r.baskets.filter(b => b.sleeve === 0);
  for (let i = 1; i < s0.length; i++) assert.ok(s0[i].entryDay > s0[i - 1].exitDay);
});

// ---- periods -------------------------------------------------------------------------------------------------------------------------
test('periods: the holdout is the last 100 windows ending 2026-11-13; tuning ends the session before the first holdout entry', () => {
  const sessions = tradingDays('2019-10-01', '2026-11-16');
  const p = periodIndexes(sessions);
  assert.equal(sessions[p.gridEnd], '2026-11-13');
  const firstHoldoutExit = p.gridEnd - 5 * 99;
  assert.equal(p.holdoutFirstEntry, firstHoldoutExit - 4);
  assert.equal(p.holdout.last, p.gridEnd - 5);
  assert.equal(p.holdout.first, p.holdoutFirstEntry - 1);
  assert.equal(p.tuning.last + 5, p.holdoutFirstEntry - 1);     // the last tuning basket exits before any holdout window starts
  assert.ok(sessions[p.tuning.first] >= '2020-03-01' && sessions[p.tuning.first] <= '2020-03-04');
  // about 230 to 250 tuning windows, as the note says
  const windows = Math.floor((p.tuning.last + 5 - p.tuning.first) / 5);
  assert.ok(windows > 220 && windows < 260, `tuning windows ${windows}`);
  assert.ok(sessions[p.holdoutFirstEntry] >= '2024-11' && sessions[p.holdoutFirstEntry] <= '2024-12-31');   // about 2024-12 onwards
  assert.throws(() => periodIndexes(sessions.slice(0, 300), {}), /do not include the end date/);
});

// ---- statistics ----------------------------------------------------------------------------------------------------------------------
test('stats: block bootstrap is deterministic, brackets the mean, and collapses on a constant series', () => {
  const r = mulberry32(5), xs = Array.from({ length: 120 }, () => (r() - 0.45) * 0.04);
  const a = blockBootstrapMean(xs, { reps: 2000 }), b = blockBootstrapMean(xs, { reps: 2000 });
  assert.deepEqual(a, b);
  assert.ok(a.lower95 < a.mean && a.mean < a.upper95);
  assert.ok(a.upper95 - a.lower95 < 0.02 && a.upper95 - a.lower95 > 0.002);
  const c = blockBootstrapMean(Array(30).fill(0.01), { reps: 500 });
  assert.ok(Math.abs(c.lower95 - 0.01) < 1e-12 && Math.abs(c.upper95 - 0.01) < 1e-12);
  assert.ok(Number.isNaN(blockBootstrapMean([0.1]).lower95));
});

test('stats: the 95% lower bound is above zero for a clear edge and below it for pure noise (mean about 0)', () => {
  const r = mulberry32(11);
  const noiseOnly = Array.from({ length: 100 }, () => (r() - 0.5) * 0.04);
  assert.ok(blockBootstrapMean(noiseOnly, { reps: 2000 }).lower95 < 0);
  const edge = Array.from({ length: 100 }, () => 0.01 + (r() - 0.5) * 0.01);
  assert.ok(blockBootstrapMean(edge, { reps: 2000 }).lower95 > 0);
  assert.ok(Math.abs(brierSkill([0.5, 0.5], [1, 0])) < 1e-12);
  assert.ok(brierSkill([0.9, 0.1], [1, 0]) > 0.9);
});

test('summarize: results at 5, 10 and 25 bps; the cost is taken off the gross once per trade, the benchmark carries none', () => {
  const baskets = Array.from({ length: 20 }, (_, i) => ({ grid: i % 2 === 0, gross: 0.01, bench: 0.004 }));
  const s = E.summarize(baskets, { boot: { reps: 200 } });
  assert.equal(s.windows, 10); assert.equal(s.baskets, 20);
  assert.deepEqual(Object.keys(s.levels).map(Number), [5, 10, 25]);
  assert.ok(Math.abs(s.levels[5].meanExcess - (0.01 - 0.0005 - 0.004)) < 1e-12);
  assert.ok(Math.abs(s.levels[10].meanExcess - (0.01 - 0.001 - 0.004)) < 1e-12);
  assert.ok(Math.abs(s.levels[25].meanExcess - (0.01 - 0.0025 - 0.004)) < 1e-12);
  assert.equal(s.levels[10].winRate, 1);
});

// ---- the tool: periods, lock, log, ledger ----------------------------------------------------------------------------------------------
async function btApp({ symbols = 30, ghosts = 2, flags = NOFLAGS } = {}) {
  const bars = createBars({});
  const members = [...Array.from({ length: symbols }, (_, k) => `S${String(k).padStart(2, '0')}`), ...Array.from({ length: ghosts }, (_, k) => `GHOST${k}`)];
  const data = {
    universe: { membersAsOf: () => ({ sp500: { snapshotAsOf: '2020-01-01', kind: 'history', symbols: members }, ndx100: null }) },
    earnings: { flags },
  };
  const end = SESSIONS[480];
  const trading = createTradingLayer({ data, options: { backtest: { start: '2023-03-01', end, holdoutWindows: 10, boot: { reps: 200 } } } });
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile: ':memory:', log: () => {}, provider: createMockProvider({}) });
  app.use(bars.feature);
  for (const f of trading.features) app.use(f);
  await app.start();
  const ins = app.db.stmt('INSERT INTO bar(symbol, day, open, high, low, close, adj_close, volume, source, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  app.db.tx(() => {
    for (const [sym, rows] of market()) for (const r of rows) ins.run(sym, r.day, r.open, r.high, r.low, r.close, r.adj_close, r.volume, 'test', 0);
  });
  return { app, bt: trading.api.backtest, ledger: trading.api.ledger, end };
}

test('tool: a tuning run covers only baskets that exit before the first holdout window, and writes ledger rows as source backtest', async () => {
  const { app, bt, ledger } = await btApp();
  const r = bt.run({ variant: 'rev-L5-vol' });
  assert.equal(app.db.version, 9);
  assert.equal(r.period, 'tuning'); assert.equal(r.variantsTried, 1); assert.equal(r.variantsAllowed, 6);
  assert.equal(r.lastExitDay, SESSIONS[480 - 45 - 4 - 1]);       // holdoutFirstEntry - 1
  assert.ok(r.summary.windows > 60);
  const rows = ledger.list({ source: 'backtest', limit: 100000 });
  assert.equal(rows.length, r.summary.baskets * 20);
  assert.ok(rows.every(x => x.exit_day <= r.lastExitDay && x.scoring_build === 'reversal-v1/L5/vol' && x.run_id === r.runId && x.status === 'closed'));
  assert.ok(rows.every(x => Math.abs(x.net_return - (x.gross_return - 0.001)) < 1e-12 && x.cost_bps === 10 && x.sleeve >= 0 && x.sleeve <= 4));
  assert.ok(rows[0].expected_entry_price > 0 && rows[0].fill_entry_price > 0);
  assert.deepEqual(Object.keys(r.summary.levels).map(Number), [5, 10, 25]);
  assert.ok(Math.abs(r.survivorship.avgNoBars - 2) < 1e-12);       // the two ghost members have no bars on any day
  const days = Number(app.db.stmt('SELECT COUNT(*) AS n FROM backtest_day WHERE run_id = ?').get(r.runId).n);
  assert.equal(days, r.tradingDaysRun);
  const text = formatResult(r);
  assert.match(text, /Variants tried so far: 1 of 6/); assert.match(text, /SURVIVORSHIP GAP/); assert.match(text, /BETTER than a complete data set/);
  assert.match(text, /Tuning period only. The holdout was not touched/); assert.match(text, /not a prediction/);
  await app.stop();
});

test('tool: a tuning result does not depend on any bar after the holdout starts (the holdout data is never read for tuning)', async () => {
  const { app, bt } = await btApp();
  const a = bt.run({ variant: 'rev-L5-vol' });
  const cut = SESSIONS[480 - 45 - 4];   // first holdout entry day
  app.db.stmt('UPDATE bar SET open = open * 3, close = close * 3, adj_close = adj_close * 3, high = high * 3, low = low * 3 WHERE day >= ?').run(cut);
  const b = bt.run({ variant: 'rev-L5-vol' });
  assert.deepEqual(b.summary, a.summary);
  await app.stop();
});

test('tool: re-running a variant replaces its earlier simulated ledger rows instead of piling them up', async () => {
  const { app, bt, ledger } = await btApp();
  const a = bt.run({ variant: 'rev-L5-vol' });
  const n = ledger.count({ source: 'backtest' });
  const b = bt.run({ variant: 'rev-L5-vol' });
  assert.equal(ledger.count({ source: 'backtest' }), n);
  assert.deepEqual(b.summary, a.summary);
  assert.equal(b.variantsTried, 1);                                // the same variant is not a new variant
  assert.equal(bt.status().runs.length, 2);
  await app.stop();
});

test('tool: every variant tried is logged and the count rises with each new one; a seventh cannot exist', async () => {
  const { app, bt } = await btApp();
  assert.equal(bt.run({ variant: 'rev-L5-vol' }).variantsTried, 1);
  assert.equal(bt.run({ variant: 'rev-L3-raw' }).variantsTried, 2);
  assert.equal(bt.run({ variant: 'rev-L10-vol' }).variantsTried, 3);
  assert.equal(bt.status().variantsTried, 3);
  assert.deepEqual(bt.status().variants.map(v => v.variant), ['rev-L5-vol', 'rev-L3-raw', 'rev-L10-vol']);
  assert.throws(() => bt.run({ variant: 'rev-L7-vol' }), /six allowed/);
  assert.equal(bt.status().variantsTried, 3);
  await app.stop();
});

test('holdout lock: refused by default, refused for a bad flag value, leaves no trace when refused', async () => {
  const { app, bt, ledger } = await btApp();
  assert.throws(() => bt.run({ variant: 'rev-L5-vol', period: 'holdout' }), e => e.code === 'HOLDOUT_LOCKED' && /locked/.test(e.message));
  assert.throws(() => bt.run({ variant: 'rev-L5-vol', period: 'holdout', allowHoldout: 'yes' }), e => e.code === 'HOLDOUT_LOCKED');
  assert.equal(bt.status().runs.length, 0); assert.equal(bt.status().variantsTried, 0);
  assert.equal(ledger.count({ source: 'backtest' }), 0);
  assert.throws(() => bt.run({ variant: 'rev-L5-vol', period: 'both' }), /tuning or holdout/);
  await app.stop();
});

test('holdout lock: runs once with the flag, is recorded, and a second run of the same variant is refused (the lock is a database index)', async () => {
  const { app, bt, ledger } = await btApp();
  const r = bt.run({ variant: 'rev-L5-vol', period: 'holdout', allowHoldout: true });
  assert.equal(r.period, 'holdout');
  assert.equal(r.firstEntryDay, SESSIONS[480 - 45 - 4]); assert.equal(r.lastExitDay, SESSIONS[480]);
  assert.equal(r.summary.windows, 10);                              // 10 holdout windows in this test
  assert.ok(ledger.list({ source: 'backtest', limit: 100000 }).every(x => x.entry_day >= r.firstEntryDay));
  assert.deepEqual(bt.status().holdoutSpent.map(h => [h.variant, h.status]), [['rev-L5-vol', 'done']]);
  assert.match(formatResult(r), /can never be run on the holdout again/);
  assert.throws(() => bt.run({ variant: 'rev-L5-vol', period: 'holdout', allowHoldout: true }), e => e.code === 'HOLDOUT_LOCKED' && /already run/.test(e.message));
  // the database itself refuses a second holdout row for the variant
  assert.throws(() => app.db.stmt("INSERT INTO backtest_run(id, variant_key, period, status, started_at, scoring_build, cost_model, variants_tried) VALUES ('x','rev-L5-vol','holdout','running',1,'b','c',1)").run(), /UNIQUE/);
  // another variant has its own single look
  assert.equal(bt.run({ variant: 'rev-L3-vol', period: 'holdout', allowHoldout: true }).variantsTried, 2);
  await app.stop();
});

test('holdout lock: a crash after the lock is taken still counts as the one look', async () => {
  const { app, bt } = await btApp({ flags: () => { throw new Error('earnings table broke'); } });
  assert.throws(() => bt.run({ variant: 'rev-L5-vol', period: 'holdout', allowHoldout: true }), /earnings table broke/);
  assert.deepEqual(bt.status().holdoutSpent.map(h => h.status), ['failed']);
  assert.throws(() => bt.run({ variant: 'rev-L5-vol', period: 'holdout', allowHoldout: true }), e => e.code === 'HOLDOUT_LOCKED');
  await app.stop();
});

test('holdout lock: a run that cannot start (the end date has no bar) takes no lock', async () => {
  const { app, bt, end } = await btApp();
  app.db.stmt("DELETE FROM bar WHERE symbol = 'SPY' AND day = ?").run(end);
  assert.throws(() => bt.run({ variant: 'rev-L5-vol', period: 'holdout', allowHoldout: true }), /do not include the end date/);
  assert.equal(bt.status().holdoutSpent.length, 0);
  await app.stop();
});

test('tool: needs the benchmark and the universe data, and says what is missing', async () => {
  const { app, bt } = await btApp();
  app.db.stmt("DELETE FROM bar WHERE symbol = 'SPY'").run();
  assert.throws(() => bt.run({ variant: 'rev-L5-vol' }), /SPY has only 0 bars/);
  await app.stop();
  const bars = createBars({});
  const trading = createTradingLayer({ data: {} });
  const app2 = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile: ':memory:', log: () => {}, provider: createMockProvider({}) });
  app2.use(bars.feature); for (const f of trading.features) app2.use(f);
  await app2.start();
  assert.throws(() => trading.api.backtest.run({ variant: 'rev-L5-vol' }), /universe and earnings APIs are needed/);
  await app2.stop();
});
