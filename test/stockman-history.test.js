// Tests for the backtest data (vault note 06, G15, G23): deep bars back to historyFrom with re-adjustment, the benchmark, the earnings
// calendar and its flags, and the history steps in runs. Network and provider mocked; the earnings answers are real excerpts (fixtures README).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStockman } = require('../src/core/stockman/app');
const { createMockProvider } = require('../src/core/stockman/stocks/mock');
const { createBars } = require('../src/core/stockman/features/bars');
const { createEarnings, parseCalendar, money, usDate } = require('../src/core/stockman/features/earnings');
const { createDataLayer } = require('../src/core/stockman/features');
const { parseSp500, parseNasdaqApi } = require('../src/core/stockman/features/universe');
const { nyWallToMs } = require('../src/core/stockman/features/ny-time');
const { tradingDays } = require('../src/core/stockman/features/calendar-rules');
const E = require('../src/core/stockman/errors');

const FX = path.join(__dirname, 'fixtures', 'stockman-data');
const fx = f => fs.readFileSync(path.join(FX, f), 'utf8');
const PAST = fx('nasdaq-earnings-2020-01-28-excerpt.json'), FUTURE = fx('nasdaq-earnings-2026-11-19-excerpt.json'), EMPTY = fx('nasdaq-earnings-2026-11-21-saturday.json');
const RANGES = ['5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y'];
const TARGET = '2026-11-16';

const bar = (day, px = 100, adj = px + 0.5) => ({ t: nyWallToMs(day, '09:30'), open: px, high: px + 2, low: px - 2, close: px + 1, adjClose: adj, volume: 1000 });
const series = (from, to, px) => tradingDays(from, to).map(d => bar(d, px));
function clock(iso) { let t = Date.parse(iso); const now = () => (t += 1); now.set = i => { t = Date.parse(i); }; now.jump = ms => { t += ms; }; return now; }
const n = (app, sql, ...a) => Number(app.db.stmt(sql).get(...a).n);

async function barsApp({ bars = {}, now = clock('2026-11-17T02:00:00Z'), opts = {} } = {}) {
  const prov = createMockProvider({ bars, ranges: RANGES, intervals: ['1d'], now });
  const built = createBars({ now, sleep: async () => {}, opts });
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile: ':memory:', log: () => {}, provider: prov, now, sleep: async () => {} });
  app.use(built.feature);
  await app.start();
  return { app, b: built.api, prov, bars, now };
}

// ---- deep bars ------------------------------------------------------------------------------------------------------------------
test('deep history: one full fetch per symbol from the start date, nothing older or unfinished stored, delisted names recorded', async () => {
  const { app, b, prov } = await barsApp({ bars: { AAA: series('2019-09-02', '2026-11-17', 50), NEW: series('2023-03-01', '2026-11-17', 20) } });
  const r = await b.deepen({ symbols: ['AAA', 'NEW', 'GONE'], from: '2019-10-01', target: TARGET });
  assert.deepEqual([r.ok, r.notFound, r.failed, r.range], [2, 1, 0, '10y']);
  const want = tradingDays('2019-10-01', TARGET).length;
  assert.equal(n(app, "SELECT COUNT(*) AS n FROM bar WHERE symbol = 'AAA'"), want);
  assert.equal(n(app, "SELECT COUNT(*) AS n FROM bar WHERE day < '2019-10-01' OR day > ?", TARGET), 0, 'nothing before the start, no session in progress');
  const h = Object.fromEntries(app.db.stmt('SELECT * FROM bar_history').all().map(r => [r.symbol, r]));
  assert.deepEqual([h.AAA.status, h.AAA.first_day, h.AAA.last_day, h.AAA.n, h.AAA.missing_n], ['ok', '2019-10-01', TARGET, want, 0]);
  assert.match(h.NEW.note, /series starts 2023-03-01/);
  assert.equal(h.GONE.status, 'not_found');
  const s = b.deepStatus({ symbols: ['AAA', 'NEW', 'GONE'], from: '2019-10-01' });
  assert.deepEqual([s.ok, s.notFound, s.pending, s.notFoundSymbols], [2, 1, 0, ['GONE']]);
  // done is done: a second pass fetches nothing
  const calls = prov.calls.length;
  assert.equal((await b.deepen({ symbols: ['AAA', 'NEW', 'GONE'], from: '2019-10-01', target: TARGET })).attempted, 0);
  assert.equal(prov.calls.length, calls);
  // an earlier start asks again, including for the name the provider did not know
  assert.deepEqual(b.deepPending({ symbols: ['AAA', 'NEW', 'GONE'], from: '2019-01-01' }).sort(), ['AAA', 'GONE', 'NEW']);
  await app.stop();
});

