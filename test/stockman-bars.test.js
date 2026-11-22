const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStockman } = require('../src/core/stockman/app');
const { createMockProvider } = require('../src/core/stockman/stocks/mock');
const { createYahooProvider } = require('../src/core/stockman/stocks/yahoo');
const { createBars, pickRange } = require('../src/core/stockman/features/bars');
const { nyWallToMs } = require('../src/core/stockman/features/ny-time');
const { tradingDays } = require('../src/core/stockman/features/calendar-rules');
const E = require('../src/core/stockman/errors');

const RANGES = ['5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y'];
const bar = (day, px = 100) => ({ t: nyWallToMs(day, '09:30'), open: px, high: px + 2, low: px - 2, close: px + 1, adjClose: px + 0.5, volume: 1000 });
const days = (a, b) => tradingDays(a, b);
const TARGET = '2026-11-16';

// a clock that moves a little on every read, so the framework's rate limiter (which sleeps in tests) always makes progress
const ticking = (start = '2026-11-17T01:00:00Z') => { let t = Date.parse(start); return () => (t += 1); };
async function make({ bars = {}, provider, opts = {}, now = ticking(), sleeps = [] } = {}) {
  const prov = provider || createMockProvider({ bars, ranges: RANGES, intervals: ['1d'], now });
  const built = createBars({ now, sleep: async ms => { sleeps.push(ms); }, opts });
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile: ':memory:', log: () => {}, provider: prov, now, sleep: async () => {} });
  app.use(built.feature);
  await app.start();
  return { app, b: built.api, feature: built.feature, prov, sleeps };
}
const count = (app, sql, ...a) => Number(app.db.stmt(sql).get(...a).n);

test('bars: a sweep stores finished sessions, keeps the symbol spelling, and drops the session in progress', async () => {
  const ds = days('2026-11-09', '2026-11-17');   // 11-17 is "today" and not finished at the target 11-16
  const { app, b, prov } = await make({ bars: { AAPL: ds.map(d => bar(d)), 'BRK.B': ds.map(d => bar(d, 500)) } });
  const r = await b.sweep({ symbols: ['AAPL', 'BRK.B'], target: TARGET, range: '1mo' });
  assert.equal(r.symbolsStored, 2);
  assert.equal(r.barsWritten, 12);                 // 11-09..11-13 and 11-16: six finished sessions per symbol
  assert.equal(r.partialDropped, 2);
  assert.equal(count(app, "SELECT COUNT(*) AS n FROM bar WHERE day > '2026-11-16'"), 0);
  assert.equal(count(app, "SELECT COUNT(*) AS n FROM bar WHERE symbol = 'BRK.B'"), 6);
  assert.equal(prov.calls.length, 2);
  await app.stop();
});

test('bars: gaps are recorded, never filled, and closed only by a real bar from a later fetch', async () => {
  const full = days('2026-11-09', '2026-11-17');
  const bars = { AAPL: full.filter(d => d !== '2026-11-12').map(d => bar(d)) };   // the provider skips Thursday 11-12
  const { app, b } = await make({ bars });
  const r = await b.sweep({ symbols: ['AAPL'], target: TARGET, range: '1mo' });
  assert.equal(r.gaps, 1);
  const g = app.db.stmt('SELECT * FROM bar_gap').get();
  assert.deepEqual([g.symbol, g.day, g.reason, g.resolved_at], ['AAPL', '2026-11-12', 'not_returned', null]);
  assert.equal(count(app, "SELECT COUNT(*) AS n FROM bar WHERE day = '2026-11-12'"), 0, 'no invented bar');
  assert.equal(b.gapCount(), 1);
  assert.equal(b.openGaps()[0].day, '2026-11-12');
  // the next session: the provider now returns the missing day as well; storing the real bar closes the gap
  bars.AAPL = full.map(d => bar(d));
  await b.sweep({ symbols: ['AAPL'], target: '2026-11-17', range: '1mo' });
  assert.equal(count(app, "SELECT COUNT(*) AS n FROM bar WHERE day = '2026-11-12'"), 1);
  assert.equal(b.gapCount(), 0);
  assert.ok(app.db.stmt("SELECT resolved_at FROM bar_gap WHERE day = '2026-11-12'").get().resolved_at !== null, 'kept as history, marked resolved');
  await app.stop();
});

