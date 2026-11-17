// The sandbox strategy track (vault D28, CL-0071): the strategy file (schema, hash, hot reload), the engine (signals reuse learning/scoring.js, regime,
// weights, rebalance calendar), the scheduler (plan, dry run, three switches, risk limits, kill switch, idempotent orders, fills into the ledger), the tuner
// (one step at a time, adoption rules, the holdout never read) and that sandbox rows never reach the shadow log or the opener. Network mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStockman } = require('../src/core/stockman/app');
const { createMockProvider } = require('../src/core/stockman/stocks/mock');
const { createBars } = require('../src/core/stockman/features/bars');
const { createLearningLayer } = require('../src/core/stockman/learning');
const { createTradingLayer } = require('../src/core/stockman/trading');
const { createBrokerRouter } = require('../src/core/stockman/trading/broker-router');
const S = require('../src/core/stockman/learning/scoring');
const E = require('../src/core/stockman/trading/engine');
const SB = require('../src/core/stockman/trading/sandbox/strategy');
const SE = require('../src/core/stockman/trading/sandbox/engine');
const { createSandbox } = require('../src/core/stockman/trading/sandbox/sandbox');
const { createTuner, candidatesOf } = require('../src/core/stockman/trading/sandbox/tuner');
const { clock, putBars, walk, tradingDays } = require('./helpers/stockman-learning');

const SESSIONS = tradingDays('2023-01-03', '2026-12-31');
const INDEX = new Map(SESSIONS.map((d, i) => [d, i]));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stockman-sbx-'));
const SYMS = Array.from({ length: 40 }, (_, i) => `S${String(i).padStart(2, '0')}`);
const priceOf = new Map([...SYMS, 'SPY'].map((s, k) => [s, walk(s, s === 'SPY' ? 400 : 30 + k * 3, s === 'SPY' ? 0.006 : 0.014)]));
const small = () => { const s = JSON.parse(JSON.stringify(SB.PRESET)); Object.assign(s.signals.momentum, { lookback: 63, skip: 5 }); s.signals.trend.days = 50; s.regime.days = 50; s.portfolio.topN = 8; s.portfolio.rebalance = 'monthly:first'; s.risk = { ...s.risk, capitalUsd: 4000, maxPositionPct: 20, maxPositions: 10, maxOrderNotionalUsd: 1000 }; s.execution.dryRun = false; s.universe = { ...s.universe, minPrice: 5, minAvgDollarVolume: 0, excludeEarningsDays: 0 }; return s; };

// ---- the strategy file -------------------------------------------------------------------------------------------------------------------
test('strategy: the preset is valid; unknown keys, bad values and cross-field mistakes are refused with their path; omitted keys come from the preset', () => {
  assert.equal(SB.normalize(SB.PRESET).ok, true);
  const bad = SB.normalize({ portfolio: { topN: 0, rebalance: 'sometimes' }, risk: { maxPositions: 3 }, typo: 1, signals: { momentum: { weight: -1 }, fancy: {} } });
  assert.equal(bad.ok, false);
  for (const m of [/portfolio\.topN/, /portfolio\.rebalance/, /unknown key "typo"/, /signals\.momentum\.weight/, /unknown signal "fancy"/, /maxPositions \(3\) must be at least portfolio\.topN/]) assert.ok(bad.errors.some(e => m.test(e)), String(m));
  const part = SB.normalize({ portfolio: { topN: 7 } });
  assert.equal(part.ok, true); assert.equal(part.value.portfolio.topN, 7); assert.equal(part.value.signals.trend.days, 200);
  assert.equal(SB.normalize({ signals: { momentum: { enabled: false }, trend: { enabled: false }, lowVol: { enabled: false } } }).ok, false, 'at least one signal');
  assert.equal(SB.normalize({ tuning: { params: { 'signals.nope.x': { min: 1, max: 2, step: 1 } } } }).ok, false);
  assert.equal(SB.normalize({ tuning: { params: { 'risk.capitalUsd': { min: 1, max: 2, step: 1 } } } }).ok, true, 'risk numbers can be tuned');
  assert.equal(SB.normalize({ enabled: true, orders: true }).ok, false, 'the file has no key that could switch trading on');
});

