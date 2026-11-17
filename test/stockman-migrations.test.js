// Migration ordering across the data, learning and trading layers (vault CL-0044): a fresh stockman.db and one written by the data-layer-only
// build (version 7) must both reach version 11 with every table present. The worker registers learning (10, 11) before trading (8, 9), so
// the database must apply them by number, not by registration order.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStockmanDb } = require('../src/core/stockman/db');
const { createDataLayer } = require('../src/core/stockman/features');
const { createTradingLayer } = require('../src/core/stockman/trading');

const fetcher = { getText: async () => { throw new Error('no network in tests'); }, getJson: async () => { throw new Error('no network in tests'); } };
const layers = () => {
  const data = createDataLayer({ fetcher, autoRun: false });
  const trading = createTradingLayer({ data: data.api });
  return { data, trading };
};
const migrationsOf = fs => fs.flatMap(f => f.migrations || []);
const tables = db => db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
const EXPECTED = ['meta', 'engine_event', 'universe_snapshot', 'universe_member', 'bar', 'bar_gap', 'coverage', 'bar_history', 'market_day', 'catchup_gap',
  'run', 'run_stage', 'earnings_fetch', 'earnings_event', 'paper_position', 'paper_fill', 'backtest_variant', 'backtest_run', 'backtest_day',
  'shadow_day', 'candidate', 'candidate_outcome', 'calibration_bucket', 'calibration_run'];
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stockman-mig-')), 'stockman.db');

test('stockman-migrations: the full build registers versions 2 to 11 once each', () => {
  const { data, trading } = layers();
  const versions = migrationsOf([...data.features, ...trading.features]).map(m => m.version).sort((a, b) => a - b);
  assert.deepEqual(versions, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(data.features.length + trading.features.length, 11, 'five data, three learning, three trading features (ledger, backtest, the paper opener, which has no table)');
});

test('stockman-migrations: a fresh database reaches 11 with every table', () => {
  const { data, trading } = layers();
  const db = openStockmanDb({ file: tmpFile(), features: migrationsOf([...data.features, ...trading.features]) });
  assert.equal(db.version, 11);
  const have = tables(db);
  for (const t of EXPECTED) assert.ok(have.includes(t), `missing table ${t}`);
  db.close();
});

test('stockman-migrations: a data-layer-only database (version 7) migrates to 11 and keeps its rows', () => {
  const file = tmpFile();
  const old = layers();
  const dataOnly = openStockmanDb({ file, features: migrationsOf(old.data.features.filter(f => ['universe', 'bars', 'calendar', 'earnings', 'runs'].includes(f.id))) });
  assert.equal(dataOnly.version, 7);
  dataOnly.raw.prepare("INSERT INTO bar(symbol, day, open, high, low, close, adj_close, volume, source, fetched_at) VALUES ('AAA','2026-01-02',1,1,1,1,1,1,'t',1)").run();
  dataOnly.close();
  const { data, trading } = layers();
  const db = openStockmanDb({ file, features: migrationsOf([...data.features, ...trading.features]) });
  assert.equal(db.version, 11);
  const have = tables(db);
  for (const t of EXPECTED) assert.ok(have.includes(t), `missing table ${t}`);
  assert.equal(Number(db.raw.prepare('SELECT COUNT(*) n FROM bar').get().n), 1, 'old rows survive');
  db.close();
});

test('stockman-migrations: registration order does not matter (learning before trading and the reverse)', () => {
  const { data, trading } = layers();
  const a = openStockmanDb({ file: ':memory:', features: migrationsOf([...trading.features, ...data.features]) });
  assert.equal(a.version, 11);
  for (const t of EXPECTED) assert.ok(tables(a).includes(t), `missing table ${t}`);
  a.close();
});