test('bars: a symbol with no bar yet starts at its first returned day (a new listing is not a gap)', async () => {
  const { app, b } = await make({ bars: { NEW: days('2026-11-12', '2026-11-16').map(d => bar(d)) } });
  const r = await b.sweep({ symbols: ['NEW'], target: TARGET, range: '1mo' });
  assert.equal(r.gaps, 0);
  assert.equal(b.gapCount(), 0);
  await app.stop();
});

test('bars: a sweep is idempotent: a second run makes no provider call for fresh symbols', async () => {
  const { app, b, prov } = await make({ bars: { AAPL: days('2026-11-09', '2026-11-16').map(d => bar(d)) } });
  await b.sweep({ symbols: ['AAPL'], target: TARGET, range: '1mo' });
  const n = prov.calls.length;
  const r = await b.sweep({ symbols: ['AAPL'], target: TARGET, range: '1mo' });
  assert.equal(prov.calls.length, n);
  assert.equal(r.skippedFresh, 1);
  assert.equal(count(app, 'SELECT COUNT(*) AS n FROM bar'), 6);
  await app.stop();
});

test('bars: not found and provider errors become gaps, and the sweep carries on', async () => {
  const { app, b } = await make({ bars: { AAPL: days('2026-11-09', '2026-11-16').map(d => bar(d)) } });   // the mock has no entry for GONE: NOT_FOUND
  const r = await b.sweep({ symbols: ['GONE', 'AAPL'], target: TARGET, range: '1mo' });
  assert.equal(r.failed, 1);
  assert.equal(r.symbolsStored, 1);
  assert.equal(app.db.stmt("SELECT reason FROM bar_gap WHERE symbol = 'GONE'").get().reason, 'not_found');
  assert.equal(r.failures[0].code, 'NOT_FOUND');
  await app.stop();
});

test('bars: an unhealthy provider opens the circuit and the sweep stops instead of hammering it', async () => {
  const { app, b, prov } = await make({ bars: Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(s => [s, days('2026-11-09', '2026-11-16').map(d => bar(d))])) });
  prov.failNext(new E.TransientError('down'), 1000);
  const r = await b.sweep({ symbols: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], target: TARGET, range: '1mo' });
  assert.match(r.aborted, /circuit open/);
  assert.ok(r.attempted < 8, `attempted ${r.attempted}`);
  assert.equal(count(app, 'SELECT COUNT(*) AS n FROM bar'), 0);
  assert.ok(b.gapCount() >= 1);
  await app.stop();
});

test('bars: a policy refusal (finance lookups off) stops the sweep at once and says why', async () => {
  const { app, b, prov } = await make({ bars: { A: [], B: [] } });
  prov.failNext(new E.PolicyError('finance lookups are off'), 5);
  const r = await b.sweep({ symbols: ['A', 'B'], target: TARGET, range: '1mo' });
  assert.match(r.aborted, /policy/);
  assert.equal(r.attempted, 1);
  await app.stop();
});

test('bars: a stale cached answer is not stored and shows up as a gap reason', async () => {
  const provider = { name: 'stalemock', capabilities: { ranges: RANGES, intervals: ['1d'] }, async getQuote() { throw new Error('x'); },
    async getHistory({ symbol }) { return { symbol, currency: 'USD', range: '1mo', interval: '1d', source: 'stalemock', fetchedAt: 1, stale: true, ageMs: 9e6, bars: [bar('2026-11-16')], skipped: 0 }; } };
  const { app, b } = await make({ provider });
  const r = await b.sweep({ symbols: ['AAPL'], target: TARGET, range: '1mo' });
  assert.equal(r.failures[0].code, 'STALE');
  assert.equal(count(app, 'SELECT COUNT(*) AS n FROM bar'), 0);
  assert.equal(app.db.stmt('SELECT reason FROM bar_gap').get().reason, 'stale_only');
  await app.stop();
});