test('deep history: a symbol with a gap in its series is stored as returned, the gap counted, nothing filled', async () => {
  const s = series('2026-10-01', '2026-11-17', 10).filter(x => x.t !== nyWallToMs('2026-10-15', '09:30'));
  const { app, b } = await barsApp({ bars: { HOL: s } });
  await b.deepen({ symbols: ['HOL'], from: '2026-10-01', target: TARGET });
  assert.equal(app.db.stmt("SELECT missing_n FROM bar_history WHERE symbol = 'HOL'").get().missing_n, 1);
  assert.equal(n(app, "SELECT COUNT(*) AS n FROM bar WHERE symbol = 'HOL' AND day = '2026-10-15'"), 0);
  assert.equal(n(app, "SELECT COUNT(*) AS n FROM bar_gap WHERE symbol = 'HOL' AND day = '2026-10-15' AND resolved_at IS NULL"), 1);
  await app.stop();
});

test('deep history: a failing symbol is retried a bounded number of times, then left for the report', async () => {
  const { app, b, prov } = await barsApp({ bars: {}, opts: { deepAttempts: 3 } });
  prov.failNext(new E.ProviderDataError('mock: garbled'), 1000);
  for (let i = 0; i < 4; i++) await b.deepen({ symbols: ['BAD'], from: '2026-10-01', target: TARGET });
  const row = app.db.stmt("SELECT status, attempts FROM bar_history WHERE symbol = 'BAD'").get();
  assert.equal(row.status, 'failed');
  assert.ok(row.attempts >= 3);
  assert.deepEqual(b.deepPending({ symbols: ['BAD'], from: '2026-10-01' }), []);
  assert.equal(b.deepStatus({ symbols: ['BAD'], from: '2026-10-01' }).failed, 1);
  await app.stop();
});

test('re-adjustment: a daily sweep that sees stored closes change (a dividend) flags the symbol, and the next deep fetch rewrites the series on one basis', async () => {
  const { app, b, bars } = await barsApp({ bars: { DIV: series('2026-10-01', '2026-11-17', 40) } });
  await b.deepen({ symbols: ['DIV'], from: '2026-10-01', target: TARGET });
  // the provider now answers a short range with every adjusted close 1% lower: an ex-dividend day happened
  bars.DIV = tradingDays('2026-11-11', '2026-11-18').map(d => bar(d, 40, (40 + 0.5) * 0.99));
  const r = await b.sweep({ symbols: ['DIV'], target: '2026-11-17', range: '5d' });
  assert.equal(r.readjust, 1);
  assert.equal(app.db.stmt("SELECT status FROM bar_history WHERE symbol = 'DIV'").get().status, 'readjust');
  assert.deepEqual(b.deepPending({ symbols: ['DIV'], from: '2026-10-01' }), ['DIV']);
  // the full series, all on the new basis
  bars.DIV = tradingDays('2026-10-01', '2026-11-18').map(d => bar(d, 40, (40 + 0.5) * 0.99));
  await b.deepen({ symbols: ['DIV'], from: '2026-10-01', target: '2026-11-17' });
  assert.equal(app.db.stmt("SELECT status FROM bar_history WHERE symbol = 'DIV'").get().status, 'ok');
  const adj = app.db.stmt("SELECT DISTINCT ROUND(adj_close, 6) AS a FROM bar WHERE symbol = 'DIV'").all().map(x => x.a);
  assert.deepEqual(adj, [Math.round(40.5 * 0.99 * 1e6) / 1e6]);
  await app.stop();
});