test('strategy: the hash ignores key order and changes with a value; diff lists the changed paths', () => {
  const a = SB.normalize(SB.PRESET).value, b = JSON.parse(JSON.stringify(a)), c = JSON.parse(JSON.stringify(a));
  c.portfolio.topN = 16;
  const reordered = Object.fromEntries(Object.entries(b).reverse());
  assert.equal(SB.hashOf(a), SB.hashOf(reordered)); assert.notEqual(SB.hashOf(a), SB.hashOf(c));
  assert.match(SB.buildIdOf(a), /^sbx-[0-9a-f]{8}$/);
  assert.deepEqual(SB.diff(a, c), [['portfolio.topN', 15, 16]]);
});

test('store: writes the preset when the file is missing; reloads when it changes; a bad edit is refused and the LAST GOOD version keeps running; a good edit recovers; save validates', () => {
  const file = path.join(tmp(), 'stockman.strategy.json'), lines = [];
  const store = SB.createStrategyStore({ file, log: l => lines.push(l) });
  const first = store.load();
  assert.ok(fs.existsSync(file) && first.hash && first.strategy.execution.dryRun === true && first.error === null);
  assert.equal(store.check().changed, false);
  const edited = JSON.parse(fs.readFileSync(file, 'utf8')); edited.portfolio.topN = 12;
  fs.writeFileSync(file, JSON.stringify(edited));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const r = store.check();
  assert.equal(r.changed, true); assert.equal(r.strategy.portfolio.topN, 12); assert.notEqual(r.hash, first.hash);
  const good = r.hash;
  fs.writeFileSync(file, '{ "portfolio": { "topN": "many" } }'); fs.utimesSync(file, new Date(), new Date(Date.now() + 9000));
  const bad = store.check();
  assert.equal(bad.hash, good, 'the last good version keeps running'); assert.equal(bad.strategy.portfolio.topN, 12); assert.match(bad.error.errors[0], /portfolio\.topN/);
  assert.ok(lines.some(l => /refused/.test(l) && /last good version keeps running/.test(l)));
  fs.writeFileSync(file, '{ not json'); fs.utimesSync(file, new Date(), new Date(Date.now() + 12000));
  assert.match(store.check().error.errors[0], /not valid JSON/);
  fs.writeFileSync(file, JSON.stringify({ portfolio: { topN: 9 } })); fs.utimesSync(file, new Date(), new Date(Date.now() + 15000));
  const ok = store.check();
  assert.equal(ok.error, null); assert.equal(ok.strategy.portfolio.topN, 9);
  assert.throws(() => store.save({ portfolio: { topN: 0 } }), /refused to write an invalid strategy/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).portfolio.topN, 9, 'an invalid save leaves the file as it was');
  assert.equal(store.save({ portfolio: { topN: 11 } }).strategy.portfolio.topN, 11);
});

// ---- the engine --------------------------------------------------------------------------------------------------------------------------
function aligned(symbolsRows) { return new Map([...symbolsRows].map(([s, rows]) => [s, E.alignSeries(SESSIONS, INDEX, rows)])); }
const rowsOf = (sym, upTo = SESSIONS.length) => { const f = priceOf.get(sym), rows = []; for (let i = 0; i < upTo; i++) { const c = f(i); rows.push({ day: SESSIONS[i], open: c * 0.999, high: c * 1.01, low: c * 0.99, close: c, adj_close: c, volume: 1000000 }); } return rows; };

test('engine: the momentum signal is the formula of learning/scoring.js (skip 21, 126 sessions, volatility scaled), z-scored; targets are ranked with ties by symbol', () => {
  const series = aligned(new Map([...SYMS, 'SPY'].map(s => [s, rowsOf(s)])));
  const d = 600, st = small();
  st.signals = { momentum: { enabled: true, weight: 1, lookback: 126, skip: 21, volScale: true }, reversal: { enabled: false, weight: 0, lookback: 5, volScale: true }, trend: { enabled: false, weight: 0, days: 50 }, lowVol: { enabled: false, weight: 0, days: 60 } };
  const sess = SESSIONS.slice(0, d + 1);
  const mom = sym => { const f = S.computeMomentumFeatures({ sessions: sess.slice(-274), adjOn: day => series.get(sym).adj[INDEX.get(day)] }); return S.momentumVariantScores(f).mom126s; };
  const raw = SYMS.map(s => SE.signalsOf(st, series.get(s), d).momentum);
  SYMS.forEach((s, i) => assert.ok(Math.abs(raw[i] - mom(s)) < 1e-12, `${s}: the same number as the momentum rule`));
  const z = SE.zscores(raw);
  assert.ok(Math.abs(z.reduce((a, b) => a + b, 0)) < 1e-9);
  const plan = SE.buildTargets(st, { d, members: SYMS, series, bench: series.get('SPY') });
  assert.equal(plan.targets.length, 8);
  const order = SYMS.map((s, i) => [s, z[i]]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 8).map(x => x[0]);
  assert.deepEqual(plan.targets.map(t => t.symbol), order);
  const again = SE.buildTargets(st, { d, members: [...SYMS].reverse(), series, bench: series.get('SPY') });
  assert.deepEqual(again.targets.map(t => t.symbol), order, 'input order never changes the result');
});

