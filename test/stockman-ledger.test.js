// Tests for the paper ledger and the cost model (vault Phase 1 ledger part, G11, D20). No network, in-memory database.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { createStockman } = require('../src/core/stockman/app');
const { createMockProvider } = require('../src/core/stockman/stocks/mock');
const { createLedger, createMemoryFillPort } = require('../src/core/stockman/trading/ledger');
const costs = require('../src/core/stockman/trading/costs');

async function ledgerApp() {
  const l = createLedger({});
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile: ':memory:', log: () => {}, provider: createMockProvider({}) });
  app.use(l.feature);
  await app.start();
  return { app, ledger: l.api };
}
const POS = { source: 'paper-internal', symbol: 'AAA', scoringBuild: 'rev-v1.0/L5/vol', entryDay: '2026-03-02', exitDay: '2026-03-06', runId: 'run-2026-02-27', basketId: 'b1', sleeve: 2, weight: 0.05, expectedEntryPrice: 100 };

// ---- costs ----------------------------------------------------------------------------------------------------------------------
test('costs: 10 bps round trip is the base case and results are reported at 5, 10 and 25', () => {
  assert.equal(costs.BASE_BPS, 10);
  assert.deepEqual([...costs.REPORT_BPS], [5, 10, 25]);
  assert.equal(costs.roundTrip(10), 0.001);
  assert.equal(costs.perSide(10), 0.0005);
  const net = costs.netAtLevels(0.01);
  assert.ok(Math.abs(net[5] - 0.0095) < 1e-12 && Math.abs(net[10] - 0.009) < 1e-12 && Math.abs(net[25] - 0.0075) < 1e-12);
  assert.throws(() => costs.roundTrip(-1), RangeError);
  assert.throws(() => costs.roundTrip(NaN), RangeError);
});

test('costs: a paper buy fills a little higher and a sell a little lower; slippage is signed against the trader', () => {
  assert.ok(Math.abs(costs.fillWithCost(100, 'buy', 10) - 100.05) < 1e-9);
  assert.ok(Math.abs(costs.fillWithCost(100, 'sell', 10) - 99.95) < 1e-9);
  assert.ok(Math.abs(costs.slippageBps(100, 100.05, 'buy') - 5) < 1e-9);
  assert.ok(Math.abs(costs.slippageBps(100, 99.95, 'sell') - 5) < 1e-9);
  assert.ok(costs.slippageBps(100, 99.9, 'buy') < 0);   // a better fill is negative slippage
  assert.throws(() => costs.fillWithCost(0, 'buy'), RangeError);
  assert.throws(() => costs.fillWithCost(100, 'hold'), RangeError);
});

// ---- ledger ---------------------------------------------------------------------------------------------------------------------
test('ledger: migration 8 creates the tables; a position opens, takes two fills, closes with the cost applied', async () => {
  const { app, ledger } = await ledgerApp();
  assert.equal(app.db.version, 8);
  const id = ledger.open(POS);
  assert.equal(ledger.getPosition(id).status, 'open');
  ledger.recordFill({ positionId: id, leg: 'entry', price: 100.05, day: '2026-03-02', source: 'paper-internal' });
  ledger.recordFill({ positionId: id, leg: 'exit', price: 103.95, day: '2026-03-06', source: 'paper-internal' });
  const r = ledger.close(id, { costBps: 10, benchmarkReturn: 0.01 });
  const p = ledger.getPosition(id);
  assert.equal(p.status, 'closed');
  assert.ok(Math.abs(p.gross_return - (103.95 / 100.05 - 1)) < 1e-12);
  assert.ok(Math.abs(p.net_return - (p.gross_return - 0.001)) < 1e-12);
  assert.equal(p.cost_bps, 10);
  assert.equal(p.benchmark_return, 0.01);
  assert.equal(p.scoring_build, 'rev-v1.0/L5/vol');
  assert.equal(p.run_id, 'run-2026-02-27'); assert.equal(p.basket_id, 'b1'); assert.equal(p.sleeve, 2);
  assert.equal(r.id, id);
  assert.throws(() => ledger.close(id), /already closed/);
  assert.throws(() => ledger.recordFill({ positionId: id, leg: 'exit', price: 1, day: '2026-03-06', source: 'paper-internal' }), /closed, fills go to open/);
  await app.stop();
});

test('ledger: a position cannot close without both fills; bad input is refused with a reason', async () => {
  const { app, ledger } = await ledgerApp();
  const id = ledger.open(POS);
  assert.throws(() => ledger.close(id), /needs an entry fill and an exit fill/);
  assert.throws(() => ledger.open({ ...POS, source: 'live' }), /source must be one of/);
  assert.throws(() => ledger.open({ ...POS, scoringBuild: '' }), /scoringBuild is required/);
  assert.throws(() => ledger.open({ ...POS, exitDay: '2026-03-02' }), /exitDay must be after/);
  assert.throws(() => ledger.open({ ...POS, sleeve: 5 }), /sleeve is 0 to 4/);
  assert.throws(() => ledger.open({ ...POS, expectedEntryPrice: -1 }), /positive number/);
  ledger.cancel(id, 'test');
  assert.equal(ledger.getPosition(id).status, 'cancelled');
  await app.stop();
});