test('re-adjustment: identical numbers, or a fetch that returns the whole stored span, never flag', async () => {
  const { app, b, bars } = await barsApp({ bars: { SAME: series('2026-10-01', '2026-11-17', 30) } });
  await b.sweep({ symbols: ['SAME'], target: TARGET, range: '1mo' });
  bars.SAME = series('2026-10-01', '2026-11-18', 30).map(x => ({ ...x, adjClose: x.adjClose * 0.98 }));   // whole span: everything is rewritten together
  assert.equal((await b.sweep({ symbols: ['SAME'], target: '2026-11-17', range: '5d' })).readjust, 0);
  bars.SAME = tradingDays('2026-11-12', '2026-11-19').map(d => bar(d, 30, 30.5 * 0.98));                  // same numbers as stored
  assert.equal((await b.sweep({ symbols: ['SAME'], target: '2026-11-18', range: '5d' })).readjust, 0);
  assert.equal(n(app, "SELECT COUNT(*) AS n FROM bar_history WHERE status = 'readjust'"), 0);
  await app.stop();
});

test('bar counts per day can be limited to a symbol list (deep and benchmark bars are not today\'s universe)', async () => {
  const { app, b } = await barsApp({ bars: { A: series('2026-11-09', '2026-11-17'), B: series('2026-11-09', '2026-11-17'), SPY: series('2026-11-09', '2026-11-17') } });
  await b.sweep({ symbols: ['A', 'B', 'SPY'], target: TARGET, range: '1mo' });
  assert.deepEqual(b.symbolsWithBarOn([TARGET]), { [TARGET]: 3 });
  assert.deepEqual(b.symbolsWithBarOn([TARGET], ['A', 'B']), { [TARGET]: 2 });
  await app.stop();
});

// ---- earnings -------------------------------------------------------------------------------------------------------------------
test('earnings parser: real past, future and empty answers; money, dates and bad shapes', () => {
  const past = parseCalendar(JSON.parse(PAST));
  assert.equal(past.rows.length, 5);
  const aapl = past.rows.find(r => r.symbol === 'AAPL');
  assert.deepEqual([aapl.eps, aapl.epsForecast, aapl.surprisePct, aapl.timing, aapl.fiscalQuarter], [4.99, 4.54, 9.91, 'unknown', 'Dec/2019']);
  const fut = parseCalendar(JSON.parse(FUTURE));
  assert.deepEqual(fut.rows.map(r => `${r.symbol}:${r.timing}`).sort(), ['INTU:after', 'ROST:after', 'WMT:pre']);
  assert.equal(fut.rows.find(r => r.symbol === 'WMT').lastYearDay, '2025-11-20');
  assert.equal(fut.rows.find(r => r.symbol === 'WMT').eps, null);
  assert.deepEqual(parseCalendar(JSON.parse(EMPTY)), { rows: [], skipped: 0 });
  assert.equal(parseCalendar({}), null);
  assert.equal(parseCalendar({ data: { rows: 'x' } }), null);
  assert.deepEqual(parseCalendar({ data: { rows: [{ symbol: 'BRK/B', time: 'time-pre-market' }, { symbol: 'not a ticker!' }] } }).rows.map(r => r.symbol), ['BRK.B']);
  assert.deepEqual([money('$4.99'), money('($0.12)'), money('-$0.50'), money('N/A'), money(''), money('$1,234.50')], [4.99, -0.12, -0.5, null, null, 1234.5]);
  assert.deepEqual([usDate('11/20/2025'), usDate('1/5/2020'), usDate('N/A')], ['2025-11-20', '2020-01-05', null]);
});

