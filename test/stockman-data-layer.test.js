// Integration tests for the data layer: universe + bars + calendar + runs, registered on the real framework (createStockman) with the
// provider mocked, the network mocked (fixtures captured from real responses on 2026-11-17) and the clock controlled.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStockman } = require('../src/core/stockman/app');
const { createMockProvider } = require('../src/core/stockman/stocks/mock');
const { createDataLayer } = require('../src/core/stockman/features');
const { parseSp500, parseNasdaqApi } = require('../src/core/stockman/features/universe');
const { nyWallToMs } = require('../src/core/stockman/features/ny-time');
const { tradingDays } = require('../src/core/stockman/features/calendar-rules');
const { describeHealth } = require('../src/core/stockman/jarvis/tools');
const E = require('../src/core/stockman/errors');

const FX = path.join(__dirname, 'fixtures', 'stockman-data');
const fx = f => fs.readFileSync(path.join(FX, f), 'utf8');
const SP_NOW = fx('sp500-now-excerpt.html'), NDX_API = fx('nasdaq-ndx100.json'), NDX_WIKI = fx('ndx-list-now-excerpt.html');
const ROUTES = {
  'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies': SP_NOW,
  'https://api.nasdaq.com/api/quote/list-type/nasdaq100': NDX_API,
  'https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies': NDX_WIKI,
};
const ALL = [...new Set([...parseSp500(SP_NOW).map(r => r.symbol), ...parseNasdaqApi(JSON.parse(NDX_API)).map(r => r.symbol)])];
const RANGES = ['5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y'];

const bar = (day, px = 100) => ({ t: nyWallToMs(day, '09:30'), open: px, high: px + 2, low: px - 2, close: px + 1, adjClose: px + 0.5, volume: 1000 });
// every symbol gets a bar on every trading day from 2026-11-09 to 2026-11-30 except `skip`
function allBars({ skip = [], symbols = ALL } = {}) {
  return Object.fromEntries(symbols.map(s => [s, tradingDays('2026-11-09', '2026-11-30').filter(d => !skip.includes(d)).map(d => bar(d))]));
}
// a clock that moves a little on every read (the framework's sleeping rate limiter always makes progress) and can be set or jumped
function clock(iso) { let t = Date.parse(iso); const now = () => (t += 1); now.set = i => { t = Date.parse(i); }; now.jump = ms => { t += ms; }; return now; }
const fakeFetcher = routes => ({ calls: [], async getText(source, url) { this.calls.push({ source, url }); const v = typeof routes[url] === 'function' ? routes[url](url) : routes[url]; if (v === undefined) throw new Error(`HTTP 404 from ${new URL(url).hostname}`); if (v instanceof Error) throw v; return { data: v, cached: false, ageMs: 0 }; } });

async function layerApp({ bars = allBars(), routes = ROUTES, now = clock('2026-11-17T02:00:00Z'), file = ':memory:', provider, options = {} } = {}) {
  const prov = provider || createMockProvider({ bars, ranges: RANGES, intervals: ['1d'], now });
  const fetcher = fakeFetcher(routes);
  // history (deep bars, earnings) and the benchmark are off here unless a test asks: these tests are about the daily data; history has its own tests
  const layer = createDataLayer({ fetcher, now, sleep: async () => {}, autoRun: false, options: { ...options, universe: { sane: { sp500: [1, 600], ndx100: [1, 600] }, backfill: false, ...options.universe }, runs: { history: false, benchmarks: [], ...options.runs } } });
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile: file, log: () => {}, provider: prov, now, sleep: async () => {} });
  for (const f of layer.features) app.use(f);
  await app.start();
  return { app, layer, api: layer.api, prov, fetcher, now, bars };
}
const n = (app, sql, ...a) => Number(app.db.stmt(sql).get(...a).n);
const noBackfill = { runs: { backfill: false } };

