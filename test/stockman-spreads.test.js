// The cost sampler (vault G11, note 06 "Cost model", CL-0060): parsing the Nasdaq quote answer, sampling only in market hours, the
// least-sampled-first rotation, failures and the policy switch, and the summary figures. Network mocked; the answers below are copies of
// the shapes seen live on 2026-11-17 (AAPL during hours, a symbol outside hours, an unknown symbol).
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { createStockman } = require('../src/core/stockman/app');
const { createMockProvider } = require('../src/core/stockman/stocks/mock');
const { createSpreads, parseQuote, parseTradeTime, spreadBps, summarize } = require('../src/core/stockman/features/spreads');
const { PolicyError } = require('../src/core/stockman/errors');
const { nyWallToMs } = require('../src/core/stockman/features/ny-time');

const LIVE = { data: { symbol: 'AAPL', exchange: 'NASDAQ-GS', isNasdaqListed: true, marketStatus: 'Open', primaryData: { lastSalePrice: '$350.43', netChange: '-2.35', bidPrice: '$350.42', askPrice: '$350.48', bidSize: '62', askSize: '81', isRealTime: true, lastTradeTimestamp: 'Nov 17, 2026 1:37 PM ET', volume: '17,432,101.666466' } }, status: { rCode: 200, bCodeMessage: null } };
const CLOSED = { data: { symbol: 'KO', exchange: 'NYSE', isNasdaqListed: false, marketStatus: 'Closed', primaryData: { lastSalePrice: '$99.16', bidPrice: 'N/A', askPrice: 'N/A', bidSize: 'N/A', askSize: 'N/A', isRealTime: false, lastTradeTimestamp: 'Nov 16, 2026 4:00 PM ET' } } };
const UNKNOWN = { data: null, status: { rCode: 400, bCodeMessage: [{ code: 1001, errorMessage: 'Symbol not exists.' }] } };
const quoteFor = (symbol, bid, ask, { listed = true } = {}) => ({ data: { symbol, exchange: listed ? 'NASDAQ-GS' : 'NYSE', isNasdaqListed: listed, marketStatus: 'Open', primaryData: { lastSalePrice: `$${ask}`, bidPrice: `$${bid}`, askPrice: `$${ask}`, bidSize: '10', askSize: '12', isRealTime: true, lastTradeTimestamp: 'Nov 17, 2026 10:01 AM ET' } } });

test('parse: the live answer gives bid, ask, sizes, the real-time flag, the exchange and the last-trade time', () => {
  const q = parseQuote(LIVE);
  assert.deepEqual([q.known, q.bid, q.ask, q.bidSize, q.askSize, q.last, q.realTime, q.exchange, q.nasdaqListed], [true, 350.42, 350.48, 62, 81, 350.43, true, 'NASDAQ-GS', true]);
  assert.equal(q.lastTradeAt, nyWallToMs('2026-11-17', '13:37'));
  assert.ok(Math.abs(spreadBps(q.bid, q.ask) - (0.06 / 350.45) * 1e4) < 1e-9);
  const c = parseQuote(CLOSED);
  assert.equal(c.bid, null); assert.equal(spreadBps(c.bid, c.ask), null);
  assert.deepEqual(parseQuote(UNKNOWN), { known: false });
  assert.equal(parseQuote({ data: { primaryData: null } }), null, 'a changed shape fails loudly, it does not become zeros');
  assert.equal(parseQuote({ data: null, status: { bCodeMessage: [{ code: 9 }] } }), null);
  assert.equal(spreadBps(10.2, 10.1), null, 'a crossed quote is not a spread');
  assert.equal(parseTradeTime('Nov 17, 2026 12:05 AM ET'), nyWallToMs('2026-11-17', '00:05'));
  assert.equal(parseTradeTime('Nov 17, 2026 12:05 PM ET'), nyWallToMs('2026-11-17', '12:05'));
  assert.equal(parseTradeTime('yesterday'), null);
});

// a sampler on an in-memory database with a controlled clock and a scripted network
async function sampler({ symbols = ['AAA', 'BBB', 'CCC', 'DDD'], answer, startAt = '2026-11-17T15:00:00Z', opts = {} } = {}) {
  let t = Date.parse(startAt);
  const now = () => t;
  const calls = [];
  const fetcher = {
    async getText(source, url) {
      const sym = decodeURIComponent(/quote\/([^/]+)\/info/.exec(url)[1]);
      calls.push({ source, sym });
      const a = answer(sym, calls.length);
      if (a instanceof Error) throw a;
      return { data: typeof a === 'string' ? a : JSON.stringify(a) };
    },
  };
  const universe = { symbols: () => symbols.map(symbol => ({ symbol })) };
  const s = createSpreads({ fetcher, universe, now, sleep: async ms => { t += ms; }, opts: { autoRun: false, ...opts } });
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile: ':memory:', log: () => {}, provider: createMockProvider({}) });
  app.use(s.feature);
  await app.start();
  return { app, s: s.api, calls, set: iso => { t = Date.parse(iso); }, rows: () => app.db.stmt('SELECT * FROM spread_sample ORDER BY id').all() };
}