// routes for the earnings tests: the real future excerpt on 2026-11-19, the real past excerpt re-dated to 2026-11-05, empty elsewhere
const earningsRoutes = (over = {}) => url => {
  const day = new URL(url).searchParams.get('date');
  if (day in over) { const v = over[day]; if (v instanceof Error) throw v; return v; }
  return day === '2026-11-19' ? FUTURE : day === '2026-11-05' ? PAST : EMPTY;
};
function earningsFetcher(route) {
  return { calls: [], async getText(source, url) { this.calls.push({ source, url }); return { data: route(url), cached: false, ageMs: 0 }; } };
}
async function earningsApp({ route = earningsRoutes(), now = clock('2026-11-17T15:00:00Z'), opts = {} } = {}) {
  const fetcher = earningsFetcher(route);
  const built = createEarnings({ fetcher, now, sleep: async () => {}, opts: { historyFrom: '2026-11-02', lookaheadDays: 14, ...opts } });
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile: ':memory:', log: () => {}, provider: createMockProvider({ now }), now, sleep: async () => {} });
  app.use(built.feature);
  await app.start();
  return { app, e: built.api, fetcher, now };
}

test('earnings: a step fetches the coming weeks and the past once, on the finance source, and stores what each date lists', async () => {
  const { app, e, fetcher } = await earningsApp();
  const r = await e.step({ limit: 1000 });
  assert.equal(r.failed, 0);
  assert.equal(r.remaining, 0);
  assert.ok(fetcher.calls.every(c => c.source === 'finance' && c.url.startsWith('https://api.nasdaq.com/api/calendar/earnings?date=')));
  assert.equal(new Set(fetcher.calls.map(c => c.url)).size, fetcher.calls.length, 'each date once');
  assert.ok(!fetcher.calls.some(c => /date=2026-11-(07|08|14|15)/.test(c.url)), 'weekends are not asked');
  const ev = Object.fromEntries(app.db.stmt('SELECT * FROM earnings_event').all().map(x => [`${x.symbol} ${x.report_day}`, x]));
  assert.deepEqual([ev['WMT 2026-11-19'].kind, ev['WMT 2026-11-19'].timing], ['scheduled', 'pre']);
  assert.deepEqual([ev['AAPL 2026-11-05'].kind, ev['AAPL 2026-11-05'].eps], ['actual', 4.99]);
  assert.equal((await e.step({ limit: 1000 })).attempted, 0, 'nothing due until the coming dates need a refresh');
  await app.stop();
});

test('earnings: dates move (a refetch replaces that date), past forecasts are fetched again once they happened, failures keep good rows', async () => {
  const over = {};
  const { app, e, now } = await earningsApp({ route: earningsRoutes(over) });
  await e.step({ limit: 1000 });
  // next day: INTU moved off 11-19; the coming dates are due again, the past ones are not
  now.set('2026-11-18T15:00:00Z');
  const one = JSON.parse(FUTURE); one.data.rows = one.data.rows.filter(x => x.symbol === 'WMT');
  over['2026-11-19'] = JSON.stringify(one);
  const due = e.pendingDays();
  assert.ok(due.includes('2026-11-19') && !due.includes('2026-11-05'));
  await e.step({ limit: 1000 });
  assert.deepEqual(app.db.stmt("SELECT symbol FROM earnings_event WHERE report_day = '2026-11-19'").all().map(x => x.symbol), ['WMT']);
  // after 11-19 has passed, it is fetched once more for what happened, then it is final
  now.set('2026-11-21T15:00:00Z');
  over['2026-11-20'] = new Error('HTTP 500 from api.nasdaq.com');
  assert.ok(e.pendingDays().includes('2026-11-19'));
  const r = await e.step({ limit: 1000 });
  assert.equal(app.db.stmt("SELECT kind FROM earnings_event WHERE report_day = '2026-11-19'").get().kind, 'actual');
  assert.ok(r.failed >= 1);
  const f = app.db.stmt("SELECT status, attempts FROM earnings_fetch WHERE day = '2026-11-20'").get();
  assert.equal(f.status, 'ok', 'a failed refetch never downgrades an earlier good fetch');
  assert.equal(e.status().failed, 0);
  await app.stop();
});