test('data layer: migrations 2 to 7 sit above the framework, every table exists, and health carries data_quality', async () => {
  const { app } = await layerApp();
  assert.equal(app.db.version, 12);
  const tables = app.db.stmt("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name);
  for (const t of ['meta', 'engine_event', 'universe_snapshot', 'universe_member', 'bar', 'bar_gap', 'coverage', 'market_day', 'catchup_gap', 'run', 'run_stage', 'bar_history', 'earnings_fetch', 'earnings_event']) assert.ok(tables.includes(t), t);
  assert.ok(typeof app.health().dataQuality.runs.summary === 'string');
  assert.deepEqual(app.health().features, ['universe', 'bars', 'calendar', 'earnings', 'spreads', 'runs', 'scoring', 'shadow', 'calibration']);
  await app.stop();
});

test('runs: the first cycle makes one run, ingests it, and data_quality says what is true (and does not claim real time)', async () => {
  const { app, api, prov } = await layerApp({ options: noBackfill });
  const r = await api.runs.runCycle({ reason: 'test' });
  assert.equal(r.status, 'ok');
  assert.equal(r.target, '2026-11-16');
  assert.equal(r.work, 1);
  const run = api.runs.getRun('2026-11-16');
  assert.deepEqual([run.run_id, run.state], ['run-2026-11-16', 'ingested']);
  assert.deepEqual(api.runs.stagesOf('2026-11-16').map(s => [s.stage, s.status, s.attempts]), [['ingest', 'ok', 1], ['universe', 'ok', 1]]);
  assert.equal(prov.calls.length, ALL.length);
  assert.ok(prov.calls.every(c => c.args[0].range === '1y'), 'first sweep asks for the initial history');
  assert.equal(n(app, "SELECT COUNT(*) AS n FROM bar WHERE day > '2026-11-16'"), 0, 'the later bars the mock holds are not stored');
  const dq = app.health().dataQuality.runs;
  assert.equal(dq.coverage.fresh, ALL.length);
  assert.equal(dq.coverage.of, ALL.length);
  assert.equal(dq.coverage.newestDay, '2026-11-16');
  assert.equal(dq.lastRun.state, 'ingested');
  assert.match(dq.summary, new RegExp(`daily bars through 2026-11-16 for ${ALL.length} of ${ALL.length} symbols fresh`));
  assert.match(dq.summary, /quote delay is not measured/i);
  assert.ok(!/real.?time/i.test(dq.summary.replace(/not real.?time/i, '')));
  assert.match(describeHealth(app.health()), /data layer: daily bars through 2026-11-16/);   // what the jarvis status tool says
  assert.equal(app.events.recent({ source: 'runs' }).length >= 1, true);
  await app.stop();
});

test('runs: running again is a no-op (idempotent): no network, no new rows, same run', async () => {
  const { app, api, prov, fetcher } = await layerApp({ options: noBackfill });
  await api.runs.runCycle();
  const calls = prov.calls.length, fcalls = fetcher.calls.length, bars = n(app, 'SELECT COUNT(*) AS n FROM bar');
  const r = await api.runs.runCycle();
  assert.equal(r.status, 'up_to_date');
  assert.equal(prov.calls.length, calls);
  assert.equal(fetcher.calls.length, fcalls);
  assert.equal(n(app, 'SELECT COUNT(*) AS n FROM bar'), bars);
  assert.equal(n(app, 'SELECT COUNT(*) AS n FROM run'), 1);
  assert.equal(api.runs.needsCycle(), false);
  await app.stop();
});

test('catch-up: jarvis closed for five sessions: one run per missed session, one sweep, all ingested, nothing invented', async () => {
  const { app, api, prov, now } = await layerApp({ options: noBackfill });
  await api.runs.runCycle();
  prov.calls.length = 0;
  now.set('2026-11-24T02:00:00Z');   // Monday 21:00 New York; the app was closed Tue 17 to Fri 20 and today's session (Mon 23) has finished
  assert.equal(api.runs.needsCycle(), true);
  const r = await api.runs.runCycle({ reason: 'start' });
  assert.equal(r.status, 'ok');
  assert.equal(r.target, '2026-11-23');
  assert.equal(r.newRuns, 5);
  assert.equal(r.missedSessions, 5);
  assert.equal(r.range, '1mo');
  assert.deepEqual(api.runs.listRuns().map(x => x.tradeDay), ['2026-11-23', '2026-11-20', '2026-11-19', '2026-11-18', '2026-11-17', '2026-11-16']);
  assert.ok(api.runs.listRuns().every(x => x.state === 'ingested'));
  assert.equal(prov.calls.length, ALL.length, 'one request per symbol covers the whole gap');
  assert.equal(n(app, "SELECT COUNT(DISTINCT day) AS n FROM bar"), 11);   // 11-09 to 11-23: the first sweep already held the earlier history
  assert.equal(n(app, 'SELECT COUNT(*) AS n FROM bar_gap'), 0);
  assert.equal(n(app, 'SELECT COUNT(*) AS n FROM catchup_gap'), 0);
  await app.stop();
});

test('catch-up: Thanksgiving week: the holiday is not a run, the check finds no doubt, and the early close counts as a day', async () => {
  const { app, api, now } = await layerApp({ bars: allBars({ skip: ['2026-11-26'] }), options: noBackfill });
  await api.runs.runCycle();
  now.set('2026-11-28T15:00:00Z');   // Saturday
  const r = await api.runs.runCycle();
  assert.equal(r.target, '2026-11-27');
  assert.deepEqual(api.runs.listRuns({ limit: 3 }).map(x => x.tradeDay), ['2026-11-27', '2026-11-25', '2026-11-24']);
  assert.equal(app.db.stmt("SELECT kind FROM market_day WHERE day = '2026-11-27'").get().kind, 'early');
  assert.equal(app.db.stmt("SELECT verdict FROM market_day WHERE day = '2026-11-26'").get().verdict, 'ok');
  assert.deepEqual(api.calendar.suspects(), []);
  await app.stop();
});

test('calendar check: bars on a day the calendar calls closed, or none on an open day, are flagged, never smoothed over', async () => {
  const { app, api, now } = await layerApp({ bars: allBars({ skip: ['2026-11-18'] }), options: noBackfill });   // nothing for Wed 18 although it is a trading day
  await api.runs.runCycle();
  now.set('2026-11-20T23:00:00Z');
  const r = await api.runs.runCycle();
  assert.equal(r.status, 'ok');
  const gap = api.calendar.unfillable();
  assert.equal(gap.length, 1);
  assert.deepEqual([gap[0].day, gap[0].reason], ['2026-11-18', 'no_bars_any_symbol']);
  assert.deepEqual(api.calendar.suspects().map(s => [s.day, s.verdict]), [['2026-11-18', 'suspect_closed']]);
  assert.equal(n(app, "SELECT COUNT(*) AS n FROM bar WHERE day = '2026-11-18'"), 0, 'the missing day is not filled');
  assert.equal(api.runs.getRun('2026-11-18').state, 'ingested');
  const dq = app.health().dataQuality.runs;
  assert.equal(dq.gaps.unfillable, 1);
  assert.match(dq.summary, /calendar doubts: 2026-11-18 suspect closed/);
  assert.match(dq.summary, /108 open symbol-day gaps over 1 day; 1 catch-up gap not fillable/);
  // the reverse: a bar on a day the calendar says is a holiday
  const wrong = api.calendar.crossCheck({ counts: { '2026-11-26': 5 }, universeN: 10 });
  assert.deepEqual(wrong.map(s => s.verdict), ['suspect_open']);
  assert.deepEqual(api.calendar.crossCheck({ counts: { '2026-11-19': 3 }, universeN: 10 }).map(s => s.verdict), ['partial']);
  await app.stop();
});

test('runs: a provider outage leaves the run unfinished with the reason, and the next cycle resumes it', async () => {
  const { app, api, prov, now } = await layerApp({ options: noBackfill });
  prov.failNext(new E.TransientError('provider down'), 100000);
  const r1 = await api.runs.runCycle();
  assert.equal(r1.status, 'incomplete');
  assert.match(r1.sweep.aborted, /circuit open/);
  const run = api.runs.getRun('2026-11-16');
  assert.equal(run.state, 'universe_ok');
  assert.match(run.last_error, /sweep stopped/);
  assert.equal(api.runs.needsCycle(), true);
  let dq = app.health().dataQuality.runs;
  assert.match(dq.summary, /run run-2026-11-16 not finished \(universe_ok: sweep stopped/);
  assert.equal(dq.coverage.fresh < ALL.length, true);
  // the provider recovers (the breaker's cool-down passes); the same run continues from its failed stage
  prov.failNext(new E.TransientError('x'), 0);
  now.jump(120000);
  const r2 = await api.runs.runCycle();
  assert.equal(r2.status, 'ok');
  assert.equal(api.runs.getRun('2026-11-16').state, 'ingested');
  assert.equal(api.runs.getRun('2026-11-16').last_error, null);
  assert.equal(api.runs.stagesOf('2026-11-16').find(s => s.stage === 'ingest').attempts, 2);
  assert.equal(n(app, 'SELECT COUNT(*) AS n FROM run'), 1, 'no second run was created');
  dq = app.health().dataQuality.runs;
  assert.equal(dq.coverage.fresh, ALL.length);
  await app.stop();
});

test('runs: no universe (the lists cannot be fetched) stops at stage one, flagged; it resumes when they can', async () => {
  let down = true;
  const routes = { ...Object.fromEntries(Object.entries(ROUTES).map(([k, v]) => [k, () => { if (down) throw new E.TransientError('network down'); return v; }])) };
  const { app, api } = await layerApp({ routes, options: noBackfill });
  const r1 = await api.runs.runCycle();
  assert.equal(r1.status, 'failed_universe');
  assert.equal(api.runs.getRun('2026-11-16').state, 'created');
  assert.match(api.runs.stagesOf('2026-11-16')[0].error, /universe none/);
  assert.match(app.health().dataQuality.runs.summary, /no universe yet/);
  down = false;
  const r2 = await api.runs.runCycle();
  assert.equal(r2.status, 'ok');
  assert.equal(api.runs.stagesOf('2026-11-16').find(s => s.stage === 'universe').attempts, 2);
  await app.stop();
});

test('runs: a day far below the coverage floor is retried, then accepted as partial and recorded, not hidden', async () => {
  const half = allBars();
  const gone = ALL.slice(0, Math.ceil(ALL.length * 0.4));
  for (const s of gone) delete half[s];   // the mock answers NOT_FOUND for these: 60% coverage, under the 90% floor
  const { app, api } = await layerApp({ bars: half, options: noBackfill });
  const r1 = await api.runs.runCycle();
  assert.equal(r1.status, 'incomplete');
  assert.equal(api.runs.getRun('2026-11-16').state, 'universe_ok');
  await api.runs.runCycle();
  const r3 = await api.runs.runCycle();   // third attempt
  assert.equal(r3.status, 'ok');
  assert.equal(api.runs.getRun('2026-11-16').state, 'ingested');
  const gap = api.calendar.unfillable();
  assert.deepEqual(gap.map(g => g.reason), ['low_coverage']);
  assert.match(gap[0].detail, /symbols have a bar after 3 attempts/);
  assert.ok(app.health().dataQuality.runs.coverage.missing >= gone.length);
  assert.ok(n(app, "SELECT COUNT(*) AS n FROM bar_gap WHERE reason = 'not_found'") >= gone.length);
  await app.stop();
});

test('runs: a stage left running by a crash is marked interrupted at the next start, and the run resumes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockman-runs-'));
  const file = path.join(dir, 'stockman.db');
  const now = clock('2026-11-17T02:00:00Z');
  let a = await layerApp({ file, now, options: noBackfill });
  await a.api.runs.runCycle();
  a.app.db.stmt("UPDATE run SET state = 'universe_ok' WHERE run_id = 'run-2026-11-16'").run();
  a.app.db.stmt("UPDATE run_stage SET status = 'running', finished_at = NULL WHERE run_id = 'run-2026-11-16' AND stage = 'ingest'").run();
  await a.app.stop();
  a = await layerApp({ file, now, options: noBackfill });
  const st = a.api.runs.stagesOf('2026-11-16').find(s => s.stage === 'ingest');
  assert.equal(st.status, 'failed');
  assert.match(st.error, /interrupted/);
  const r = await a.api.runs.runCycle();
  assert.equal(r.status, 'ok');
  assert.equal(a.api.runs.getRun('2026-11-16').state, 'ingested');
  assert.equal(r.sweep.skippedFresh, ALL.length, 'the bars already stored were not fetched again');
  await a.app.stop();
});

