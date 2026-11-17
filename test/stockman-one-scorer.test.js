// One scorer (vault CL-0046): the live shadow feature (learning/scoring.js scoreDay) and the backtest engine (trading/engine.js runBacktest) must give
// identical scores, ranks and baskets on the same bars. The engine now calls the learning code; this test is the guard that keeps it so.
// Golden fixture: 30 drop symbols with a tie that straddles rank 20 / 21, plus one symbol for each way a candidate can be ineligible.
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/core/stockman/trading/engine');
const S = require('../src/core/stockman/learning/scoring');
const { makeLearning, tradingDays } = require('./helpers/stockman-learning');

const SESSIONS = tradingDays('2026-01-02', '2026-07-31');
const INDEX = new Map(SESSIONS.map((d, i) => [d, i]));
const DI = 100;                       // the signal day index of the golden day
const SIGNALS = [DI, DI + 1, DI + 2, DI + 3, DI + 4];

// closes: alternating +-0.5% up to index 95, a total drop of `drop` over indexes 96..100 (so r5 on DI is about -drop), alternating again after
function closesOf(start, drop, { flat = false } = {}) {
  const c = [start];
  for (let i = 1; i < SESSIONS.length; i++) {
    const r = flat ? 0 : i <= 95 ? (i % 2 ? 0.005 : -0.005) : i <= DI ? -drop / 5 : (i % 2 ? 0.005 : -0.005);
    c.push(c[i - 1] * (1 + r));
  }
  return c;
}
// the bar rows: open = 0.999 close, adjusted close = 0.98 close (as the shared test helper writes them); mods change single bars
function rowsOf(closes, { from = 0, skip = [], mods = {} } = {}) {
  const rows = [];
  closes.forEach((c, i) => {
    if (i < from || skip.includes(i)) return;
    rows.push({ day: SESSIONS[i], open: c * 0.999, high: c * 1.01, low: c * 0.99, close: c, adj_close: c * 0.98, volume: 1000, ...(mods[i] || {}) });
  });
  return rows;
}

const FLAGS = { EARN: { earnings_in_window: true, earnings_possible: false, earnings_data: 'confirmed' }, EARNP: { earnings_in_window: false, earnings_possible: true, earnings_data: 'estimated' } };
const CLEAR = { earnings_in_window: false, earnings_possible: false, earnings_data: 'confirmed' };
const flagsFor = symbol => FLAGS[symbol] || CLEAR;

function fixture() {
  const m = new Map();
  // 30 drop symbols; D10 and D11 have the same drop and the same start price, so they tie exactly (the tie sits at rank 20 and 21)
  for (let k = 0; k < 30; k++) m.set(`D${String(k).padStart(2, '0')}`, rowsOf(closesOf(20 + (k === 11 ? 10 : k), 0.01 + 0.002 * (k === 11 ? 10 : k))));
  m.set('DIRTY', rowsOf(closesOf(30, 0.15), { mods: { 97: { low: 0 } } }));       // a present bar that is not clean: still eligible by the shared rule
  m.set('SHORT', rowsOf(closesOf(30, 0.15), { from: 70 }));                       // 31 bars to the signal day
  m.set('GAP', rowsOf(closesOf(30, 0.15), { skip: [90] }));                       // a missing bar inside the last 25 sessions
  m.set('NOADJ', rowsOf(closesOf(30, 0.15), { mods: { 98: { adj_close: null } } })); // no adjusted close inside the volatility window
  m.set('NODAY', rowsOf(closesOf(30, 0.15), { skip: [DI] }));                     // no bar on the signal day
  m.set('FLAT', rowsOf(closesOf(30, 0, { flat: true })));                         // zero volatility
  m.set('CHEAP', rowsOf(closesOf(4, 0.15)));                                      // close at or below USD 5
  m.set('EARN', rowsOf(closesOf(30, 0.2)));                                       // earnings inside the window
  m.set('EARNP', rowsOf(closesOf(30, 0.19)));                                     // earnings possible
  m.set('SPY', rowsOf(closesOf(400, 0.005)));
  return m;
}
const MEMBERS = [...fixture().keys()].filter(s => s !== 'SPY').sort();