test('engine: other signals, a missing history leaves a symbol out (counted), invVol with the per-name cap spreads the excess, regime halfSize and cash', () => {
  const rows = new Map([...SYMS, 'SPY'].map(s => [s, rowsOf(s)]));
  rows.set('NEW', rowsOf('S01').slice(571, 601));                 // 30 bars ending at the signal day: a short history
  const series = aligned(rows), d = 600, st = small();
  st.signals.reversal = { enabled: true, weight: 0.5, lookback: 5, volScale: true }; st.signals.lowVol.weight = 0.2;
  const p = SE.buildTargets(st, { d, members: [...SYMS, 'NEW', 'GHOST'], series, bench: series.get('SPY') });
  assert.equal(p.counts.history, 1); assert.equal(p.counts.noBars, 1); assert.equal(p.counts.scored, 40);
  const gross = p.targets.reduce((a, t) => a + t.notionalUsd, 0);
  assert.ok(gross <= st.risk.capitalUsd + 0.5 && p.targets.every(t => t.notionalUsd <= st.risk.capitalUsd * 0.2 + 0.01), 'no name above maxPositionPct');
  const inv = JSON.parse(JSON.stringify(st)); inv.portfolio.weighting = 'invVol'; inv.risk.maxPositionPct = 14; inv.regime.enabled = false;
  const q = SE.buildTargets(inv, { d, members: SYMS, series, bench: series.get('SPY') });
  assert.ok(q.targets.every(t => t.notionalUsd <= 4000 * 0.14 + 0.01));
  assert.ok(Math.abs(q.targets.reduce((a, t) => a + t.notionalUsd, 0) - 4000) < 1, 'the excess above the cap went to the other names, so the book is still full');
  const eq = JSON.parse(JSON.stringify(st)); eq.portfolio.weighting = 'equal';
  assert.ok(SE.buildTargets(eq, { d, members: SYMS, series, bench: series.get('SPY') }).targets.every(t => Math.abs(t.weight - 1 / 8) < 1e-9));
  // regime: a SPY that fell below its average
  const down = new Map(rows); down.set('SPY', rowsOf('SPY').map((r, i) => (i > 560 ? { ...r, close: r.close * 0.5, adj_close: r.adj_close * 0.5 } : r)));
  const ds = aligned(down);
  const half = SE.buildTargets(st, { d, members: SYMS, series: ds, bench: ds.get('SPY') });
  assert.equal(half.regime.factor, 0.5);
  const offS = JSON.parse(JSON.stringify(st)); offS.regime.enabled = false;
  const fullSum = SE.buildTargets(offS, { d, members: SYMS, series: ds, bench: ds.get('SPY') }).targets.reduce((a, t) => a + t.notionalUsd, 0);
  assert.ok(Math.abs(half.targets.reduce((a, t) => a + t.notionalUsd, 0) - fullSum / 2) < 1, 'halfSize holds half the book');
  const cash = JSON.parse(JSON.stringify(st)); cash.regime.below = 'cash';
  const c0 = SE.buildTargets(cash, { d, members: SYMS, series: ds, bench: ds.get('SPY') });
  assert.equal(c0.regime.factor, 0); assert.equal(c0.targets.length, 0);
  const off = JSON.parse(JSON.stringify(st)); off.regime.enabled = false;
  assert.equal(SE.buildTargets(off, { d, members: SYMS, series: ds, bench: ds.get('SPY') }).regime.factor, 1);
});

