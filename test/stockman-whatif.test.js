// What-if exits (R6, vault D31): a report on the paper opener's closed positions that replays four fixed exit rules over the stored bars.
// It never acts, never writes, and leaves the actual result alone; a rule that never triggers equals the actual result.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { createStockman } = require('../src/core/stockman/app');
const { createMockProvider } = require('../src/core/stockman/stocks/mock');
const { createBars } = require('../src/core/stockman/features/bars');
const { createLearningLayer } = require('../src/core/stockman/learning');
const { createTradingLayer } = require('../src/core/stockman/trading');
const { putBars } = require('./helpers/stockman-learning');

const DAYS = ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23'];
async function make() {
  const prov = createMockProvider({ bars: {}, ranges: ['1mo'], intervals: ['1d'] });
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile: ':memory:', log: () => {}, provider: prov, sleep: async () => {} });
  const bars = createBars({ sleep: async () => {} });
  const data = { bars: bars.api, universe: { membersAsOf: () => ({ sp500: { symbols: [] }, ndx100: null }) }, runs: { getRun: () => null }, earnings: { flags: () => null } };
  const learning = createLearningLayer({ data, autoRun: false, options: { shadow: { momentum: false } } });
  const trading = createTradingLayer({ data: { ...data, ...learning.api }, options: { paper: { enabled: false, autoRun: false } } });
  app.use(bars.feature);
  for (const f of [...learning.features, ...trading.features]) app.use(f);
  await app.start();
  return { app, ledger: trading.api.ledger, whatif: trading.api.whatif };
}
const pos = (X, symbol, closes) => {
  putBars(X.app, symbol, DAYS, { price: i => closes[i], factor: () => 1 });
  const exit = closes.at(-1), gross = exit / 100 - 1;
  return X.ledger.insertClosed({ source: 'paper-internal', scoringBuild: 'rev-v1.0/L5/vol', symbol, entryDay: DAYS[0], exitDay: DAYS.at(-1), fillEntryPrice: 100, fillExitPrice: exit, grossReturn: gross, costBps: 10, netReturn: gross - 0.001 });
};

test('what-if: a stop at 5% on a falling name exits at the first close below 95; a take-profit on a rising one at the first close above 105', async () => {
  const X = await make();
  pos(X, 'DOWN', [99, 94, 90, 85, 80]);
  pos(X, 'UP', [101, 106, 108, 103, 98]);
  pos(X, 'FLAT', [100, 101, 100, 99, 100]);
  const r = X.whatif.report();
  assert.equal(r.positions, 3);
  assert.equal(r.rules.stop5.triggered, 1);
  assert.equal(r.rules.take5.triggered, 1);
  const stopEx = r.rules.stop5.examples[0];
  assert.equal(stopEx.symbol, 'DOWN'); assert.equal(stopEx.exitDay, '2026-11-18');
  assert.ok(Math.abs(stopEx.whatIf - (0.94 - 1 - 0.001)) < 1e-12);
  const takeEx = r.rules.take5.examples[0];
  assert.equal(takeEx.symbol, 'UP'); assert.equal(takeEx.exitDay, '2026-11-18');
  assert.equal(r.rules.stop5.better, 1, 'the stop beat holding DOWN to -20%');
  assert.equal(r.rules.trail5.triggered, 1, 'trailing 5% hits DOWN; UP falls 108 → 103, above 102.6, and the 98 is the planned exit day');
  assert.equal(r.rules.rescore0.triggered, 0, 'no logged scores, no re-score exit');
  assert.match(r.label, /never acted on/);
  await X.app.stop();
});

test('what-if: the re-score rule exits on the first held day whose logged reversal score is below 0; the report writes nothing', async () => {
  const X = await make();
  pos(X, 'RS', [100, 102, 103, 104, 105]);
  X.app.db.stmt(`INSERT INTO candidate(candidate_id, run_id, day, symbol, scoring_build, indexes, eligible, reasons, score, entry_day, exit_day, logged_at)
    VALUES ('c1','run-2026-11-18','2026-11-18','RS','rev-v1.0','sp500',1,'[]',-0.4,'2026-11-19','2026-11-25',1)`).run();
  const before = X.app.db.stmt('SELECT COUNT(*) n FROM paper_position').get().n;
  const r = X.whatif.report();
  assert.equal(r.rules.rescore0.triggered, 1);
  assert.equal(r.rules.rescore0.examples[0].exitDay, '2026-11-18');
  assert.equal(X.app.db.stmt('SELECT COUNT(*) n FROM paper_position').get().n, before);
  assert.match(require('node:fs').readFileSync(require.resolve('../src/core/stockman/trading/whatif.js'), 'utf8'), /never acts/);
  assert.doesNotMatch(require('node:fs').readFileSync(require.resolve('../src/core/stockman/trading/whatif.js'), 'utf8'), /placeOrder|INSERT|UPDATE|DELETE/);
  await X.app.stop();
});