test('bars: coverage counts fresh, stale and missing symbols and records one row per sweep', async () => {
  const { app, b } = await make({ bars: { AAPL: days('2026-11-09', '2026-11-16').map(d => bar(d)), MSFT: days('2026-11-09', '2026-11-13').map(d => bar(d)) } });
  const r = await b.sweep({ symbols: ['AAPL', 'MSFT', 'NOPE'], target: TARGET, range: '1mo' });
  const c = b.coverageNow({ symbols: ['AAPL', 'MSFT', 'NOPE'], target: TARGET });
  assert.deepEqual([c.universe, c.fresh, c.stale, c.missing, c.oldestLatestDay, c.newestDay], [3, 1, 1, 1, '2026-11-13', '2026-11-16']);
  b.recordCoverage(c, { failed: r.failed, ms: r.ms });
  const row = b.lastCoverage();
  assert.deepEqual([row.fresh_n, row.stale_n, row.missing_n, row.failed_n], [1, 1, 1, 1]);   // NOPE failed (not found); MSFT answered but has no 11-16 bar, which is a gap, not a failure
  await app.stop();
});

test('bars: calls start at least paceMs apart', async () => {
  let t = 5_000_000;
  const sleeps = [];   // this test's own clock only moves when the sweep sleeps, so the framework limiter is given a roomy rate
  const bars = Object.fromEntries(['A', 'B', 'C'].map(s => [s, days('2026-11-09', '2026-11-16').map(d => bar(d))]));
  const built = createBars({ now: () => t, sleep: async ms => { sleeps.push(ms); t += ms; }, opts: { paceMs: 150 } });
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile: ':memory:', log: () => {}, provider: createMockProvider({ bars, ranges: RANGES, intervals: ['1d'] }), now: () => t, sleep: async () => {} });
  app.use(built.feature); await app.start();
  await built.api.sweep({ symbols: ['A', 'B', 'C'], target: TARGET, range: '1mo' });
  assert.deepEqual(sleeps, [150, 150]);   // none before the first call
  await app.stop();
});

test('bars: stopping mid-sweep keeps what was stored and the next sweep resumes', async () => {
  const bars = Object.fromEntries(['A', 'B', 'C', 'D'].map(s => [s, days('2026-11-09', '2026-11-16').map(d => bar(d))]));
  const { app, b, feature, prov } = await make({ bars });
  const r = await b.sweep({ symbols: ['A', 'B', 'C', 'D'], target: TARGET, range: '1mo', onProgress: p => { if (p.done === 2) feature.stop(); } });
  assert.equal(r.stopped, true);
  assert.equal(r.symbolsStored, 2);
  await feature.start({ db: app.db, stocks: app.stocks });
  const r2 = await b.sweep({ symbols: ['A', 'B', 'C', 'D'], target: TARGET, range: '1mo' });
  assert.equal(r2.skippedFresh, 2);
  assert.equal(r2.symbolsStored, 2);
  assert.equal(prov.calls.length, 4);
  await app.stop();
});

test('bars: the range is the smallest that covers the missing sessions', () => {
  assert.deepEqual([1, 3, 4, 18, 19, 58, 59, 120, 121, 245, 246, 490, 491, 1240, 1241].map(pickRange), ['5d', '5d', '1mo', '1mo', '3mo', '3mo', '6mo', '6mo', '1y', '1y', '2y', '2y', '5y', '5y', '10y']);
});

test('bars: the real Yahoo response shape (captured 2026-11-17) goes through the sweep; BRK.B is asked for as BRK-B', async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stockman-data', 'yahoo-brkb-1mo-1d.json'), 'utf8'));
  const urls = [];
  const provider = createYahooProvider({ http: { async getJson(url) { urls.push(url); return { data: fixture, cached: false, ageMs: 0 }; } } });
  const { app, b } = await make({ provider });
  const r = await b.sweep({ symbols: ['BRK.B'], target: '2026-11-16', range: '1mo' });
  assert.match(urls[0], /chart\/BRK-B\?range=1y&interval=1d/);
  assert.equal(r.symbolsStored, 1);
  const last = app.db.stmt("SELECT * FROM bar WHERE symbol = 'BRK.B' ORDER BY day DESC LIMIT 1").get();
  assert.equal(last.day, '2026-11-16');
  assert.ok(last.close > 0 && last.adj_close > 0 && last.source === 'yahoo');
  assert.equal(count(app, "SELECT COUNT(*) AS n FROM bar WHERE day > '2026-11-16'"), 0);
  assert.equal(b.gapCount(), 0, 'the captured month has every session: no invented gap');
  await app.stop();
});