test('engine: the rebalance calendar (daily, weekly day, first and last trading day of the month; live uses the calendar for the next session)', () => {
  const days = tradingDays('2026-10-26', '2026-12-04');
  const hits = rule => days.map((d, i) => [d, SE.isRebalanceDay(rule, days, i)]).filter(x => x[1]).map(x => x[0]);
  assert.equal(hits('daily').length, days.length);
  assert.deepEqual(hits('monthly:first'), ['2026-10-26', '2026-11-02', '2026-12-01']);
  assert.deepEqual(hits('monthly:last'), ['2026-10-30', '2026-11-30', '2026-12-04']);
  assert.ok(hits('weekly:wed').every(d => new Date(`${d}T00:00:00Z`).getUTCDay() === 3));
  assert.equal(SE.isRebalanceDay('monthly:last', ['2026-11-30'], 0, '2026-12-01'), true);
  assert.equal(SE.isRebalanceDay('monthly:last', ['2026-11-12'], 0, '2026-11-13'), false);
});

// ---- the scheduler -----------------------------------------------------------------------------------------------------------------------
const D = '2026-11-13', ENTRY = '2026-11-16';
async function make({ strategy = small(), sandboxOn = true, equity = 100000 } = {}) {
  const dir = tmp(), shadowNow = clock('2026-11-13T22:00:00Z');
  const app = createStockman({ env: {}, dataDir: dir, dbFile: ':memory:', log: () => {}, provider: createMockProvider({ bars: {}, ranges: ['1mo'], intervals: ['1d'], now: shadowNow }), now: shadowNow, sleep: async () => {} });
  const bars = createBars({ now: shadowNow, sleep: async () => {} });
  const data = { bars: bars.api, universe: { membersAsOf: () => ({ sp500: { snapshotAsOf: '2026-10-01', kind: 'history', symbols: [...SYMS], }, ndx100: null }) },
    runs: { getRun: day => ({ run_id: `run-${day}`, trade_day: day, state: 'ingested' }) }, earnings: { flags: () => ({ earnings_in_window: false, earnings_possible: false, earnings_data: 'confirmed' }) } };
  const learning = createLearningLayer({ data, now: shadowNow, autoRun: false, options: { shadow: { momentum: false } } });
  const trading = createTradingLayer({ data: { ...data, ...learning.api }, now: shadowNow, options: { paper: { enabled: false, autoRun: false } } });
  const orders = [], filled = new Map(), sent = [], acct = { equity };
  let policyDown = false;
  const alpaca = {
    options: { maxNotionalUsd: 1000 },
    async account() { return { equity: acct.equity }; },
    async stockMid() { return 100; },
    async placeOrder(a) {
      if (policyDown) { const { PolicyError } = require('../src/core/stockman/errors'); throw new PolicyError('alpaca: broker lookups are off'); }
      const dup = orders.find(o => o.clientOrderId === a.clientId); sent.push({ ...a, dup: Boolean(dup) });
      if (dup) return { ...dup, duplicate: true };
      const o = { id: `ord-${a.clientId}`, clientOrderId: a.clientId, symbol: a.symbol, side: a.leg === 'entry' ? 'buy' : 'sell', status: 'new', filledQty: null, filledAvgPrice: null, filledAt: null };
      orders.push(o); return { ...o, duplicate: false };
    },
    async listOrders() { return orders.map(o => (filled.has(o.clientOrderId) ? { ...o, ...filled.get(o.clientOrderId), status: 'filled' } : o)); },
  };
  const file = path.join(dir, 'stockman.strategy.json');
  fs.writeFileSync(file, JSON.stringify(strategy));
  const store = SB.createStrategyStore({ file });
  let t = Date.parse('2026-11-13T22:30:00Z');                     // 17:30 New York on D, after the close and the plan time
  const events = [];
  const sandbox = createSandbox({ ledger: trading.api.ledger, alpaca, data, store, stateFile: path.join(dir, 'sbx-state.json'), now: () => t, events: { append: e => events.push(e) }, opts: { enabled: () => sandboxOn, autoRun: false } });
  app.use(bars.feature);
  for (const f of [...learning.features, ...trading.features, sandbox.feature]) app.use(f);
  await app.start();
  for (const s of [...SYMS, 'SPY']) putBars(app, s, SESSIONS.filter(d => d <= '2026-11-30'), { price: priceOf.get(s), factor: () => 1 });
  const lastBar = () => bars.api.lastBarDay();
  data.bars.lastBarDay = () => D;
  return { app, dir, store, sandbox: sandbox.api, ledger: trading.api.ledger, shadow: learning.api.shadow, orders, sent, filled, acct, events, at: iso => { t = Date.parse(iso); }, down: v => { policyDown = v; }, on: v => { sandboxOn = v; }, file, trading, learning, alpaca, data,
    list: () => trading.api.ledger.list({ source: 'broker-paper', limit: 100000 }).filter(p => p.scoring_build.startsWith('sbx-')) };
}
const fillAll = (X, leg, price, qty, iso) => { for (const p of X.list()) { const key = leg === 'entry' ? 'sbx' : 'xit'; const m = new RegExp(`${key}=(\\S+)`).exec(p.note || ''); if (m) X.filled.set(m[1], { filledAvgPrice: price, filledQty: qty, filledAt: iso }); } };

