// Momentum rule "mom-v1" (vault note 06 "Rule 2: momentum", decision D25, CL-0053): the formula, the skip of the last month, the history rule,
// ONE scorer per rule (the live scoring path and the backtest engine agree), the per-rule variant counter, and the refusal to run on a
// shortened history. Synthetic data only, in-memory database, no network. The reversal rule's own tests are unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createStockman } = require('../src/core/stockman/app');
const { createMockProvider } = require('../src/core/stockman/stocks/mock');
const { createBars } = require('../src/core/stockman/features/bars');
const { createTradingLayer } = require('../src/core/stockman/trading');
const E = require('../src/core/stockman/trading/engine');
const S = require('../src/core/stockman/learning/scoring');
const { formatResult } = require('../src/core/stockman/trading/report');
const { stdev } = require('../src/core/stockman/trading/stats');
const { makeLearning, tradingDays } = require('./helpers/stockman-learning');

const SESSIONS = tradingDays('2023-01-03', '2026-03-31');
const INDEX = new Map(SESSIONS.map((d, i) => [d, i]));
const NOFLAGS = () => ({ earnings_in_window: false, earnings_possible: false, earnings_data: 'unknown' });

function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2147483648 - 1; }; }
function walk(n, start, seed, amp = 0.012, drift = 0) {
  const r = lcg(seed), c = [start];
  for (let i = 1; i < n; i++) c.push(c[i - 1] * (1 + drift + r() * amp));
  return c;
}
function rowsOf(closes, { adj = 1, from = 0, skip = [] } = {}) {
  const rows = [];
  closes.forEach((c, i) => {
    if (i < from || skip.includes(i)) return;
    rows.push({ day: SESSIONS[i], open: i ? closes[i - 1] : c, high: c * 1.01, low: c * 0.99, close: c, adj_close: c * adj, volume: 1000 });
  });
  return rows;
}
function market() {
  const m = new Map();
  for (let k = 0; k < 30; k++) m.set(`M${String(k).padStart(2, '0')}`, rowsOf(walk(SESSIONS.length, 40 + k, 500 + k, 0.014, (k - 15) * 0.0002)));
  m.set('SPY', rowsOf(walk(SESSIONS.length, 400, 9, 0.006, 0.0003)));
  return m;
}
const alignAll = m => new Map([...m].map(([s, rows]) => [s, E.alignSeries(SESSIONS, INDEX, rows)]));
const adjAt = rows => { const by = new Map(rows.map(r => [r.day, r.adj_close])); return day => by.get(day) ?? null; };

// ---- variants and build id ----------------------------------------------------------------------------------------------------------
test('momentum variants: exactly six (L 63, 126, 252; raw or vol), build mom-v1.0, no primary; the reversal list is untouched', () => {
  assert.equal(S.MOM_BUILD, 'mom-v1.0');
  assert.equal(S.MOM_VARIANTS.length, 6);
  assert.equal(E.MOMENTUM_VARIANTS.length, 6);
  assert.deepEqual(E.MOMENTUM_VARIANTS.map(v => v.key).sort(), ['mom-L126-raw', 'mom-L126-vol', 'mom-L252-raw', 'mom-L252-vol', 'mom-L63-raw', 'mom-L63-vol']);
  assert.equal(E.buildId(E.parseVariant('mom-L63-raw')), 'mom-v1.0/L63/raw');
  assert.equal(E.buildId(E.parseVariant('rev-L5-vol')), 'rev-v1.0/L5/vol');
  assert.equal(E.ALL_VARIANTS.length, 6);
  assert.equal(S.RULES.reversal.build, 'rev-v1.0');
  assert.equal(S.RULES.momentum.primary, null);
  assert.throws(() => E.parseVariant('mom-L21-raw'), /six allowed per rule/);
  assert.throws(() => S.scoreMomentumCandidate({ hasBarOnDay: true }), /unknown momentum variant/);
});

