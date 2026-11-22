const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStockman } = require('../src/core/stockman/app');
const { createMockProvider } = require('../src/core/stockman/stocks/mock');
const { createUniverse, parseSp500, parseNdxWiki, parseNasdaqApi } = require('../src/core/stockman/features/universe');
const { findTable, tables, cellText } = require('../src/core/stockman/features/html-table');
const E = require('../src/core/stockman/errors');

// Fixtures are EXCERPTS of real responses captured read-only on 2026-11-17 (see test/fixtures/stockman-data/README.md).
const FX = path.join(__dirname, 'fixtures', 'stockman-data');
const fx = f => fs.readFileSync(path.join(FX, f), 'utf8');
const SP_NOW = fx('sp500-now-excerpt.html'), NDX_WIKI = fx('ndx-list-now-excerpt.html'), NDX_2023 = fx('ndx-2023-excerpt.html');
const NDX_API = fx('nasdaq-ndx100.json'), REV = fx('wiki-revision-api.json');
const SP_URL = 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies';
const NDX_WIKI_URL = 'https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies';
const API_URL = 'https://api.nasdaq.com/api/quote/list-type/nasdaq100';
const SANE_TEST = { sp500: [1, 600], ndx100: [1, 600] };

function fakeFetcher(routes) {
  const calls = [];
  return {
    calls,
    async getText(source, url, opts) {
      calls.push({ source, url, opts });
      let v = routes[url];
      if (v === undefined) for (const [k, f] of Object.entries(routes)) if (k.endsWith('*') && url.startsWith(k.slice(0, -1))) v = f;
      if (typeof v === 'function') v = v(url);
      if (v === undefined) throw new Error(`HTTP 404 from ${new URL(url).hostname}`);
      if (v instanceof Error) throw v;
      return { data: v, cached: false, ageMs: 0 };
    },
  };
}
async function make({ routes, now = () => Date.parse('2026-11-17T20:00:00Z'), opts = {}, sleeps = [] } = {}) {
  const fetcher = fakeFetcher(routes);
  const u = createUniverse({ fetcher, now, sleep: async ms => { sleeps.push(ms); }, opts: { sane: SANE_TEST, ...opts } });
  const app = createStockman({ env: {}, dataDir: require('node:os').tmpdir(), dbFile: ':memory:', log: () => {}, provider: createMockProvider(), now, sleep: async () => {} });
  app.use(u.feature);
  await app.start();
  return { app, fetcher, u: u.api, sleeps };
}

test('html-table: finds the constituents table in real Wikipedia markup, drops footnotes, decodes entities', () => {
  assert.equal(cellText('Hello&nbsp;&amp; <b>bye</b><sup class="x">[1]</sup>'), 'Hello & bye');
  assert.equal(tables(SP_NOW).length, 1);
  const t = findTable(SP_NOW, ['Symbol', 'Security']);
  assert.equal(t.id, 'constituents');
  assert.equal(t.body[0][0], 'MMM');
  assert.equal(findTable(SP_NOW, ['Nonsense']), null);
});

test('parsers: S&P 500 and Nasdaq-100 lists from real captured pages, either column order', () => {
  const sp = parseSp500(SP_NOW);
  assert.equal(sp[0].symbol, 'MMM');
  assert.ok(sp.some(r => r.symbol === 'BRK.B'), 'share class kept as the list writes it');
  assert.ok(parseNdxWiki(NDX_WIKI).every(r => /^[A-Z.]+$/.test(r.symbol)));
  const old = parseNdxWiki(NDX_2023);   // 2023 revision: Company column before Ticker
  assert.ok(old.length >= 5 && old.every(r => /^[A-Z.]+$/.test(r.symbol)), JSON.stringify(old[0]));
  const api = parseNasdaqApi(JSON.parse(NDX_API));
  assert.equal(api.length, 101);
  assert.equal(parseNasdaqApi({ data: null }), null);
});

test('parsers: a Nasdaq-100 revision whose symbol column is headed "Symbol" (2025-01-01, found live) parses', () => {
  const html = '<table class="wikitable"><tr><th>Company</th><th>Symbol</th><th>GICS Sector</th></tr><tr><td>Adobe</td><td>ADBE</td><td>Technology</td></tr></table>';
  assert.deepEqual(parseNdxWiki(html), [{ symbol: 'ADBE', name: 'Adobe' }]);
});

