const test = require('node:test');
const assert = require('node:assert/strict');
const { createYahooProvider, createFetcherHttp, mapHttpError, toYahooSymbol } = require('../src/core/stockman/stocks/yahoo');
const { createMockProvider } = require('../src/core/stockman/stocks/mock');
const { createStockService } = require('../src/core/stockman/stocks/service');
const { normalizeSymbol, assertProvider, checkHistory } = require('../src/core/stockman/stocks/provider');
const { createRateLimiter, createBreaker, createGuard } = require('../src/core/stockman/resilience');
const { createFetcher } = require('../src/core/net/fetcher');
const { createPolicy } = require('../src/core/net/policy');
const E = require('../src/core/stockman/errors');
const chart = require('./fixtures/stockman-chart.json');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
// the real jarvis fetcher and policy, with only the network call replaced
function stack({ handler, finance = true }) {
  const urls = [];
  const fetch = async url => { urls.push(String(url)); return handler(String(url), urls.length); };
  const fetcher = createFetcher({ policy: createPolicy(() => ({ online: { enabled: true, finance } })), fetch });
  const provider = createYahooProvider({ http: createFetcherHttp({ fetcher }), now: () => 1_800_000_000_000 });
  return { provider, urls };
}
function service(provider, over = {}) {
  let t = 0;
  const limiter = createRateLimiter({ ratePerSec: 1000, burst: 1000, now: () => t, sleep: async ms => { t += ms; } });
  const breaker = createBreaker({ failures: over.failures ?? 3, cooldownMs: 1000, now: () => t });
  const guard = createGuard({ limiter, breaker, retries: over.retries ?? 1, retryBaseMs: 10, retryMaxMs: 20, deadlineMs: 5000, sleep: async ms => { t += ms; }, random: () => 1 });
  return { svc: createStockService({ provider, guard, now: () => t }), breaker };
}

test('stockman-stocks: symbols are normalised, bad ones refused, and the Yahoo spelling maps the share-class dot', () => {
  assert.equal(normalizeSymbol(' brk.b '), 'BRK.B');
  for (const bad of ['', 'A B', '../x', 'TOOLONGSYMBOL', 'AAPL?x=1', null]) assert.throws(() => normalizeSymbol(bad), E.InvalidRequestError, String(bad));
  assert.equal(toYahooSymbol('BRK.B'), 'BRK-B');
});

test('stockman-stocks: assertProvider rejects things that are not providers', () => {
  assert.throws(() => assertProvider({}), /not a StockProvider/);
  assert.doesNotThrow(() => assertProvider(createMockProvider()));
});

test('stockman-stocks: yahoo quote is read from the confirmed response shape, through the real fetcher and policy', async () => {
  const { provider, urls } = stack({ handler: () => json(chart) });
  const q = await provider.getQuote('abc');
  assert.deepEqual(q, { symbol: 'ABC', price: 104.5, currency: 'USD', asOf: 1794862801000, fetchedAt: 1_800_000_000_000, source: 'yahoo', stale: false, ageMs: 0, exchange: 'NMS', volume: 1234567 });
  assert.equal(urls[0], 'https://query1.finance.yahoo.com/v8/finance/chart/ABC?range=1d&interval=1d');
});

test('stockman-stocks: yahoo history converts seconds to ms and skips bars with gaps instead of filling them', async () => {
  const { provider, urls } = stack({ handler: () => json(chart) });
  const h = await provider.getHistory({ symbol: 'BRK.B', range: '5d', interval: '1d' });
  assert.match(urls[0], /\/chart\/BRK-B\?range=5d&interval=1d$/);
  assert.equal(h.bars.length, 3);
  assert.equal(h.skipped, 1);
  assert.deepEqual(h.bars[0], { t: 1794321000000, open: 100, high: 102, low: 99, close: 101, adjClose: 100.5, volume: 1000 });
  assert.equal(h.bars[2].close, 104.5);
});

test('stockman-stocks: the host policy still applies: finance switched off means no request at all', async () => {
  const { provider, urls } = stack({ handler: () => json(chart), finance: false });
  await assert.rejects(provider.getQuote('ABC'), E.PolicyError);
  assert.equal(urls.length, 0);
});

test('stockman-stocks: HTTP failures map to the right error class', async () => {
  const cases = [[404, E.NotFoundError], [429, E.RateLimitError], [500, E.TransientError], [503, E.TransientError], [401, E.ProviderDataError]];
  for (const [status, Cls] of cases) {
    const { provider } = stack({ handler: () => new Response('x', { status }) });
    await assert.rejects(provider.getQuote('ABC'), Cls, `HTTP ${status}`);
  }
  assert.ok(mapHttpError(new Error('timed out after 8 s')) instanceof E.TransientError);
  assert.ok(mapHttpError(new Error('could not reach query1.finance.yahoo.com: fetch failed')) instanceof E.TransientError);
  assert.ok(mapHttpError(new Error('bad JSON from query1.finance.yahoo.com')) instanceof E.ProviderDataError);
  assert.ok(mapHttpError(new Error('something odd')) instanceof E.ProviderDataError);
});