async function bothPaths() {
  const L = await makeLearning({ members: MEMBERS });
  const ins = L.app.db.stmt('INSERT OR REPLACE INTO bar(symbol, day, open, high, low, close, adj_close, volume, source, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const data = fixture();
  L.app.db.tx(() => { for (const [sym, rows] of data) for (const r of rows) ins.run(sym, r.day, r.open, r.high, r.low, r.close, r.adj_close, r.volume, 'test', 1); });
  const series = new Map([...data].map(([sym, rows]) => [sym, E.alignSeries(SESSIONS, INDEX, rows)]));
  const run = variant => E.runBacktest({
    sessions: SESSIONS, series, benchmark: 'SPY', membersAsOf: () => MEMBERS, flags: ({ symbol }) => flagsFor(symbol), variant,
    signalRange: { first: SIGNALS[0], last: SIGNALS.at(-1) }, gridEnd: SESSIONS.length - 1,
  });
  const day = i => L.scoring.scoreDay({ day: SESSIONS[i], symbols: MEMBERS, flagsOf: flagsFor });
  return { L, run, day };
}

test('one scorer: the primary variant gives identical baskets, ranks and scores in the engine and the live scoring path', async () => {
  const { run, day } = await bothPaths();
  const r = run({ lookback: 5, volScale: true });
  assert.equal(r.baskets.length, SIGNALS.length, 'a full basket on every signal day');
  for (const i of SIGNALS) {
    const live = day(i);
    const liveBasket = live.rows.filter(x => x.inBasket).sort((a, b) => a.rank - b.rank);
    const eng = r.baskets.find(b => b.signalDay === SESSIONS[i]);
    assert.deepEqual(eng.names.map(n => n.symbol), liveBasket.map(x => x.symbol), `basket and order on ${SESSIONS[i]}`);
    eng.names.forEach((n, k) => assert.equal(n.score, liveBasket[k].score, `bitwise equal score for ${n.symbol} on ${SESSIONS[i]}`));
    assert.equal(liveBasket.length, 20);
  }
});

test('one scorer: the golden day has the tie at rank 20 and 21 and each ineligible case, and both paths agree on all of it', async () => {
  const { run, day } = await bothPaths();
  const live = day(DI);
  const by = Object.fromEntries(live.rows.map(x => [x.symbol, x]));
  // the tie: D10 and D11 have exactly the same score; the symbol breaks it (D10 first), so D10 is in the basket and D11 is the 21st
  assert.equal(by.D10.score, by.D11.score);
  assert.equal(by.D10.rank, 20); assert.equal(by.D11.rank, 21);
  assert.equal(by.D10.inBasket, true); assert.equal(by.D11.inBasket, false);
  const eng = run({ lookback: 5, volScale: true }).baskets.find(b => b.signalDay === SESSIONS[DI]).names.map(n => n.symbol);
  assert.ok(eng.includes('D10') && !eng.includes('D11'));
  // the ineligible cases and why (the live path's reasons)
  assert.deepEqual(by.SHORT.reasons, ['insufficient_history']);
  assert.deepEqual(by.GAP.reasons, ['bar_gap_25', 'no_features']);   // the missing bar also breaks the 20-return volatility window
  assert.deepEqual(by.NOADJ.reasons, ['no_features']);
  assert.deepEqual(by.NODAY.reasons, ['no_bar_on_day']);
  assert.deepEqual(by.FLAT.reasons, ['zero_volatility']);
  assert.deepEqual(by.CHEAP.reasons, ['price_not_above_5']);
  assert.deepEqual(by.EARN.reasons, ['earnings_in_window']);
  assert.deepEqual(by.EARNP.reasons, ['earnings_possible']);
  assert.equal(by.DIRTY.eligible, true, 'a present bar with a bad low is a clean-bar miss but not a gap, so the symbol is still scored');
  for (const bad of ['SHORT', 'GAP', 'NOADJ', 'NODAY', 'FLAT', 'CHEAP', 'EARN', 'EARNP']) assert.ok(!eng.includes(bad), `${bad} is not in the engine basket`);
  assert.ok(eng.includes('DIRTY'));
});

test('one scorer: the engine counts the same exclusions and the same eligible numbers as the live path, per day and in total', async () => {
  const { run, day } = await bothPaths();
  const r = run({ lookback: 5, volScale: true });
  const want = { no_bar_on_day: 0, short_history: 0, gap_25: 0, price_at_or_below_5: 0, bad_volatility: 0, earnings_in_window: 0, earnings_possible: 0 };
  for (const i of SIGNALS) {
    const live = day(i);
    for (const x of live.rows) {
      if (x.reasons.includes('no_bar_on_day')) want.no_bar_on_day++;
      else if (x.reasons.includes('insufficient_history')) want.short_history++;
      else if (x.reasons.includes('bar_gap_25')) want.gap_25++;
      else if (x.reasons.includes('price_not_above_5')) want.price_at_or_below_5++;
      else if (x.reasons.includes('no_features') || x.reasons.includes('zero_volatility')) want.bad_volatility++;
    }
    // earnings: only counted for names the engine walks past on its way to 20, so compare the eligible count (before the earnings rule) instead
    const beforeEarnings = live.rows.filter(x => x.score !== null && x.reasons.every(q => q.startsWith('earnings_'))).length;
    assert.equal(r.days.find(d => d.day === SESSIONS[i]).eligible, beforeEarnings, `eligible before earnings on ${SESSIONS[i]}`);
  }
  for (const k of Object.keys(want)) if (!k.startsWith('earnings')) assert.equal(r.totals.excludedBy[k], want[k], k);
  assert.ok(r.totals.excludedBy.earnings_in_window >= SIGNALS.length, 'EARN is walked past on every day');
});

test('one scorer: every variant scores the same in both paths, and each variant ranks and fills a full basket', async () => {
  const { run, day } = await bothPaths();
  for (const v of E.ALL_VARIANTS) {
    const id = S.variantId(v);
    const r = run(v);
    for (const i of SIGNALS) {
      const live = day(i), by = Object.fromEntries(live.rows.map(x => [x.symbol, x]));
      const b = r.baskets.find(x => x.signalDay === SESSIONS[i]);
      assert.equal(b.names.length, 20, `${v.key} fills 20 on ${SESSIONS[i]}`);
      for (const n of b.names) assert.equal(n.score, by[n.symbol].variants[id], `${v.key} ${n.symbol} ${SESSIONS[i]}`);
      for (let k = 1; k < b.names.length; k++) assert.ok(b.names[k - 1].score >= b.names[k].score, 'the basket is in rank order');
    }
  }
});

test('one scorer: the build id is the rule\'s, the engine variants match the scoring variants, and the engine has no formula of its own', () => {
  assert.equal(E.SCORING_BUILD, S.SCORING_BUILD);
  assert.equal(E.buildId(E.parseVariant('rev-L5-vol')), `${S.SCORING_BUILD}/L5/vol`);
  assert.deepEqual(E.ALL_VARIANTS.map(v => S.variantId(v)).sort(), S.VARIANTS.map(v => v.id).sort());
  const src = require('node:fs').readFileSync(require.resolve('../src/core/stockman/trading/engine.js'), 'utf8');
  assert.ok(!/Math\.sqrt\(/.test(src.replace(/\/\/.*$/gm, '')), 'no square root, so no volatility formula, in the engine');
  assert.ok(!/stdev\(/.test(src.replace(/\/\/.*$/gm, '')), 'no standard deviation in the engine');
});

test('one scorer: JavaScript and SQL agree on what a clean bar is', async () => {
  const L = await makeLearning({ members: [] });
  const cases = [
    { open: 1, high: 2, low: 1, close: 1.5, adj_close: 1.4, volume: 10 }, { open: 1, high: 2, low: 0, close: 1.5, adj_close: 1.4, volume: 10 },
    { open: 0, high: 2, low: 1, close: 1.5, adj_close: 1.4, volume: 10 }, { open: 1, high: 1, low: 2, close: 1.5, adj_close: 1.4, volume: 10 },
    { open: 1, high: 2, low: 1, close: 1.5, adj_close: null, volume: 10 }, { open: 1, high: 2, low: 1, close: 1.5, adj_close: 1.4, volume: -1 },
    { open: 1, high: 2, low: 1, close: 0, adj_close: 1.4, volume: 10 }, { open: 1, high: 2, low: 1, close: 1.5, adj_close: 1.4, volume: 0 },
  ];
  for (const c of cases) {
    const sql = L.app.db.raw.prepare(`SELECT (${S.CLEAN_SQL}) AS ok FROM (SELECT ? AS open, ? AS high, ? AS low, ? AS close, ? AS adj_close, ? AS volume)`).get(c.open, c.high, c.low, c.close, c.adj_close, c.volume).ok;
    assert.equal(Boolean(sql), S.isCleanBar(c), JSON.stringify(c));
  }
});