test('universe: refresh stores both lists, merges them, maps BRK.B to BRK-B, cross-checks the Nasdaq API', async () => {
  const { app, u, fetcher } = await make({ routes: { [SP_URL]: SP_NOW, [API_URL]: NDX_API, [NDX_WIKI_URL]: NDX_WIKI } });
  const r = await u.refresh();
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.sources, { sp500: 'wikipedia', ndx100: 'nasdaq-api' });
  const list = u.symbols();
  const brk = list.find(s => s.symbol === 'BRK.B');
  assert.equal(brk.yahooSymbol, 'BRK-B');
  assert.deepEqual(brk.indexes, ['sp500']);
  assert.equal(list.length, new Set(list.map(s => s.symbol)).size, 'de-duplicated');
  assert.equal(r.n, r.byIndex.sp500 + r.byIndex.ndx100 - r.overlap);
  assert.deepEqual(fetcher.calls.map(c => c.source), ['wiki', 'finance', 'wiki']);
  const note = app.db.stmt("SELECT note FROM universe_snapshot WHERE index_name = 'ndx100'").get().note;
  assert.match(note, /cross-check differs/);   // the Wikipedia excerpt holds only a few rows: reported, not resolved
  await app.stop();
});

test('universe: a symbol in both indexes appears once with both memberships', async () => {
  const both = `<table id="constituents"><tr><th>Symbol</th><th>Security</th></tr><tr><td>AAPL</td><td>Apple</td></tr><tr><td>ZZZ</td><td>Only S&amp;P</td></tr></table>`;
  const ndx = `<table class="wikitable"><tr><th>Ticker</th><th>Company</th></tr><tr><td>AAPL</td><td>Apple</td></tr><tr><td>QQQ1</td><td>Only Nasdaq</td></tr></table>`;
  const { app, u } = await make({ routes: { [SP_URL]: both, [NDX_WIKI_URL]: ndx, [API_URL]: new E.TransientError('api down') } });
  await u.refresh();
  const by = Object.fromEntries(u.symbols().map(s => [s.symbol, s.indexes]));
  assert.deepEqual(by, { AAPL: ['sp500', 'ndx100'], QQQ1: ['ndx100'], ZZZ: ['sp500'] });
  const snap = app.db.stmt("SELECT source, note FROM universe_snapshot WHERE index_name = 'ndx100'").get();
  assert.equal(snap.source, 'wikipedia-list');
  assert.match(snap.note, /Nasdaq API failed/);
  await app.stop();
});

test('universe: a failed refresh keeps the last good lists and says so; a never-fetched universe says none', async () => {
  let down = false, t = Date.parse('2026-11-17T20:00:00Z');
  const route = v => () => { if (down) throw new E.TransientError('network down'); return v; };
  const { app, u } = await make({ now: () => t, routes: { [SP_URL]: route(SP_NOW), [API_URL]: route(NDX_API), [NDX_WIKI_URL]: route(NDX_WIKI) } });
  assert.equal(u.describe().n, 0);
  down = true;
  assert.equal((await u.refresh()).status, 'none');
  down = false;
  assert.equal((await u.refresh()).status, 'ok');
  const n = u.describe().n;
  t += 25 * 3600000; down = true;      // a day later, due again, and the network is down
  const r = await u.refresh();
  assert.equal(r.status, 'reused');
  assert.equal(u.describe().n, n);
  assert.ok(r.ageMs >= 25 * 3600000);
  assert.ok(r.problems.length >= 2);
  assert.ok(app.db.stmt("SELECT COUNT(*) AS n FROM universe_snapshot WHERE status = 'failed'").get().n >= 2, 'failures are recorded');
  t += 1000; down = false;
  const again = await u.refresh();      // not due after a good refresh: nothing is fetched
  assert.equal(again.status, 'ok');
  await app.stop();
});

test('universe: a list of the wrong size is stored as unparsed and never used', async () => {
  const { app, u } = await make({ opts: { sane: { sp500: [450, 550], ndx100: [90, 115] } }, routes: { [SP_URL]: SP_NOW, [API_URL]: NDX_API, [NDX_WIKI_URL]: NDX_WIKI } });
  const r = await u.refresh();
  assert.equal(u.symbols().filter(s => s.indexes.includes('sp500')).length, 0);
  assert.equal(r.byIndex.ndx100, 101);   // the real Nasdaq API list passes the real size check
  assert.equal(r.status, 'incomplete');
  assert.equal(app.db.stmt("SELECT status FROM universe_snapshot WHERE index_name = 'sp500'").get().status, 'unparsed');
  await app.stop();
});