test('stockman-stocks: malformed or error bodies become ProviderDataError / NotFoundError, never bad numbers', async () => {
  const bodies = [
    [{ nope: 1 }, E.ProviderDataError],
    [{ chart: { result: null, error: null } }, E.ProviderDataError],
    [{ chart: { result: null, error: { code: 'Not Found', description: 'No data found' } } }, E.NotFoundError],
    [{ chart: { result: [{ meta: { currency: 'USD', regularMarketPrice: 'abc', regularMarketTime: 1794862801 } }] } }, E.ProviderDataError],
    [{ chart: { result: [{ meta: { currency: 'USD', regularMarketPrice: -5, regularMarketTime: 1794862801 } }] } }, E.ProviderDataError],
  ];
  for (const [body, Cls] of bodies) {
    const { provider } = stack({ handler: () => json(body) });
    await assert.rejects(provider.getQuote('ABC'), Cls, JSON.stringify(body).slice(0, 60));
  }
});

test('stockman-stocks: when the provider fails but jarvis has an older answer, the quote is returned flagged stale with its age', async () => {
  let t = 1_000_000;
  const fetch = async () => (t === 1_000_000 ? json(chart) : new Response('x', { status: 500 }));
  const fetcher = createFetcher({ policy: createPolicy(() => ({ online: { enabled: true, finance: true } })), fetch, now: () => t });
  const provider = createYahooProvider({ http: createFetcherHttp({ fetcher }), now: () => t });
  const fresh = await provider.getQuote('ABC');
  assert.equal(fresh.stale, false);
  t += 90_000;
  const old = await provider.getQuote('ABC');
  assert.equal(old.stale, true);
  assert.equal(old.ageMs, 90_000);
});

test('stockman-stocks: history checks reject bars out of order or with impossible prices', () => {
  const bar = (t, o = 1, h = 2, l = 1, c = 1) => ({ t, open: o, high: h, low: l, close: c, adjClose: null, volume: 1 });
  assert.throws(() => checkHistory({ symbol: 'A', bars: [bar(1_800_000_000_000), bar(1_700_000_000_000)] }), /rising time order/);
  assert.throws(() => checkHistory({ symbol: 'A', bars: [bar(1_800_000_000_000, 1, 1, 2, 1)] }), /high below low/);
  assert.throws(() => checkHistory({ symbol: 'A', bars: [bar(1_800_000_000_000, 0)] }), /bad open/);
  assert.doesNotThrow(() => checkHistory({ symbol: 'A', bars: [bar(1_700_000_000_000), bar(1_800_000_000_000)] }));
});

test('stockman-stocks: service validates requests before any provider call', async () => {
  const mock = createMockProvider({ quotes: { ABC: 10 } });
  const { svc } = service(mock);
  await assert.rejects(svc.getQuote('not a symbol'), E.InvalidRequestError);
  await assert.rejects(svc.getHistory({ symbol: 'ABC', range: '99y', interval: '1d' }), /range/);
  await assert.rejects(svc.getHistory({ symbol: 'ABC', range: '5d', interval: '7m' }), /interval/);
  await assert.rejects(svc.getQuotes([]), E.InvalidRequestError);
  assert.equal(mock.calls.length, 0);
});

test('stockman-stocks: getQuotes isolates failures per symbol and de-duplicates', async () => {
  const mock = createMockProvider({ quotes: { AAA: 1, CCC: 3 } });
  const { svc } = service(mock);
  const r = await svc.getQuotes(['aaa', 'BBB', 'CCC', 'AAA']);
  assert.deepEqual(r.map(x => [x.symbol, x.ok]), [['AAA', true], ['BBB', false], ['CCC', true]]);
  assert.equal(r[1].error.code, 'NOT_FOUND');
  assert.equal(mock.calls.length, 3);
});

test('stockman-stocks: service retries a transient failure, and counts calls and failures in status()', async () => {
  const mock = createMockProvider({ quotes: { ABC: 10 } });
  mock.failNext(new E.TransientError('blip'), 1);
  const { svc } = service(mock);
  assert.equal((await svc.getQuote('ABC')).price, 10);
  assert.equal(mock.calls.length, 2);
  await assert.rejects(svc.getQuote('ZZZ'), E.NotFoundError);
  const s = svc.status();
  assert.equal(s.provider, 'mock');
  assert.equal(s.calls, 2);
  assert.equal(s.failures, 1);
  assert.equal(s.lastError, null);   // a missing symbol is not an incident
});

test('stockman-stocks: after repeated provider failures the circuit opens and later calls fail fast without touching the provider', async () => {
  const mock = createMockProvider({ quotes: { ABC: 10 } });
  mock.failNext(new E.TransientError('down'), 100);
  const { svc, breaker } = service(mock, { retries: 0, failures: 3 });
  for (let i = 0; i < 3; i++) await svc.getQuote('ABC').catch(() => {});
  assert.equal(breaker.state().state, 'open');
  const before = mock.calls.length;
  await assert.rejects(svc.getQuote('ABC'), E.CircuitOpenError);
  assert.equal(mock.calls.length, before);
  assert.equal(svc.status().lastError.code, 'CIRCUIT_OPEN');
});

test('stockman-stocks: a provider that returns garbage is caught by the service even if it skipped its own checks', async () => {
  const bad = { name: 'bad', capabilities: { ranges: ['1d'], intervals: ['1d'] }, getQuote: async () => ({ symbol: 'ABC', price: NaN, currency: 'USD', asOf: 1_800_000_000_000 }), getHistory: async () => ({ bars: [] }) };
  const { svc } = service(bad);
  await assert.rejects(svc.getQuote('ABC'), E.ProviderDataError);
});
