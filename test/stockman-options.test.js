// The options market sampler (CL-0068): OCC parsing, which quotes are kept, market-hours gating, paging, refusal handling, the summary figures and
// that it is read-only. The Alpaca answers below follow the shape seen live on 2026-11-17. Network mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createStockman } = require('../src/core/stockman/app');
const { createMockProvider } = require('../src/core/stockman/stocks/mock');
const { createOptions, parseOcc, toRow, pickNearest } = require('../src/core/stockman/features/options');
const { PolicyError } = require('../src/core/stockman/errors');

const snap = (bp, ap, over = {}) => ({ latestQuote: { bp, ap, bs: 10, as: 12, t: '2026-11-17T19:14:50Z' }, latestTrade: { p: (bp + ap) / 2 }, dailyBar: { v: 40 }, greeks: { delta: 0.5 }, impliedVolatility: 0.28, ...over });
const CTX = { underPrice: 350, day: '2026-11-17', at: Date.parse('2026-11-17T19:15:00Z'), today: '2026-11-17' };

test('parse: an OCC symbol gives root, expiry, kind and strike; anything else is null', () => {
  assert.deepEqual(parseOcc('AAPL261125C00350000'), { root: 'AAPL', expiry: '2026-11-25', kind: 'call', strike: 350 });
  assert.deepEqual(parseOcc('SPY261120P00655500'), { root: 'SPY', expiry: '2026-11-20', kind: 'put', strike: 655.5 });
  assert.equal(parseOcc('AAPL'), null); assert.equal(parseOcc('AAPL261125X00350000'), null);
});

test('row: a two-sided quote becomes a row with spread as a share of the mid, moneyness, days to expiry and the quote age; a one-sided or crossed quote is dropped', () => {
  const r = toRow('AAPL261125C00350000', snap(5.76, 6.63), CTX);
  assert.deepEqual([r.underlying, r.kind, r.expiry, r.dte, r.strike, r.bid, r.ask], ['AAPL', 'call', '2026-11-25', 8, 350, 5.76, 6.63]);
  assert.ok(Math.abs(r.mid - 6.195) < 1e-9 && Math.abs(r.spreadAbs - 0.87) < 1e-9 && Math.abs(r.spreadPct - 0.87 / 6.195) < 1e-9);
  assert.equal(r.moneyness, 0); assert.equal(r.delta, 0.5); assert.equal(r.iv, 0.28); assert.equal(r.volume, 40); assert.equal(r.quoteAgeS, 10);
  assert.equal(toRow('AAPL261125C00350000', snap(0, 6.63), CTX), null, 'no bid');
  assert.equal(toRow('AAPL261125C00350000', snap(7, 6.63), CTX), null, 'crossed');
  assert.equal(toRow('AAPL261125C00350000', {}, CTX), null, 'no quote');
  assert.equal(toRow('junk', snap(1, 2), CTX), null);
});

test('pick: nearest the money first, then the nearer expiry, then the name; limited to n', () => {
  const mk = (c, m, d) => ({ contract: c, moneyness: m, dte: d });
  const picked = pickNearest([mk('c', 0.03, 5), mk('b', -0.01, 9), mk('a', 0.01, 3), mk('d', 0.01, 3)], 3);
  assert.deepEqual(picked.map(x => x.contract), ['a', 'd', 'b']);
});

async function sampler({ pages, startAt = '2026-11-17T15:00:00Z', opts = {}, mid = () => 350, fail = null } = {}) {
  let t = Date.parse(startAt);
  const calls = [];
  const alpaca = {
    async stockMid(u) { calls.push(['mid', u]); if (fail) throw fail; return mid(u); },
    async optionSnapshots(a) { calls.push(['snap', a.underlying, a.pageToken, a.strikeGte, a.strikeLte]); const p = pages(a); return p; },
  };
  const s = createOptions({ alpaca, now: () => t, sleep: async ms => { t += ms; }, opts: { autoRun: false, paceMs: 1, ...opts } });
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile: ':memory:', log: () => {}, provider: createMockProvider({}) });
  app.use(s.feature);
  await app.start();
  return { app, s: s.api, calls, set: iso => { t = Date.parse(iso); }, rows: () => app.db.stmt('SELECT * FROM option_sample ORDER BY id').all() };
}
const page1 = a => ({ snapshots: { 'AAPL261125C00350000': snap(5.76, 6.63), 'AAPL261125P00350000': snap(5.0, 5.4), 'AAPL261218C00360000': snap(8, 8.2), 'AAPL261125C00340000': { latestQuote: { bp: 0, ap: 20 } } }, nextPageToken: a.pageToken ? null : 'p2' });