test('universe: Wikipedia calls are spaced, the Nasdaq call is not', async () => {
  let t = 1_000_000;
  const sleeps = [];
  const fetcher = fakeFetcher({ [SP_URL]: SP_NOW, [API_URL]: NDX_API, [NDX_WIKI_URL]: NDX_WIKI });
  const built = createUniverse({ fetcher, now: () => t, sleep: async ms => { sleeps.push(ms); t += ms; }, opts: { sane: SANE_TEST } });
  const u = built.api;
  const app = createStockman({ env: {}, dataDir: require('node:os').tmpdir(), dbFile: ':memory:', log: () => {}, provider: createMockProvider(), now: () => t });
  app.use(built.feature); await app.start();
  await u.refresh();
  assert.deepEqual(sleeps, [6000]);   // second Wikipedia call waits; the first and the API call do not
  await app.stop();
});

test('universe: point-in-time backfill from dated revisions, resumable, and membersAsOf', async () => {
  const revs = [];
  const routes = {
    [SP_URL]: SP_NOW, [API_URL]: NDX_API, [NDX_WIKI_URL]: NDX_WIKI,
    'https://en.wikipedia.org/w/api.php*': url => { revs.push(url); return REV; },
    'https://en.wikipedia.org/w/index.php?oldid=1095558369': url => (url.includes('oldid=') ? SP_NOW : null),
  };
  // Both indexes resolve to revid 1095558369 from the captured API answer; its page body is the S&P excerpt, so the Nasdaq history parse is 'unparsed'.
  const { app, u } = await make({ now: () => Date.parse('2020-06-15T15:00:00Z'), routes });
  await u.refresh();
  assert.equal(u.backfillStatus().total, 4);   // 2020-01-01 and 2020-04-01, two indexes
  const r1 = await u.backfill({ limit: 3 });
  assert.equal(r1.attempted, 3);
  assert.equal(r1.remaining, 1);
  const q = revs[0];
  assert.match(q, /titles=List%20of%20S%26P%20500%20companies/);
  assert.match(q, /rvstart=2020-01-01T00:00:00Z/);
  assert.match(q, /rvdir=older/);
  assert.ok(revs.some(x => x.includes('titles=Nasdaq-100')));
  const asOf = u.membersAsOf('2020-02-15');
  assert.equal(asOf.sp500.snapshotAsOf, '2020-01-01');
  assert.equal(asOf.sp500.kind, 'history');
  assert.ok(asOf.sp500.symbols.includes('BRK.B'));
  assert.equal(u.membersAsOf('2019-12-31').sp500, null);                        // before any snapshot
  assert.equal(u.membersAsOf('2020-06-15').sp500.kind, 'current');
  const ok = app.db.stmt("SELECT revid, rev_time FROM universe_snapshot WHERE kind = 'history' AND status = 'ok' LIMIT 1").get();
  assert.equal(ok.revid, 1095558369);
  const r2 = await u.backfill();          // resumes with what is left; nothing is fetched twice
  assert.equal(r2.attempted, 1);
  const r3 = await u.backfill();
  assert.equal(r3.attempted, 0);
  await app.stop();
});

test('universe: a date with no revision, or a failing fetch, is recorded, retried a few times, then left alone', async () => {
  const empty = JSON.stringify({ query: { pages: { 1: { pageid: 1, title: 'X' } } } });
  const { app, u } = await make({ now: () => Date.parse('2020-02-15T15:00:00Z'), opts: { maxHistoryAttempts: 2 }, routes: { [SP_URL]: SP_NOW, [API_URL]: NDX_API, [NDX_WIKI_URL]: NDX_WIKI, 'https://en.wikipedia.org/w/api.php*': empty } });
  await u.refresh();
  assert.equal((await u.backfill()).failed, 2);      // 2020-01-01, both indexes
  assert.equal((await u.backfill()).failed, 2);      // second attempt
  assert.equal((await u.backfill()).attempted, 0);   // gave up: 2 attempts each
  const note = app.db.stmt("SELECT note FROM universe_snapshot WHERE kind = 'history' LIMIT 1").get().note;
  assert.match(note, /no revision of/);
  await app.stop();
});

test('universe: switching finance or wiki off (policy) stops the backfill early and the error is recorded', async () => {
  const policy = Object.assign(new Error('wiki lookups are off'), { code: 'REFUSED' });
  const { app, u, fetcher } = await make({ now: () => Date.parse('2020-06-15T15:00:00Z'), routes: { [SP_URL]: SP_NOW, [API_URL]: NDX_API, [NDX_WIKI_URL]: NDX_WIKI, 'https://en.wikipedia.org/w/api.php*': policy } });
  await u.refresh();
  const before = fetcher.calls.length;
  const r = await u.backfill();
  assert.equal(r.attempted, 1);          // stopped after the first refusal
  assert.equal(fetcher.calls.length, before + 1);
  assert.match(app.db.stmt("SELECT note FROM universe_snapshot WHERE kind = 'history'").get().note, /POLICY/);
  await app.stop();
});