test('runs: stopping the engine mid-sweep ends cleanly, keeps stored bars, and the next start finishes the job', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockman-runs-'));
  const file = path.join(dir, 'stockman.db');
  const now = clock('2026-11-17T02:00:00Z');
  const base = createMockProvider({ bars: allBars(), ranges: RANGES, intervals: ['1d'], now });
  let calls = 0, stopping = null, appRef = null;
  const provider = { ...base, async getHistory(req) { calls++; if (calls === 5 && !stopping) stopping = appRef.stop(); return base.getHistory(req); } };
  let a = await layerApp({ file, now, provider, options: noBackfill });
  appRef = a.app;
  const r = await a.api.runs.runCycle();
  await stopping;
  assert.equal(r.sweep.stopped, true);
  assert.equal(r.status, 'incomplete');
  assert.ok(r.sweep.symbolsStored >= 4 && r.sweep.symbolsStored < ALL.length);
  const stored = r.sweep.symbolsStored;
  a = await layerApp({ file, now, options: noBackfill });
  const r2 = await a.api.runs.runCycle();
  assert.equal(r2.status, 'ok');
  assert.equal(r2.sweep.skippedFresh, stored);
  assert.equal(r2.sweep.attempted, ALL.length - stored);
  assert.equal(a.app.health().dataQuality.runs.coverage.fresh, ALL.length);
  await a.app.stop();
});