test('round: only in the regular session; asks stock mid, then option pages within the strike band and 35 days; stores two-sided quotes only', async () => {
  const k = await sampler({ pages: page1, startAt: '2026-11-17T13:00:00Z' });     // 08:00 New York
  assert.deepEqual(await k.s.round(), { status: 'closed' }); assert.equal(k.calls.length, 0);
  k.set('2026-11-17T15:00:00Z');
  const r = await k.s.round({ only: ['AAPL'] });
  assert.deepEqual([r.status, r.underlyings, r.failed], ['done', 1, 0]);
  assert.deepEqual(k.calls[0], ['mid', 'AAPL']);
  assert.deepEqual([k.calls[1][3], k.calls[1][4]], [329, 371], 'strike band 6% around 350, rounded outward');
  assert.equal(k.calls[2][2], 'p2', 'the second page is asked for with its token');
  assert.equal(r.contracts, 6, 'two pages of three two-sided quotes (the no-bid contract is dropped each time)');
  assert.ok(k.rows().every(x => x.under_price === 350 && x.day === '2026-11-17' && x.minute_of_session === 30));
  await k.app.stop();
});

test('round: a policy refusal (broker source off, no keys) stops at once and writes nothing; three failures end a round; off does nothing', async () => {
  const off = await sampler({ pages: page1, fail: new PolicyError('alpaca: broker lookups are off') });
  const r = await off.s.round({ only: ['AAPL', 'MSFT'] });
  assert.equal(r.status, 'refused'); assert.match(r.note, /broker lookups are off/); assert.equal(off.rows().length, 0); assert.equal(off.calls.length, 1);
  await off.app.stop();
  const bad = await sampler({ pages: page1, fail: new Error('boom') });
  const b = await bad.s.round({ only: ['A', 'B', 'C', 'D'] });
  assert.deepEqual([b.status, b.failed], ['aborted', 3]);
  await bad.app.stop();
  const none = await sampler({ pages: page1, opts: { enabled: false } });
  assert.deepEqual(await none.s.round({ force: true }), { status: 'off' });
  assert.equal(none.s.health().summary, 'options sampler: OFF');
  await none.app.stop();
});

test('summary: near-the-money quotes by days to expiry, call and put, per underlying; the health line says it is indicative and quoted only', async () => {
  const k = await sampler({ pages: page1 });
  assert.match(k.s.health().summary, /no quotes yet/);
  await k.s.round({ only: ['AAPL'] });
  const s = k.s.summary();
  assert.equal(s.samples, 6); assert.equal(s.underlyings, 1); assert.equal(s.days, 1);
  assert.ok(s.medianSpreadPct > 0.02 && s.medianSpreadPct < 0.15);
  assert.equal(s.byKind.call.samples + s.byKind.put.samples, s.atmSamples);
  assert.ok(s.byDte['0-7'].samples + s.byDte['8-21'].samples + s.byDte['22-35'].samples === s.atmSamples);
  k.set('2026-11-17T16:00:00Z');
  const line = k.s.health().summary;
  assert.match(line, /options sampler 2026-11-17: 6 contract quotes on 1 underlyings/); assert.match(line, /indicative feed, quoted spread only/);
  await k.app.stop();
});

test('read-only: the sampler module has no order, cancel or write method; it only calls the adapter read methods', () => {
  const t = fs.readFileSync(path.join(__dirname, '../src/core/stockman/features/options.js'), 'utf8');
  assert.ok(!/placeOrder|cancelOrder|submitOrder|'POST'|'DELETE'/.test(t.replace(/\/\/.*$/gm, '')), 'no order code');
  assert.ok(/alpaca\.optionSnapshots/.test(t) && /alpaca\.stockMid/.test(t));
});
