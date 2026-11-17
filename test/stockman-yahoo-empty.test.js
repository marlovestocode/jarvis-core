// Yahoo history edge cases seen live on 2026-11-17 (vault CL-0044): an empty answer is data, and one bad bar must not sink a series.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createYahooProvider } = require('../src/core/stockman/stocks/yahoo');

const DAY = 86400;
const chart = (result, extra = {}) => ({ chart: { result: [{ meta: { currency: 'USD', ...extra }, ...result }], error: null } });
const provider = body => createYahooProvider({ http: { getJson: async () => ({ data: body, stale: false, ageMs: 0 }) }, now: () => 1_800_000_000_000 });
const t0 = Date.UTC(2026, 9, 1, 13, 30) / 1000;
const quote = rows => ({
  timestamp: rows.map((_, i) => t0 + i * DAY),
  indicators: {
    quote: [{ open: rows.map(r => r.o), high: rows.map(r => r.h), low: rows.map(r => r.l), close: rows.map(r => r.c), volume: rows.map(() => 1000) }],
    adjclose: [{ adjclose: rows.map(r => r.c) }],
  },
});

test('yahoo history: no timestamp and an empty quote object (BK, K, CTRA live) is an empty history, not a malformed answer', async () => {
  const h = await provider(chart({ indicators: { quote: [{}] } }, { firstTradeDate: 1784000000 })).getHistory({ symbol: 'BK', range: '10y', interval: '1d' });
  assert.deepEqual([h.bars.length, h.skipped, h.stale], [0, 0, false]);
});

test('yahoo history: a shape that is really wrong is still refused', async () => {
  await assert.rejects(provider(chart({ timestamp: [t0], indicators: { quote: [{}] } })).getHistory({ symbol: 'BK', range: '10y', interval: '1d' }), /not in the expected shape/);
  await assert.rejects(provider(chart({ timestamp: [t0], indicators: {} })).getHistory({ symbol: 'BK', range: '10y', interval: '1d' }), /not in the expected shape/);
});

test('yahoo history: a bar with a zero price or high below low is skipped and counted, the rest of the series is kept (WBD live)', async () => {
  const rows = [{ o: 10, h: 11, l: 9, c: 10.5 }, { o: 0, h: 31, l: 30, c: 30.95 }, { o: 10, h: 9, l: 11, c: 10 }, { o: 12, h: 13, l: 11, c: 12.5 }];
  const h = await provider(chart(quote(rows))).getHistory({ symbol: 'WBD', range: '10y', interval: '1d' });
  assert.equal(h.bars.length, 2);
  assert.equal(h.skipped, 2);
  assert.deepEqual(h.bars.map(b => b.open), [10, 12], 'nothing repaired, nothing invented');
});

// ---- through the bars feature ---------------------------------------------------------------------------------------------------
const os = require('node:os');
const { createStockman } = require('../src/core/stockman/app');
const { createMockProvider } = require('../src/core/stockman/stocks/mock');
const { createBars } = require('../src/core/stockman/features/bars');

test('deep history: a symbol whose answer holds no usable bars is recorded as not_found (a survivorship gap), not as ok with 0 bars', async () => {
  const now = () => Date.parse('2026-11-17T02:00:00Z');
  const prov = createMockProvider({ bars: { EMPTY: [] }, ranges: ['10y'], intervals: ['1d'], now });
  const built = createBars({ now, sleep: async () => {} });
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile: ':memory:', log: () => {}, provider: prov, now, sleep: async () => {} });
  app.use(built.feature);
  await app.start();
  const r = await built.api.deepen({ symbols: ['EMPTY'], from: '2019-10-01', target: '2026-11-16' });
  assert.deepEqual([r.ok, r.notFound], [0, 1]);
  assert.deepEqual(Object.values(app.db.stmt("SELECT status, n FROM bar_history WHERE symbol = 'EMPTY'").get()), ['not_found', 0]);
  assert.deepEqual(built.api.deepStatus({ symbols: ['EMPTY'], from: '2019-10-01' }).notFoundSymbols, ['EMPTY']);
  await app.stop();
});