test('scheduler: after the close it plans, the first build is a rebalance, and with dryRun true NOTHING is sent (the plan is stored and shown)', async () => {
  const st = small(); st.execution.dryRun = true;
  const X = await make({ strategy: st });
  let r = await X.sandbox.step();
  assert.equal(r.planned.orders, 8); assert.equal(r.plan.firstBuild, true); assert.equal(r.plan.dryRun, true);
  assert.equal(X.sandbox.readState().lastPlanDay, D);
  X.at('2026-11-16T14:35:00Z');                                         // 09:35 on the entry day
  r = await X.sandbox.step();
  assert.equal(r.exec.status, 'dry-run'); assert.equal(X.sent.length, 0); assert.equal(X.list().length, 0);
  assert.match(X.sandbox.health().summary, /DRY RUN, no orders sent/); assert.match(X.sandbox.health().summary, /sandbox, user-edited, not evidence of an edge/);
  await X.app.stop();
});

test('scheduler: live paper: orders go out once each in the first half hour, with client ids, a ledger position with the strategy hash and a JSON copy; a second step sends nothing', async () => {
  const X = await make();
  await X.sandbox.step();
  X.at('2026-11-16T14:35:00Z');
  const r = await X.sandbox.step();
  assert.deepEqual([r.exec.status, r.exec.sent, r.exec.failed], ['sent', 8, 0]);
  assert.equal(X.sent.length, 8);
  assert.ok(X.sent.every(s => s.leg === 'entry' && s.timeInForce === 'day' && /^sm-sbx-2026-11-13-S\d\d-entry$/.test(s.clientId) && s.notionalUsd > 0 && s.notionalUsd <= 1000));
  const ps = X.list(), hash = X.store.state().hash;
  assert.equal(ps.length, 8);
  assert.ok(ps.every(p => p.scoring_build === `sbx-${hash}` && p.source === 'broker-paper' && p.note.includes(`strategy=${hash}`) && /json=\{/.test(p.note) && JSON.parse(p.note.split('json=')[1]).portfolio.topN === 8));
  await X.sandbox.step();
  assert.equal(X.sent.length, 8, 'not twice');
  X.at('2026-11-16T14:50:00Z'); await X.sandbox.step();
  assert.equal(X.sent.length, 8);
  await X.app.stop();
});

test('scheduler: all three switches are needed: sandbox off sends nothing, the broker source off (a policy refusal) stops the step, and the file cannot turn anything on', async () => {
  const X = await make({ sandboxOn: false });
  assert.deepEqual(await X.sandbox.step(), { status: 'off' });
  assert.equal(X.sent.length, 0); assert.match(X.sandbox.health().summary, /sandbox strategy: OFF/);
  X.on(true); await X.sandbox.step();
  X.at('2026-11-16T14:35:00Z'); X.down(true);
  const r = await X.sandbox.step();
  assert.ok(r.status === 'refused' || r.exec === undefined);
  assert.equal(X.sent.length, 0);
  await X.app.stop();
});

test('scheduler: risk limits: maxPositions, maxOrderNotionalUsd, the adapter cap and maxOrdersPerDay refuse an order WITH A REASON and never shrink it', async () => {
  const st = small(); st.regime.enabled = false; st.portfolio.weighting = 'equal'; st.risk.maxPositions = 8; st.risk.capitalUsd = 8000; st.risk.maxPositionPct = 20; st.risk.maxOrderNotionalUsd = 1200; st.risk.maxOrdersPerDay = 5;
  const X = await make({ strategy: st });
  const p = X.sandbox.plan(D);
  assert.equal(p.orders.length, 5, 'maxOrdersPerDay');
  assert.equal(p.refused.filter(r => /maxOrdersPerDay \(5\)/.test(r.reason)).length, 3, 'the other three are refused with the reason, not dropped');
  assert.ok(p.orders.every(o => o.notionalUsd <= 1200), 'an order is either sent as planned or refused');
  const big = small(); big.regime.enabled = false; big.portfolio.weighting = 'equal'; big.risk.capitalUsd = 16000; big.risk.maxPositionPct = 20; big.risk.maxOrderNotionalUsd = 1200;
  const B = await make({ strategy: big });
  const bp = B.sandbox.plan(D);
  assert.equal(bp.orders.length, 0); assert.ok(bp.refused.length === 8 && bp.refused.every(r => /above maxOrderNotionalUsd 1200/.test(r.reason)), 'refused, never shrunk to fit');
  const few = small(); few.risk.maxPositions = 8; few.portfolio.topN = 8; few.risk.capitalUsd = 8000;
  await B.app.stop();
  const s2 = small(); s2.risk.maxGrossPct = 30;
  const Y = await make({ strategy: s2 });
  const q = Y.sandbox.plan(D);
  assert.ok(q.orders.reduce((a, o) => a + o.notionalUsd, 0) <= 4000 * 0.3 + 0.01);
  await X.app.stop(); await Y.app.stop();
});

test('scheduler: the daily-loss kill switch switches orders off with a loud log until it is cleared; a plan day after a loss sends nothing', async () => {
  const X = await make();
  await X.sandbox.step();                                              // records equity 100000 on D
  assert.equal(X.sandbox.readState().equityHistory.at(-1).equity, 100000);
  X.at('2026-11-16T22:30:00Z'); X.acct.equity = 95000;                // a 5% fall (kill at 3%)
  X.sandbox.patchState(s => { s.lastPlanDay = null; s.lastPlan = null; });
  const bars = X.data.bars; bars.lastBarDay = () => '2026-11-16';
  await X.sandbox.step();
  const st = X.sandbox.readState();
  assert.ok(st.killed && /equity fell 5\.00%/.test(st.killed.reason));
  assert.ok(X.events.some(e => e.level === 'warn' && /SANDBOX KILL SWITCH/.test(e.message)));
  X.at('2026-11-17T14:35:00Z');
  const r = await X.sandbox.step();
  assert.equal(r.exec.status, 'killed'); assert.equal(X.sent.length, 0);
  X.sandbox.clearKill();
  assert.equal(X.sandbox.readState().killed, null);
  await X.app.stop();
});

test('scheduler: fills come back into the ledger next to the expected price; the exit goes out for the exact quantity on the time-exit day; both fills close the position with no extra cost', async () => {
  const st = small(); st.exits.timeExitSessions = 3; st.portfolio.rebalance = 'monthly:last';
  const X = await make({ strategy: st });
  await X.sandbox.step(); X.at('2026-11-16T14:35:00Z'); await X.sandbox.step();
  fillAll(X, 'entry', 100, 4.25, '2026-11-16T14:31:00Z');
  await X.sandbox.step();
  let ps = X.list();
  assert.ok(ps.every(p => p.fill_entry_price === 100 && p.expected_entry_price > 0 && p.status === 'open'));
  // plan on the close before the exit day: exit_day = entry + 3 sessions = 2026-11-19; plan at the close of 11-18 for the open of 11-19
  X.at('2026-11-18T22:30:00Z'); X.data.bars.lastBarDay = () => '2026-11-18';
  const r = await X.sandbox.step();
  assert.equal(r.planned.orders, 8);
  X.at('2026-11-19T14:35:00Z');
  const e = await X.sandbox.step();
  assert.deepEqual([e.exec.status, e.exec.sent], ['sent', 8]);
  const exits = X.sent.filter(s => s.leg === 'exit');
  assert.ok(exits.length === 8 && exits.every(s => s.qty === 4.25 && /^sm-sbx-2026-11-18-S\d\d-exit$/.test(s.clientId)));
  fillAll(X, 'exit', 103, 4.25, '2026-11-19T14:36:00Z');
  const done = await X.sandbox.step();
  assert.equal(done.reconcile.closed, 8);
  ps = X.list();
  assert.ok(ps.every(p => p.status === 'closed' && p.cost_bps === 0 && Math.abs(p.gross_return - 0.03) < 1e-9 && typeof p.benchmark_return === 'number'));
  await X.app.stop();
});

test('isolation: sandbox rows never reach the shadow log or calibration, and the opener router leaves sandbox positions alone', async () => {
  const X = await make();
  await X.sandbox.step(); X.at('2026-11-16T14:35:00Z'); await X.sandbox.step();
  fillAll(X, 'entry', 100, 2, '2026-11-16T14:31:00Z'); await X.sandbox.step();
  const n = sql => Number(X.app.db.stmt(sql).get().n);
  assert.equal(n('SELECT COUNT(*) AS n FROM candidate'), 0); assert.equal(n('SELECT COUNT(*) AS n FROM shadow_day'), 0); assert.equal(n('SELECT COUNT(*) AS n FROM calibration_bucket'), 0);
  assert.equal(n("SELECT COUNT(*) AS n FROM paper_position WHERE scoring_build LIKE 'sbx-%'"), 8);
  const router = createBrokerRouter({ ledger: X.ledger, shadow: X.shadow, scoring: X.learning.api.scoring, alpaca: { options: { maxNotionalUsd: 1000 }, async listOrders() { return []; }, async placeOrder() { throw new Error('the router must not order for sandbox positions'); } }, now: () => Date.parse('2026-11-23T20:50:00Z'), opts: { enabled: true, autoRun: false } });
  await router.feature.start({ db: X.app.db });
  const r = await router.api.step();
  assert.equal(r.exit && r.exit.due, 0, 'the router sees no sandbox position as due'); assert.equal(r.closed, 0);
  await router.feature.stop();
  await X.app.stop();
});

// ---- the tuner ---------------------------------------------------------------------------------------------------------------------------
async function tunerSetup(over = {}) {
  const st = small(); st.portfolio.rebalance = 'weekly:mon'; st.tuning = { enabled: true, minImprovement: 0.0001, params: { 'signals.momentum.lookback': { min: 21, max: 126, step: 21 }, 'portfolio.topN': { min: 4, max: 12, step: 4 }, 'regime.days': { min: 20, max: 80, step: 30 } } };
  Object.assign(st, over);
  const X = await make({ strategy: st });
  const tuningEnd = '2026-06-30';
  const tuner = createTuner({ store: X.store, data: X.data, getDb: () => X.app.db, sandbox: X.sandbox, dataDir: X.dir, now: () => Date.parse('2026-11-14T00:00:00Z'), opts: { periods: { start: '2023-09-01', end: '2026-10-30', holdoutWindows: 20 } } });
  return { X, tuner, tuningEnd };
}

test('tuner: candidates move each parameter at most one step, within bounds, at most 50, the unchanged strategy first', () => {
  const st = SB.normalize({ tuning: { params: { 'signals.momentum.lookback': { min: 126, max: 252, step: 63 }, 'portfolio.topN': { min: 10, max: 25, step: 5 }, 'regime.days': { min: 100, max: 200, step: 50 } } } }).value;
  const c = candidatesOf(st);
  assert.ok(c.length <= 50 && c.length >= 6 && Object.keys(c[0].changes).length === 0);
  for (const x of c) {
    for (const [p, v] of Object.entries(x.changes)) { const b = st.tuning.params[p], cur = SB.getPath(st, p); assert.ok(Math.abs(v - cur) <= b.step + 1e-9 && v >= b.min && v <= b.max, `${p} ${cur} -> ${v}`); }
    assert.equal(SB.normalize(x.strategy).ok, true);
  }
});

test('tuner: it scores on the later part, records every candidate, never reads bars after the tuning period (poisoned holdout bars change nothing), and adopts at most one step or keeps', async () => {
  const { X, tuner } = await tunerSetup();
  const before = X.store.state();
  const a = await tuner.run({ force: true, apply: false });
  assert.ok(['kept', 'would-change', 'too-few-periods'].includes(a.status), a.status);
  assert.equal(a.label, 'sandbox, in-sample-adjacent, not evidence'); assert.ok(a.candidates.length > 3 && a.current && a.current.periods > 0);
  assert.ok(a.data.holdoutEndNeverRead === '2026-10-30' && a.data.tuningEnd < '2026-10-30');
  // poison every bar after the tuning end: the result must not move
  X.app.db.stmt('UPDATE bar SET close = close * 7, adj_close = adj_close * 7, open = open * 7, high = high * 7, low = low * 7 WHERE day > ?').run(a.data.tuningEnd);
  const b = await tuner.run({ force: true, apply: false });
  assert.deepEqual(b.candidates.map(c => [c.testMean, c.fitMean]), a.candidates.map(c => [c.testMean, c.fitMean]));
  const rec = JSON.parse(fs.readFileSync(path.join(X.dir, 'stockman.sandbox-tuning.json'), 'utf8'));
  assert.equal(rec.length, 2); assert.equal(X.store.state().hash, before.hash, 'apply false changes nothing');
  await X.app.stop();
});

test('tuner: with a tiny margin it changes the file by at most one step per parameter and logs the hash change; a huge margin keeps; a second run within a week waits; the kill switch and tuning.enabled stop it', async () => {
  const { X, tuner } = await tunerSetup();
  const start = X.store.state();
  const kept = await (async () => { const s = SB.normalize({ ...start.strategy, tuning: { ...start.strategy.tuning, minImprovement: 0.1 } }); X.store.save(s.value); return tuner.run({ force: true, apply: true }); })();
  assert.equal(kept.status, 'kept');
  X.store.save({ ...start.strategy, tuning: { ...start.strategy.tuning, minImprovement: 0 } });
  const before = X.store.state();
  X.sandbox.patchState(s => { s.lastChangeDay = null; s.lastTune = null; });
  const r = await tuner.run({ force: true, apply: true });
  assert.ok(['changed', 'kept'].includes(r.status), r.status);
  if (r.status === 'changed') {
    const after = X.store.state();
    assert.notEqual(after.hash, before.hash); assert.equal(r.hashAfter, after.hash); assert.ok(Object.keys(r.best.changes).length > 0);
    for (const [p, v] of Object.entries(r.best.changes)) assert.ok(Math.abs(v - SB.getPath(before.strategy, p)) <= before.strategy.tuning.params[p].step + 1e-9, `${p} moved at most one step`);
    assert.ok(X.sandbox.readState().lastChangeDay);
    const again = await tuner.run({ force: true, apply: true });
    assert.notEqual(again.status, 'changed', 'no change within 5 sessions of the last one');
  }
  const w = await tuner.run({ force: false });
  assert.equal(w.status, 'waiting');
  X.sandbox.patchState(s => { s.lastTune = null; s.killed = { at: 1, day: D, reason: 'test' }; });
  assert.equal((await tuner.run({ force: false })).status, 'killed');
  X.sandbox.patchState(s => { s.killed = null; });
  const cur = X.store.state().strategy; X.store.save({ ...cur, tuning: { ...cur.tuning, enabled: false } });
  assert.equal((await tuner.run({ force: false })).status, 'off');
  await X.app.stop();
});

test('engine: a pinned name (almost no price movement, like a pending deal) is left out and counted; the volatility floor keeps inverse-volatility weights sane', () => {
  const rows = new Map([...SYMS, 'SPY'].map(s => [s, rowsOf(s)]));
  rows.set('PIN', rowsOf('S01').map(r => ({ ...r, open: 50, high: 50, low: 50, close: 50 + (r.day.endsWith('5') ? 0.01 : 0), adj_close: 50 + (r.day.endsWith('5') ? 0.01 : 0) })));
  const series = aligned(rows), d = 600, st = small();
  st.signals.lowVol.weight = 5;                                        // a heavy low-volatility tilt would otherwise rank the pinned name first
  const p = SE.buildTargets(st, { d, members: [...SYMS, 'PIN'], series, bench: series.get('SPY') });
  assert.equal(p.counts.pinned, 1); assert.ok(!p.targets.some(t => t.symbol === 'PIN'));
  const open = JSON.parse(JSON.stringify(st)); open.universe.minVolPct = 0;
  assert.ok(SE.buildTargets(open, { d, members: [...SYMS, 'PIN'], series, bench: series.get('SPY') }).targets.some(t => t.symbol === 'PIN'), 'with the filter off it would have been bought');
  assert.equal(SB.normalize({ universe: { minVolPct: -1 } }).ok, false);
});