test('earnings: the finance switch off stops the step at once and says so', async () => {
  const refused = Object.assign(new Error('finance lookups are off'), { code: 'REFUSED' });
  const { e, fetcher } = await earningsApp({ route: () => { throw refused; } });
  const r = await e.step({ limit: 1000 });
  assert.match(r.aborted, /policy/);
  assert.equal(fetcher.calls.length, 1);
});

test('earnings flags follow note 06: in window (with the day after exit), confirmed clear, estimated, unknown', async () => {
  const { e } = await earningsApp({ opts: { lookaheadDays: 28 } });
  await e.step({ limit: 1000 });
  // INTU reports 11-19 after the close. Exit 11-18: the window runs to the next session, 11-19: in window
  assert.deepEqual(e.flags({ symbol: 'INTU', entryDay: '2026-11-17', exitDay: '2026-11-18' }), { earnings_in_window: true, earnings_possible: false, earnings_data: 'confirmed', report: { day: '2026-11-19', timing: 'after', kind: 'scheduled' } });
  // WMT, a window before its 11-19 report, every date in the window fetched: confirmed clear
  assert.deepEqual(e.flags({ symbol: 'WMT', entryDay: '2026-11-09', exitDay: '2026-11-13' }), { earnings_in_window: false, earnings_possible: false, earnings_data: 'confirmed', next: '2026-11-19' });
  // AAPL reported 11-05 (re-dated fixture); a window around 11-05 + 91 days (2027-02-04), beyond what was fetched: estimated, possible
  const est = e.flags({ symbol: 'AAPL', entryDay: '2027-02-01', exitDay: '2027-02-05' });
  assert.deepEqual([est.earnings_in_window, est.earnings_possible, est.earnings_data, est.estimate], [false, true, 'estimated', '2027-02-04']);
  // a window far from the estimate: estimated, not possible
  assert.equal(e.flags({ symbol: 'AAPL', entryDay: '2026-12-07', exitDay: '2026-12-11' }).earnings_possible, false);
  // never seen: unknown, and it says why
  const unk = e.flags({ symbol: 'ZZZZ', entryDay: '2026-11-09', exitDay: '2026-11-13' });
  assert.deepEqual([unk.earnings_data, unk.earnings_in_window, unk.earnings_possible], ['unknown', false, false]);
  assert.throws(() => e.flags({ symbol: 'bad!', entryDay: '2026-11-09', exitDay: '2026-11-13' }), E.InvalidRequestError);
});

// ---- the history steps in runs ----------------------------------------------------------------------------------------------------
const SP_NOW = fx('sp500-now-excerpt.html'), NDX_API = fx('nasdaq-ndx100.json'), NDX_WIKI = fx('ndx-list-now-excerpt.html');
const ALL = [...new Set([...parseSp500(SP_NOW).map(r => r.symbol), ...parseNasdaqApi(JSON.parse(NDX_API)).map(r => r.symbol)])];
const LISTS = {
  'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies': SP_NOW,
  'https://api.nasdaq.com/api/quote/list-type/nasdaq100': NDX_API,
  'https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies': NDX_WIKI,
};
async function layerApp({ bench = true, now = clock('2026-11-17T02:00:00Z') } = {}) {
  const bars = Object.fromEntries([...ALL, ...(bench ? ['SPY'] : [])].map(s => [s, series('2026-10-01', '2026-11-17', 100)]));
  const prov = createMockProvider({ bars, ranges: RANGES, intervals: ['1d'], now });
  const route = earningsRoutes();
  const fetcher = { calls: [], async getText(source, url) { this.calls.push({ source, url }); if (url in LISTS) return { data: LISTS[url], cached: false, ageMs: 0 }; if (url.includes('/calendar/earnings')) return { data: route(url), cached: false, ageMs: 0 }; throw new Error(`HTTP 404 from ${new URL(url).hostname}`); } };
  const layer = createDataLayer({ fetcher, now, sleep: async () => {}, autoRun: false, historyFrom: '2026-10-01', options: { universe: { sane: { sp500: [1, 600], ndx100: [1, 600] } }, runs: { backfill: false }, earnings: { lookaheadDays: 14, perRun: 1000 }, bars: { deepPerRun: 1000 } } });
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile: ':memory:', log: () => {}, provider: prov, now, sleep: async () => {} });
  for (const f of layer.features) app.use(f);
  await app.start();
  return { app, api: layer.api, prov };
}

