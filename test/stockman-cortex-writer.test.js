// Closed StockMan paper trades → cortex (vault D30, CL-0050): the worker's outbox lists closed live paper trades from the ledger, and
// jarvis's writer records them as `trade` events and `traded` edges with tool trust, outside any turn. Idempotent replay, a loss weakens
// only its own edge, backtest rows never reach the cortex, and a tainted turn elsewhere does not stop the writer (the writer is not in a turn).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const cortexLib = require('../src/core/cortex');
const { createStockman } = require('../src/core/stockman/app');
const { createMockProvider } = require('../src/core/stockman/stocks/mock');
const { createLedger } = require('../src/core/stockman/trading/ledger');
const { createTradeOutbox } = require('../src/core/stockman/trading/outbox');
const { createCortexWriter, META_KEY } = require('../src/core/stockman/jarvis/cortex-writer');

async function make() {
  const prov = createMockProvider({ bars: {}, ranges: ['1mo'], intervals: ['1d'] });
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile: ':memory:', log: () => {}, provider: prov, sleep: async () => {} });
  const ledger = createLedger();
  const published = [];
  let steps = 0;
  const outbox = createTradeOutbox({ publish: (t, p) => published.push({ t, p }), calibration: { step: async () => { steps++; } }, opts: { autoRun: false } });
  app.use(ledger.feature); app.use(outbox.feature);
  await app.start();
  const cortex = cortexLib.open({ file: ':memory:' });
  const writer = createCortexWriter({ cortex, request: async (op, args) => { assert.equal(op, 'closedTrades'); return outbox.api.closedTrades(args); } });
  return { app, ledger: ledger.api, outbox, cortex, writer, published, steps: () => steps };
}

const base = { scoringBuild: 'rev-v1.0/L5/vol', entryDay: '2026-11-17', exitDay: '2026-11-23', signalDay: '2026-11-16' };
function closed(ledger, symbol, gross, bench, source = 'paper-internal') {
  return ledger.insertClosed({ ...base, source, symbol, fillEntryPrice: 100, fillExitPrice: 100 * (1 + gross), grossReturn: gross, costBps: 10, netReturn: gross - 0.001, benchmarkReturn: bench, note: `candidate=run-2026-11-16/${symbol}/rev-v1.0` });
}
const edgeWeight = (cortex, a, b) => cortex.neighbors(a.id).find(e => e.id === b.id || e.node?.id === b.id || e.dst === b.id)?.weight;

test('closed paper trades are written once, as tool-trust nodes, trade events and traded edges', async () => {
  const s = await make();
  closed(s.ledger, 'AAPL', 0.03, 0.01);
  closed(s.ledger, 'MSFT', -0.02, 0.01, 'broker-paper');
  closed(s.ledger, 'NVDA', 0.05, 0.0, 'backtest');   // never reaches the cortex
  assert.equal(await s.writer.sync(), 2);
  assert.equal(await s.writer.sync(), 0, 'a re-run writes nothing twice');
  const events = s.cortex.event.query({ kind: 'trade' });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => e.payload.symbol).sort(), ['AAPL', 'MSFT']);
  const aapl = events.find(e => e.payload.symbol === 'AAPL').payload;
  assert.equal(aapl.win, true); assert.equal(aapl.candidateId, 'run-2026-11-16/AAPL/rev-v1.0');
  assert.equal(aapl.excessReturn, 0.019, 'numbers come from the ledger (rounded to 6 decimals)');
  assert.equal(String(s.cortex.meta.get(META_KEY)), String(2));
  await s.app.stop(); s.cortex.close();
});

test('a loss weakens its own strategy → instrument edge at once; a win grows it', async () => {
  const s = await make();
  closed(s.ledger, 'AAPL', 0.03, 0.01);
  await s.writer.sync();
  const db = s.cortex;
  const stockId = db.event.query({ kind: 'trade' })[0].node_id ?? db.event.query({ kind: 'trade' })[0].nodeId;
  const weight = () => (db.neighbors(stockId, { types: ['traded'] }) || [])[0]?.weight ?? null;
  const afterWin = weight();
  assert.ok(afterWin > 0, 'the traded edge exists after a win');
  closed(s.ledger, 'AAPL', -0.04, 0.01);
  await s.writer.sync();
  const afterLoss = weight();
  assert.ok(afterLoss < afterWin, `a loss lowers the edge (${afterWin} → ${afterLoss})`);
  await s.app.stop(); s.cortex.close();
});

test('the outbox announces new closes and recalculates calibration; it ignores backtest rows', async () => {
  const s = await make();
  assert.equal((await s.outbox.api.tick()).status, 'startup');
  closed(s.ledger, 'NVDA', 0.05, 0.0, 'backtest');
  assert.equal((await s.outbox.api.tick()).status, 'idle');
  closed(s.ledger, 'AAPL', 0.03, 0.01);
  const r = await s.outbox.api.tick();
  assert.equal(r.status, 'announced');
  assert.equal(s.steps(), 1);
  assert.equal(s.published.at(-1).t, 'trade-closed');
  await s.app.stop(); s.cortex.close();
});

test('the writer survives an engine that is not ready and catches up later', async () => {
  const s = await make();
  closed(s.ledger, 'AAPL', 0.03, 0.01);
  let ready = false;
  const logs = [];
  const writer = createCortexWriter({ cortex: s.cortex, log: l => logs.push(l), request: async (op, args) => { if (!ready) throw new Error('engine is not ready'); return s.outbox.api.closedTrades(args); } });
  assert.equal(await writer.sync(), 0);
  assert.ok(logs.some(l => /sync failed/.test(l)));
  ready = true;
  assert.equal(await writer.sync(), 1);
  await s.app.stop(); s.cortex.close();
});

test('the writer reads no outside text and the cortex accepts the new kinds', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/core/stockman/jarvis/cortex-writer.js'), 'utf8');
  assert.doesNotMatch(src, /orchestrator|providers\/|fetch\(|complete\(|ollama/i);
  const { TYPES, STRUCTURAL } = require('../src/core/cortex/edges');
  assert.ok(TYPES.traded); assert.ok(!STRUCTURAL.has('traded'));
});