// ---- the formula --------------------------------------------------------------------------------------------------------------------
test('momentum score: adjusted return over L sessions that ends 21 sessions before D; vol uses the 60 daily returns to D', () => {
  const closes = walk(SESSIONS.length, 100, 3);
  const rows = rowsOf(closes, { adj: 0.5 });   // adjusted = half the raw: returns are unchanged, so a raw close would be caught
  const s = alignAll(new Map([['X', rows]])).get('X');
  const d = 400;
  const rets = []; for (let i = d - 59; i <= d; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const vol60 = stdev(rets);
  for (const L of [63, 126, 252]) {
    const m = closes[d - 21] / closes[d - 21 - L] - 1;
    assert.ok(Math.abs(E.scoreAt(s, d, E.parseVariant(`mom-L${L}-raw`)) - m) < 1e-12, `raw L${L}`);
    assert.ok(Math.abs(E.scoreAt(s, d, E.parseVariant(`mom-L${L}-vol`)) - m / (vol60 * Math.sqrt(L))) < 1e-12, `vol L${L}`);
  }
});

test('momentum skips the last 21 sessions: changing closes d-20 to d does not move the raw score; a missing needed close gives no score', () => {
  const closes = walk(SESSIONS.length, 100, 4);
  const d = 400;
  const rawScore = cl => E.scoreAt(alignAll(new Map([['X', rowsOf(cl)]])).get('X'), d, E.parseVariant('mom-L126-raw'));
  const a = rawScore(closes);
  const moved = closes.slice(); for (let i = d - 20; i <= d; i++) moved[i] = closes[i] * (i % 2 ? 1.7 : 0.4);
  assert.equal(rawScore(moved), a);
  const edited = closes.slice(); edited[d - 21] = closes[d - 21] * 1.1;
  assert.notEqual(rawScore(edited), a);
  // the oldest close it needs (D-21-L) missing: no score, never a guess
  const rows = rowsOf(closes, { skip: [d - 21 - 126] });
  assert.equal(E.scoreAt(alignAll(new Map([['X', rows]])).get('X'), d, E.parseVariant('mom-L126-raw')), null);
});

test('momentum eligibility: at least L + 22 clean bars; price above 5; no gap in 25 sessions; flags; zero volatility', () => {
  const base = { hasBarOnDay: true, close: 50, features: { m63: 0.1, m126: 0.2, m252: 0.3, vol60: 0.01 } };
  const sc = (extra, variant = 'mom63s') => S.scoreMomentumCandidate({ ...base, variant, ...extra });
  assert.deepEqual(sc({ nBars: 85 }).reasons, []);
  assert.deepEqual(sc({ nBars: 84 }).reasons, ['insufficient_history']);
  assert.deepEqual(sc({ nBars: 274 }, 'mom252s').reasons, []);
  assert.deepEqual(sc({ nBars: 273 }, 'mom252s').reasons, ['insufficient_history']);
  assert.deepEqual(sc({ nBars: 300, close: 5 }).reasons, ['price_not_above_5']);
  assert.deepEqual(sc({ nBars: 300, gap25: true }).reasons, ['bar_gap_25']);
  assert.deepEqual(sc({ nBars: 300, flags: { earnings_in_window: true } }).reasons, ['earnings_in_window']);
  assert.deepEqual(sc({ nBars: 300, flags: { earnings_possible: true } }).reasons, ['earnings_possible']);
  assert.deepEqual(sc({ nBars: 300, features: { ...base.features, vol60: 0 } }).reasons, ['zero_volatility']);
  assert.deepEqual(sc({ nBars: 300, features: { ...base.features, vol60: 0 } }, 'mom63').reasons, [], 'raw does not need the volatility');
  assert.deepEqual(sc({ nBars: 300, features: { ...base.features, m63: null } }).reasons, ['no_features']);
  assert.deepEqual(S.scoreMomentumCandidate({ hasBarOnDay: false, variant: 'mom63' }).reasons, ['no_bar_on_day']);
  assert.ok(Math.abs(sc({ nBars: 300 }).score - 0.1 / (0.01 * Math.sqrt(63))) < 1e-12);
});

// ---- one scorer per rule ------------------------------------------------------------------------------------------------------------
const DI = 400, SIGNALS = [DI, DI + 1, DI + 2];
async function bothPaths() {
  const data = market();
  const members = [...data.keys()].filter(s => s !== 'SPY').sort();
  const L = await makeLearning({ members });
  const ins = L.app.db.stmt('INSERT OR REPLACE INTO bar(symbol, day, open, high, low, close, adj_close, volume, source, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  L.app.db.tx(() => { for (const [sym, rows] of data) for (const r of rows) ins.run(sym, r.day, r.open, r.high, r.low, r.close, r.adj_close, r.volume, 'test', 1); });
  const series = alignAll(data);
  const run = variant => E.runBacktest({
    sessions: SESSIONS, series, benchmark: 'SPY', membersAsOf: () => members, flags: NOFLAGS, variant, topN: 20,
    signalRange: { first: SIGNALS[0], last: SIGNALS.at(-1) }, gridEnd: SESSIONS.length - 1,
  });
  const live = (i, variant) => L.scoring.scoreDay({ day: SESSIONS[i], symbols: members, rule: 'momentum', variant });
  return { run, live, data, L };
}

test('one scorer (momentum): every variant gives identical baskets, ranks and bitwise equal scores in the engine and the live scoring path', async () => {
  const { run, live } = await bothPaths();
  for (const v of E.MOMENTUM_VARIANTS) {
    const id = S.momVariantId(v), r = run(v);
    assert.equal(r.baskets.length, SIGNALS.length, `${v.key}: a full basket every signal day`);
    for (const i of SIGNALS) {
      const day = live(i, id);
      assert.equal(day.build, 'mom-v1.0');
      const liveBasket = day.rows.filter(x => x.inBasket).sort((a, b) => a.rank - b.rank);
      const eng = r.baskets.find(b => b.signalDay === SESSIONS[i]);
      assert.equal(liveBasket.length, 20);
      assert.deepEqual(eng.names.map(n => n.symbol), liveBasket.map(x => x.symbol), `${v.key} basket on ${SESSIONS[i]}`);
      eng.names.forEach((n, k) => assert.equal(n.score, liveBasket[k].score, `${v.key} ${n.symbol}`));
    }
  }
});

test('one scorer (momentum): the engine holds no copy of the formula; both paths call the same functions', () => {
  assert.equal(S.RULES.momentum.scoreCandidate, S.scoreMomentumCandidate);
  assert.equal(S.RULES.momentum.computeFeatures, S.computeMomentumFeatures);
  const src = fs.readFileSync(path.join(__dirname, '../src/core/stockman/trading/engine.js'), 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/vol60|Math\.sqrt|volWindow \* /.test(src.replace(/VOL_WINDOW/g, '')), 'no volatility formula in the engine');
  for (const f of ['learning/shadow.js', 'trading/paper.js']) {
    const t = fs.readFileSync(path.join(__dirname, '../src/core/stockman', f), 'utf8');
    assert.ok(!/vol60/.test(t), `${f} holds no momentum formula`);
  }
});

test('reversal numbers are unchanged by the momentum rule: scoreDay defaults to the reversal rule and build rev-v1.0', async () => {
  const { L, data } = await bothPaths();
  const members = [...data.keys()].filter(s => s !== 'SPY').sort();
  const day = L.scoring.scoreDay({ day: SESSIONS[DI], symbols: members });
  assert.equal(day.build, 'rev-v1.0');
  const x = day.rows.find(r => r.symbol === 'M03');
  const c = data.get('M03').map(r => r.close), d = DI;
  const rets = []; for (let i = d - 19; i <= d; i++) rets.push(c[i] / c[i - 1] - 1);
  assert.ok(Math.abs(x.score - (-(c[d] / c[d - 5] - 1) / (stdev(rets) * Math.sqrt(5)))) < 1e-12);
  assert.throws(() => L.scoring.scoreDay({ day: SESSIONS[DI], symbols: members, rule: 'momentum' }), /no primary variant/);
});

// ---- the backtest tool: per-rule counter, cross-rule total, long-history refusal ----------------------------------------------------
async function btApp({ start }) {
  const bars = createBars({});
  const m = market();
  const members = [...m.keys()].filter(s => s !== 'SPY');
  const data = {
    universe: { membersAsOf: () => ({ sp500: { snapshotAsOf: '2020-01-01', kind: 'history', symbols: members }, ndx100: null }) },
    earnings: { flags: NOFLAGS },
  };
  const end = SESSIONS[780];
  const trading = createTradingLayer({ data, options: { backtest: { start, end, holdoutWindows: 10, boot: { reps: 200 } } } });
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile: ':memory:', log: () => {}, provider: createMockProvider({}) });
  app.use(bars.feature);
  for (const f of trading.features) app.use(f);
  await app.start();
  const ins = app.db.stmt('INSERT INTO bar(symbol, day, open, high, low, close, adj_close, volume, source, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  app.db.tx(() => { for (const [sym, rows] of m) for (const r of rows) ins.run(sym, r.day, r.open, r.high, r.low, r.close, r.adj_close, r.volume, 'test', 0); });
  return { app, bt: trading.api.backtest, ledger: trading.api.ledger };
}

test('tool: a momentum run is counted per rule, prints the cross-rule total, and says the survivorship bias direction is unknown', async () => {
  const { app, bt, ledger } = await btApp({ start: SESSIONS[300] });
  const r = bt.run({ variant: 'mom-L63-raw' });
  assert.equal(r.rule, 'momentum'); assert.equal(r.buildId, 'mom-v1.0/L63/raw');
  assert.equal(r.variantsTried, 1); assert.equal(r.variantsAllowed, 6);
  assert.equal(r.variantsAcrossRules, 7, 'the reversal rule used 6 before (CL-0047), plus this one');
  assert.ok(r.summary.windows > 40);
  const rows = ledger.list({ source: 'backtest', limit: 100000 });
  assert.ok(rows.length > 0 && rows.every(x => x.scoring_build === 'mom-v1.0/L63/raw'));
  const text = formatResult(r);
  assert.match(text, /Variants tried: 1 of 6 momentum variants, 7 variants across both rules/);
  assert.match(text, /DIRECTION of the bias is UNKNOWN/); assert.doesNotMatch(text, /BETTER than a complete data set/);
  assert.match(text, /Tuning period only. The holdout was not touched/);
  assert.equal(app.db.stmt("SELECT COUNT(*) AS n FROM backtest_run WHERE period = 'holdout'").get().n, 0);
  await app.stop();
});

test('tool: the counter is per rule; all six momentum variants make "6 of 6 momentum, 12 across both rules"; reversal results are unchanged', async () => {
  const { app, bt } = await btApp({ start: SESSIONS[300] });
  assert.equal(bt.run({ variant: 'rev-L5-vol' }).variantsTried, 1, 'a reversal run still counts reversal variants only');
  let last;
  for (const v of E.MOMENTUM_VARIANTS) last = bt.run({ variant: v.key });
  assert.equal(last.variantsTried, 6); assert.equal(last.variantsAllowed, 6); assert.equal(last.variantsAcrossRules, 12);
  assert.match(formatResult(last), /6 of 6 momentum variants, 12 variants across both rules/);
  const st = bt.status();
  assert.deepEqual(st.byRule, { reversal: 1, momentum: 6 }); assert.equal(st.variantsTried, 7); assert.equal(st.variantsAcrossRules, 12);
  assert.equal(bt.run({ variant: 'mom-L63-raw' }).variantsTried, 6, 'the same variant again is not a new trial');
  await app.stop();
});

test('tool: a rule that needs more history than the data holds is refused, not shortened, and the refused attempt uses no trial', async () => {
  const { app, bt } = await btApp({ start: SESSIONS[150] });   // first signal index 150: 151 sessions exist, L=252 needs 274, L=63 needs 85
  assert.throws(() => bt.run({ variant: 'mom-L252-raw' }), /needs 274 sessions/);
  assert.equal(bt.status().byRule.momentum, 0, 'nothing was logged for the refused variant');
  assert.equal(bt.run({ variant: 'mom-L126-vol' }).variantsTried, 1, 'L=126 needs 148 sessions and has 151');
  assert.equal(bt.run({ variant: 'mom-L63-vol' }).variantsTried, 2);
  await app.stop();
});

// ---- data start dates ---------------------------------------------------------------------------------------------------------------
test('data: daily bars start 2019-01-01 (L = 252 needs 274 sessions before 2020-03-02); earnings keep 2019-10-01; older fetches are pending again', async () => {
  const { createDataLayer, HISTORY_FROM, EARNINGS_FROM } = require('../src/core/stockman/features');
  assert.equal(HISTORY_FROM, '2019-01-01'); assert.equal(EARNINGS_FROM, '2019-10-01');
  assert.ok(tradingDays(HISTORY_FROM, '2020-03-01').length >= 273, 'enough sessions before the first signal day 2020-03-02');
  const layer = createDataLayer({ fetcher: { getText() {} } });
  assert.equal(layer.api.earnings.options.historyFrom, '2019-10-01', 'earnings are not fetched again for the earlier days');
  assert.equal(createDataLayer({ fetcher: { getText() {} }, historyFrom: '2021-01-04' }).api.earnings.options.historyFrom, '2021-01-04', 'a later explicit start still wins');
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile: ':memory:', log: () => {}, provider: createMockProvider({}) });
  const bars = createBars({});
  app.use(bars.feature);
  await app.start();
  app.db.stmt("INSERT INTO bar_history(symbol, status, from_day, n, missing_n, attempts, fetched_at) VALUES ('AAA','ok','2019-10-01',10,0,1,0),('GONE','not_found','2019-10-01',0,0,1,0)").run();
  assert.deepEqual(bars.api.deepPending({ symbols: ['AAA', 'GONE'], from: '2019-10-01' }), []);
  assert.deepEqual(bars.api.deepPending({ symbols: ['AAA', 'GONE'], from: HISTORY_FROM }).sort(), ['AAA', 'GONE'], 'fetched from a later start: pending again');
  await app.stop();
});