test('ledger: several fills of one leg average by quantity; a repeated broker delivery is stored once', async () => {
  const { app, ledger } = await ledgerApp();
  const id = ledger.open({ ...POS, source: 'broker-paper' });
  ledger.recordFill({ positionId: id, leg: 'entry', price: 100, quantity: 10, day: '2026-03-02', source: 'broker-paper', externalId: 'f1' });
  const dup = ledger.recordFill({ positionId: id, leg: 'entry', price: 100, quantity: 10, day: '2026-03-02', source: 'broker-paper', externalId: 'f1' });
  assert.equal(dup.duplicate, true);
  ledger.recordFill({ positionId: id, leg: 'entry', price: 101, quantity: 30, day: '2026-03-02', source: 'broker-paper', externalId: 'f2' });
  assert.ok(Math.abs(ledger.getPosition(id).fill_entry_price - 100.75) < 1e-9);
  assert.equal(Number(app.db.stmt('SELECT COUNT(*) AS n FROM paper_fill').get().n), 2);
  await app.stop();
});

test('ledger: a fill from one source cannot land on another source\'s position', async () => {
  const { app, ledger } = await ledgerApp();
  const bt = ledger.open({ ...POS, source: 'backtest' });
  assert.throws(() => ledger.recordFill({ positionId: bt, leg: 'entry', price: 100, day: '2026-03-02', source: 'broker-paper' }), /cannot go to a backtest position/);
  const pi = ledger.open(POS);
  assert.throws(() => ledger.recordFill({ positionId: pi, leg: 'entry', price: 100, day: '2026-03-02', source: 'broker-paper' }), /cannot go to a paper-internal position/);
  await app.stop();
});

test('fills port: a broker paper source writes fills into the same ledger; bad fills go to onError and never throw into the port', async () => {
  const { app, ledger } = await ledgerApp();
  const id = ledger.open({ ...POS, source: 'broker-paper' });
  const port = createMemoryFillPort({ source: 'broker-paper' });
  const errors = [];
  const off = ledger.attachFillSource(port, { onError: e => errors.push(e.message) });
  port.deliver({ positionId: id, leg: 'entry', price: 100.1, day: '2026-03-02', quantity: 5, externalId: 'a' });
  port.deliver({ positionId: id, leg: 'exit', price: 101.5, day: '2026-03-06', quantity: 5, externalId: 'b' });
  port.deliver({ positionId: 9999, leg: 'entry', price: 1, day: '2026-03-02' });
  assert.equal(errors.length, 1); assert.match(errors[0], /no position 9999/);
  const p = ledger.getPosition(id);
  assert.equal(p.fill_entry_price, 100.1); assert.equal(p.fill_exit_price, 101.5);
  assert.equal(ledger.close(id, { costBps: 0 }).id, id);
  off();
  port.deliver({ positionId: id, leg: 'entry', price: 5, day: '2026-03-02', externalId: 'c' });   // nobody listens any more
  assert.equal(Number(app.db.stmt('SELECT COUNT(*) AS n FROM paper_fill').get().n), 2);
  await app.stop();
});

test('fills port: a source that can place orders is refused; so is a backtest source or a missing subscribe()', async () => {
  const { app, ledger } = await ledgerApp();
  const base = { source: 'broker-paper', subscribe: () => () => {} };
  for (const m of ['placeOrder', 'submitOrder', 'buy', 'sell']) assert.throws(() => ledger.attachFillSource({ ...base, [m]: () => {} }), /must not be able to place orders/);
  assert.throws(() => ledger.attachFillSource({ ...base, source: 'backtest' }), /needs subscribe/);
  assert.throws(() => ledger.attachFillSource({ source: 'broker-paper' }), /needs subscribe/);
  await app.stop();
});

test('ledger: insertClosedBatch is one transaction (a bad row stores nothing); only backtest rows can be bulk-deleted', async () => {
  const { app, ledger } = await ledgerApp();
  const good = { ...POS, source: 'backtest', runId: 'bt-1', grossReturn: 0.01, netReturn: 0.009, costBps: 10 };
  assert.throws(() => ledger.insertClosedBatch([good, { ...good, symbol: '' }]), /symbol is required/);
  assert.equal(ledger.count(), 0);
  assert.equal(ledger.insertClosedBatch([good, { ...good, symbol: 'BBB' }]), 2);
  const keep = ledger.open(POS);
  assert.equal(ledger.deleteBacktestRuns(['bt-1', 'run-2026-02-27']), 2);   // the paper-internal run id is not touched
  assert.equal(ledger.getPosition(keep).status, 'open');
  await app.stop();
});
