// The broker router (CL-0068): sends the paper opener's basket to the Alpaca PAPER account as market orders in the first minutes after the open,
// sells the exact quantity bought before the close of the exit day, writes the fills back into the ledger as broker-paper and closes the position.
// Fake Alpaca adapter, synthetic bars, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { createStockman } = require('../src/core/stockman/app');
const { createMockProvider } = require('../src/core/stockman/stocks/mock');
const { createBars } = require('../src/core/stockman/features/bars');
const { createLearningLayer } = require('../src/core/stockman/learning');
const { createTradingLayer } = require('../src/core/stockman/trading');
const { createBrokerRouter } = require('../src/core/stockman/trading/broker-router');
const { PolicyError } = require('../src/core/stockman/errors');
const { clock, putBars, walk, tradingDays } = require('./helpers/stockman-learning');

const DAYS = tradingDays('2026-07-01', '2026-12-10');
const D = '2026-11-16', EXIT = '2026-11-23';
const MEMBERS = Array.from({ length: 24 }, (_, i) => `M${String(i).padStart(2, '0')}`);
const PRICE = new Map([...MEMBERS, 'SPY'].map(s => [s, walk(s, s === 'SPY' ? 400 : 60 + (s.charCodeAt(2) % 7) * 10, 0.012)]));

async function make({ enabled = true, late = false } = {}) {
  const shadowNow = clock(late ? '2026-11-18T22:00:00Z' : '2026-11-16T22:00:00Z');
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile: ':memory:', log: () => {}, provider: createMockProvider({ bars: {}, ranges: ['1mo'], intervals: ['1d'], now: shadowNow }), now: shadowNow, sleep: async () => {} });
  const bars = createBars({ now: shadowNow, sleep: async () => {} });
  const data = { bars: bars.api, universe: { membersAsOf: () => ({ sp500: { snapshotAsOf: '2026-10-01', kind: 'history', symbols: [...MEMBERS] }, ndx100: null }) },
    runs: { getRun: day => ({ run_id: `run-${day}`, trade_day: day, state: 'ingested' }) }, earnings: { flags: () => ({ earnings_in_window: false, earnings_possible: false, earnings_data: 'confirmed' }) } };
  const learning = createLearningLayer({ data, now: shadowNow, autoRun: false, options: { shadow: { momentum: false } } });
  const trading = createTradingLayer({ data: { ...data, ...learning.api }, now: shadowNow, options: { paper: { enabled: false, autoRun: false } } });
  const orders = [], filled = new Map(), sent = [];
  let policyDown = false;
  const alpaca = {
    options: { maxNotionalUsd: 1000 },
    async placeOrder(a) {
      if (policyDown) throw new PolicyError('alpaca: broker lookups are off');
      const cid = `sm-${a.positionId}-${a.leg}`;
      const dup = orders.find(o => o.clientOrderId === cid);
      sent.push({ ...a, cid, dup: Boolean(dup) });
      if (dup) return { ...dup, duplicate: true };
      const o = { id: `ord-${cid}`, clientOrderId: cid, symbol: a.symbol, side: a.leg === 'entry' ? 'buy' : 'sell', status: 'new', filledQty: null, filledAvgPrice: null, filledAt: null };
      orders.push(o);
      return { ...o, duplicate: false };
    },
    async listOrders() { return orders.map(o => (filled.has(o.clientOrderId) ? { ...o, ...filled.get(o.clientOrderId), status: 'filled' } : o)); },
  };
  let t = Date.parse('2026-11-17T12:00:00Z');   // 07:00 New York on the entry day
  const router = createBrokerRouter({ ledger: trading.api.ledger, shadow: learning.api.shadow, scoring: learning.api.scoring, alpaca, now: () => t, opts: { enabled, autoRun: false, capitalUsd: 20000 } });
  app.use(bars.feature);
  for (const f of [...learning.features, ...trading.features, router.feature]) app.use(f);
  await app.start();
  for (const s of [...MEMBERS, 'SPY']) putBars(app, s, DAYS.filter(d => d <= EXIT), { price: PRICE.get(s) });
  return { app, router: router.api, ledger: trading.api.ledger, shadow: learning.api.shadow, orders, sent, filled, at: iso => { t = Date.parse(iso); }, down: v => { policyDown = v; }, list: () => trading.api.ledger.list({ source: 'broker-paper', limit: 1000 }) };
}
const fill = (X, p, leg, price, qty, iso) => X.filled.set(`sm-${p.id}-${leg}`, { filledAvgPrice: price, filledQty: qty, filledAt: iso });

test('router: off unless the router option is on; nothing is sent', async () => {
  const X = await make({ enabled: false });
  X.shadow.logDay(D);
  X.at('2026-11-17T14:35:00Z');
  assert.deepEqual(await X.router.step(), { status: 'off' });
  assert.equal(X.sent.length, 0);
  assert.match(X.app.health().dataQuality['broker-router'].summary, /OFF/);
  await X.app.stop();
});