test('universe history runs after the daily data, a few snapshots per cycle, and a failure there does not touch the run', async () => {
  const routes = { ...ROUTES, 'https://en.wikipedia.org/w/api.php?action=query&prop=revisions&titles=List%20of%20S%26P%20500%20companies&rvlimit=1&rvprop=ids%7Ctimestamp&rvdir=older&rvstart=2020-01-01T00:00:00Z&format=json': new E.TransientError('wikipedia busy') };
  const { app, api } = await layerApp({ routes, now: clock('2026-11-17T02:00:00Z'), options: { universe: { backfillFrom: '2026-01-01', backfillPerRun: 2 }, runs: { backfill: true } } });
  const r = await api.runs.runCycle();
  assert.equal(r.status, 'ok');
  assert.equal(r.backfill.attempted, 2);
  assert.equal(api.runs.getRun('2026-11-16').state, 'ingested');
  assert.ok(app.health().dataQuality.runs.pointInTimeHistory.total >= 6);
  await app.stop();
});

test('runs: the finance switch off (policy) is reported, not hidden, and nothing is stored', async () => {
  const policy = Object.assign(new Error('finance lookups are off'), { code: 'REFUSED' });
  const { app, api } = await layerApp({ routes: Object.fromEntries(Object.keys(ROUTES).map(k => [k, policy])), options: noBackfill });
  const r = await api.runs.runCycle();
  assert.equal(r.status, 'failed_universe');
  assert.match(r.error, /universe none/);
  assert.equal(n(app, 'SELECT COUNT(*) AS n FROM bar'), 0);
  await app.stop();
});

test('runs: cycles do not overlap', async () => {
  const { app, api } = await layerApp({ options: noBackfill });
  const [a, b] = await Promise.all([api.runs.runCycle(), api.runs.runCycle()]);
  assert.deepEqual([a.status, b.status].sort(), ['busy', 'ok']);
  await app.stop();
});

test('catch-up: a gap longer than the widest range is cut and the cut is recorded', async () => {
  const { app, api, now } = await layerApp({ options: noBackfill });
  await api.runs.runCycle();
  now.set('2035-06-10T02:00:00Z');   // nine years later: more sessions than the 5y range holds
  const r = await api.runs.runCycle();
  assert.ok(r.newRuns <= 1240);
  assert.ok(api.calendar.unfillable({ limit: 5000 }).some(g => g.reason === 'beyond_provider_range'));
  assert.equal(r.range, '5y');   // the cut leaves exactly the widest span we ask for
  assert.ok(n(app, 'SELECT COUNT(*) AS n FROM bar_gap') < 108 * 40, 'a long missing run is summarised, not stored day by day');
  await app.stop();
});