test('runs: the benchmark is swept with the universe but outside its coverage, then the history step fills deep bars and earnings', async () => {
  const { app, api, prov } = await layerApp();
  const r = await api.runs.runCycle();
  assert.equal(r.status, 'ok');
  assert.ok(prov.calls.some(c => c.args[0].symbol === 'SPY'));
  assert.equal(r.coverage.universe, ALL.length, 'SPY is not counted in coverage');
  assert.equal(r.deepen.ok, ALL.length + 1, 'every listed symbol plus SPY');
  assert.ok(r.earnings.ok > 0 && r.earnings.failed === 0);
  assert.equal(n(app, "SELECT COUNT(*) AS n FROM bar WHERE symbol = 'SPY' AND day = '2026-10-01'"), 1);
  assert.deepEqual(api.runs.historyPending(), { universe: 0, bars: 0, earnings: 0 });
  assert.equal(api.runs.needsHistory(), false);
  assert.equal((await api.runs.runHistory()).status, 'idle');
  const s = app.health().dataQuality.runs.summary;
  assert.match(s, new RegExp(`bars from 2026-10-01: ${ALL.length + 1} of ${ALL.length + 1} symbols`));
  assert.match(s, /earnings calendar \d+ of \d+ past days/);
  await app.stop();
});

test('runs: a benchmark the provider cannot serve is logged, and the universe run is still ingested', async () => {
  const { app, api } = await layerApp({ bench: false });
  const r = await api.runs.runCycle();
  assert.equal(r.status, 'ok');
  assert.equal(r.sweep.failed, 0);
  assert.equal(api.runs.getRun(TARGET).state, 'ingested');
  assert.equal(app.db.stmt("SELECT status FROM bar_history WHERE symbol = 'SPY'").get().status, 'not_found');
  assert.match(app.health().dataQuality.runs.summary, /1 unknown to the provider/);
  await app.stop();
});

test('universe: every symbol ever listed is wanted for history, and unreadable or given-up quarters are counted', async () => {
  const { app, api } = await layerApp();
  await api.universe.refresh();
  const t = Date.now();
  const ins = app.db.stmt("INSERT INTO universe_snapshot(index_name, kind, as_of, source, fetched_at, status, n) VALUES (?, 'history', ?, 'wikipedia', ?, ?, ?)");
  const id = Number(ins.run('sp500', '2020-01-01', t, 'ok', 1).lastInsertRowid);
  app.db.stmt("INSERT INTO universe_member(snapshot_id, symbol, yahoo_symbol) VALUES (?, 'GONE', 'GONE')").run(id);
  ins.run('ndx100', '2020-04-01', t, 'unparsed', 0);
  for (let i = 0; i < 3; i++) ins.run('ndx100', '2020-07-01', t, 'failed', 0);
  assert.ok(api.universe.allSymbols().includes('GONE'));
  assert.equal(api.universe.allSymbols().length, ALL.length + 1);
  const st = api.universe.backfillStatus();
  assert.deepEqual([st.unparsed, st.givenUp, st.unparsedList], [1, 1, ['ndx100 2020-04-01']]);
  await app.stop();
});