test('router: orders go out only in the first half hour after the open, once each, sized capital / 5 / basket; a restart sends nothing twice', async () => {
  const X = await make();
  assert.equal(X.shadow.logDay(D).late, false);
  X.at('2026-11-17T12:00:00Z');                                     // 07:00 New York: before the open
  let r = await X.router.step();
  assert.equal(r.enter, undefined); assert.equal(X.sent.length, 0);
  X.at('2026-11-17T14:35:00Z');                                     // 09:35
  r = await X.router.step();
  assert.deepEqual([r.enter.candidates, r.enter.opened, r.enter.sent, r.enter.failed], [20, 20, 20, 0]);
  assert.equal(X.sent.length, 20);
  assert.ok(X.sent.every(s => s.leg === 'entry' && s.timeInForce === 'day' && s.notionalUsd === 200), 'USD 20,000 / 5 sleeves / 20 names = 200 each');
  assert.equal(new Set(X.sent.map(s => s.cid)).size, 20);
  const ps = X.list();
  assert.equal(ps.length, 20);
  assert.ok(ps.every(p => p.source === 'broker-paper' && /order=ord-sm-/.test(p.note) && /candidate=/.test(p.note) && p.status === 'open'));
  await X.router.step();                                            // the same minute again, as after a restart
  assert.equal(X.sent.length, 20, 'no second order for any position'); assert.equal(X.list().length, 20);
  X.at('2026-11-17T15:10:00Z');                                     // 10:10: past the window
  await X.router.step();
  assert.equal(X.sent.length, 20);
  await X.app.stop();
});

test('router: a day logged after its entry session is never traded, and a policy refusal stops the step', async () => {
  const L = await make({ late: true });
  assert.equal(L.shadow.logDay(D).late, true);
  L.at('2026-11-17T14:35:00Z');
  const r = await L.router.step();
  assert.equal(r.enter.candidates, 0); assert.equal(L.sent.length, 0); assert.equal(L.list().length, 0);
  await L.app.stop();
  const X = await make();
  X.shadow.logDay(D); X.down(true);
  X.at('2026-11-17T14:35:00Z');
  const s = await X.router.step();
  assert.equal(s.status, 'refused'); assert.match(s.note, /broker lookups are off/);
  assert.equal(X.sent.length, 0);
  await X.app.stop();
});

test('router: fills reach the ledger as broker-paper; before the close of the exit day the exact bought quantity is sold; with both fills the position closes with no extra cost', async () => {
  const X = await make();
  X.shadow.logDay(D);
  X.at('2026-11-17T14:35:00Z'); await X.router.step();
  for (const p of X.list()) fill(X, p, 'entry', 100, 2.5, '2026-11-17T14:31:00Z');
  await X.router.step();
  let ps = X.list();
  assert.ok(ps.every(p => p.fill_entry_price === 100 && p.status === 'open'));
  assert.equal(X.sent.filter(s => s.leg === 'exit').length, 0, 'no exit order on the entry day');
  X.at('2026-11-23T20:40:00Z');                                     // 15:40 on the exit day: not yet in the sell window (opens at 15:45)
  await X.router.step();
  assert.equal(X.sent.filter(s => s.leg === 'exit').length, 0);
  X.at('2026-11-23T20:50:00Z');                                     // 15:50
  const r = await X.router.step();
  assert.deepEqual([r.exit.due, r.exit.sent], [20, 20]);
  const exits = X.sent.filter(s => s.leg === 'exit');
  assert.ok(exits.every(s => s.qty === 2.5 && s.timeInForce === 'day'), 'sells exactly the quantity bought');
  await X.router.step();
  assert.equal(X.sent.filter(s => s.leg === 'exit').length, 20, 'once');
  for (const p of X.list()) fill(X, p, 'exit', 102, 2.5, '2026-11-23T20:55:00Z');
  const done = await X.router.step();
  assert.equal(done.closed, 20);
  ps = X.list();
  assert.ok(ps.every(p => p.status === 'closed' && p.cost_bps === 0 && Math.abs(p.gross_return - 0.02) < 1e-9 && Math.abs(p.net_return - 0.02) < 1e-9 && typeof p.benchmark_return === 'number'));
  assert.match(X.router.health().summary, /0 open, 20 closed/);
  await X.app.stop();
});

test('router: an exit that was missed goes out in the first half hour of a later session, marked late-exit', async () => {
  const X = await make();
  X.shadow.logDay(D);
  X.at('2026-11-17T14:35:00Z'); await X.router.step();
  for (const p of X.list()) fill(X, p, 'entry', 100, 1, '2026-11-17T14:31:00Z');
  await X.router.step();
  X.at('2026-11-24T14:40:00Z');                                     // 09:40 the session after the exit day; jarvis was off at 15:50
  const r = await X.router.step();
  assert.equal(r.exit.sent, 20);
  assert.ok(X.list().every(p => /exit=ord-sm-\d+-exit late-exit/.test(p.note)));
  await X.app.stop();
});