test('round: samples only while the regular session is open; outside hours nothing is fetched', async () => {
  const k = await sampler({ answer: sym => quoteFor(sym, 10, 10.01), startAt: '2026-11-17T13:00:00Z' });   // 08:00 New York
  assert.deepEqual(await k.s.round(), { status: 'closed' });
  k.set('2026-11-21T16:00:00Z');                                                                         // a Saturday
  assert.deepEqual(await k.s.round(), { status: 'closed' });
  assert.equal(k.calls.length, 0);
  k.set('2026-11-17T15:00:00Z');                                                                         // 10:00 New York, a Tuesday
  const r = await k.s.round();
  assert.deepEqual([r.status, r.asked, r.ok], ['done', 4, 4]);
  assert.ok(k.calls.every(c => c.source === 'finance'), 'every call goes through the finance switch');
  const rows = k.rows();
  assert.equal(rows[0].minute_of_session, 30);
  assert.ok(Math.abs(rows[0].spread_bps - (0.01 / 10.005) * 1e4) < 1e-9);
  await k.app.stop();
});

test('round: the least-sampled symbols go first, so a day spreads samples over every symbol; perRound limits a round', async () => {
  const k = await sampler({ symbols: ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'], answer: sym => quoteFor(sym, 10, 10.02), opts: { perRound: 2 } });
  const seen = [];
  for (let i = 0; i < 5; i++) { await k.s.round(); }
  for (const r of k.rows()) seen.push(r.symbol);
  assert.deepEqual(seen, ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'AAA', 'BBB', 'CCC', 'DDD', 'EEE']);
  await k.app.stop();
});

test('round: no quote, an unknown symbol and failures are recorded, never filled; three failures in a row end the round', async () => {
  const k = await sampler({ symbols: ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'], answer: sym => ({ AAA: CLOSED, BBB: UNKNOWN, CCC: 'not json' }[sym] || new Error('HTTP 503 from api.nasdaq.com')) });
  const r = await k.s.round();
  assert.equal(r.status, 'aborted');
  assert.deepEqual(k.rows().map(x => [x.symbol, x.status, x.spread_bps]), [['AAA', 'no_quote', null], ['BBB', 'no_quote', null], ['CCC', 'failed', null], ['DDD', 'failed', null], ['EEE', 'failed', null]]);
  assert.match(k.rows()[1].note, /unknown to the provider/);
  assert.match(k.rows()[3].note, /TRANSIENT/);
  await k.app.stop();
});

test('round: with finance switched off (a policy refusal) the round stops at once and writes nothing; the off option does nothing at all', async () => {
  const k = await sampler({ answer: () => new PolicyError('finance lookups are off') });
  const r = await k.s.round();
  assert.equal(r.status, 'refused'); assert.equal(k.rows().length, 0); assert.equal(k.calls.length, 1);
  await k.app.stop();
  const off = await sampler({ answer: sym => quoteFor(sym, 10, 10.01), opts: { enabled: false } });
  assert.deepEqual(await off.s.round(), { status: 'off' });
  assert.equal(off.calls.length, 0);
  assert.equal(off.s.health().summary, 'cost sampler: OFF');
  await off.app.stop();
});

test('summary: each symbol counts once (its median), windows split open, middle and close, Nasdaq-listed split from others', () => {
  const mk = (symbol, bps, mos, listed = 1) => ({ symbol, spread_bps: bps, minute_of_session: mos, session_minutes: 390, nasdaq_listed: listed, sampled_at: 120000, last_trade_at: 60000 });
  const rows = [mk('A', 2, 100), mk('A', 4, 200), mk('A', 3, 300), mk('B', 10, 5, 0), mk('C', 6, 380)];
  const s = summarize(rows);
  assert.equal(s.symbols, 3); assert.equal(s.samples, 5);
  assert.equal(s.roundTripMedianBps, 6);                 // symbol medians 3, 10, 6 → 6
  assert.equal(s.byWindow.open.medianBps, 10); assert.equal(s.byWindow.mid.medianBps, 3); assert.equal(s.byWindow.close.medianBps, 6);
  assert.equal(s.nasdaqListed.samples, 4); assert.equal(s.otherListed.medianBps, 10);
  assert.equal(s.lastTradeAgeMinMedian, 1);
  assert.equal(s.assumedBps, 10);
  assert.equal(summarize([]).roundTripMedianBps, null);
});

test('health: one line with the measured median against the assumed 10 bps, and nothing claimed before any quote exists', async () => {
  const k = await sampler({ answer: sym => quoteFor(sym, 10, sym === 'AAA' ? 10.01 : 10.03) });
  assert.match(k.s.health().summary, /no quotes yet/);
  await k.s.round();
  const h = k.s.summary();
  assert.equal(h.symbols, 4); assert.equal(h.counts.ok, 4); assert.equal(h.days, 1);
  const line = createLine(k);
  assert.match(line, /cost sampler 2026-11-17: 4 two-sided quotes for 4 symbols/);
  assert.match(line, /the backtests assume 10 bps/); assert.match(line, /not size or the opening auction/);
  await k.app.stop();
});
function createLine(k) { k.set('2026-11-17T16:00:00Z'); return k.s.health().summary; }
