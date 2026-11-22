// Feature "universe" (vault S1, note 04 D4 and G15, note 05): S&P 500 plus Nasdaq-100, de-duplicated, with point-in-time membership.
//   current lists:  S&P 500   = Wikipedia "List of S&P 500 companies" (table id "constituents")
//                   Nasdaq-100 = api.nasdaq.com /api/quote/list-type/nasdaq100 (keyless), cross-checked against Wikipedia
//                                "List of NASDAQ-100 companies"; if the API fails the Wikipedia list is used.
//   point in time:  dated revisions of the Wikipedia pages ("List of S&P 500 companies", "Nasdaq-100"), one snapshot per index per
//                   quarter from 2020, found with the MediaWiki revisions API and read with index.php?oldid=. Wikipedia calls are spaced
//                   (default 6 s: it rate-limited a burst on 2026-11-14) and the backfill is bounded per run and resumable.
// Hosts: en.wikipedia.org and api.nasdaq.com, both already in net/policy.js BASE_HOSTS (no host or allowlist change here). All requests go
// through the fetcher passed in, so policy, timeout, size cap (2 MB) and the online.finance / wiki switches apply.
// Symbols are kept in the lists' own spelling (BRK.B); yahoo_symbol is the provider spelling (BRK-B).
// Verified live 2026-11-17 (read-only): revisions API answer shape, oldid pages (S&P 2022: 1.3 MB, under the 2 MB cap), Nasdaq API shape.
// NOT verified: that every quarterly revision since 2020 parses (a failure is stored as status 'failed' or 'unparsed', never skipped
// silently), and the 2 MB cap for every old S&P revision (the 2022 one is 1.3 MB).
const { findTable } = require('./html-table');
const { addDays, nyDate, parseDate } = require('./ny-time');
const { normalizeSymbol } = require('../stocks/provider');
const { toYahooSymbol, mapHttpError } = require('../stocks/yahoo');
const { ProviderDataError, TransientError, StockmanError } = require('../errors');

const MIGRATION_VERSION = 2;
const SP_PAGE = 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies';
const NDX_WIKI_PAGE = 'https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies';
const NDX_API = 'https://api.nasdaq.com/api/quote/list-type/nasdaq100';
const REV_API = (title, date) => `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&titles=${encodeURIComponent(title)}&rvlimit=1&rvprop=ids%7Ctimestamp&rvdir=older&rvstart=${date}T00:00:00Z&format=json`;
const OLDID = id => `https://en.wikipedia.org/w/index.php?oldid=${id}`;
const HISTORY_TITLE = { sp500: 'List of S&P 500 companies', ndx100: 'Nasdaq-100' };
const SANE = { sp500: [450, 550], ndx100: [90, 115] };   // a table outside these sizes is a parse failure, not data
const INDEXES = ['sp500', 'ndx100'];

const migration = {
  version: MIGRATION_VERSION, name: 'universe',
  up(raw) {
    raw.exec(`
      -- one fetch of one index list (today's list, or a dated Wikipedia revision). status says whether it can be trusted.
      CREATE TABLE universe_snapshot(
        id INTEGER PRIMARY KEY,
        index_name TEXT NOT NULL CHECK(index_name IN ('sp500','ndx100')),
        kind TEXT NOT NULL CHECK(kind IN ('current','history')),
        as_of TEXT NOT NULL,            -- YYYY-MM-DD: the New York date the list is for (history: the requested date)
        source TEXT NOT NULL,           -- wikipedia | nasdaq-api | wikipedia-list
        revid INTEGER, rev_time TEXT,   -- the Wikipedia revision used (history only)
        fetched_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ok','failed','unparsed')),
        n INTEGER NOT NULL DEFAULT 0,
        note TEXT);
      CREATE INDEX universe_snapshot_lookup ON universe_snapshot(index_name, kind, status, as_of);
      CREATE UNIQUE INDEX universe_snapshot_history_once ON universe_snapshot(index_name, as_of) WHERE kind = 'history' AND status = 'ok';
      -- the members of a snapshot; this is the point-in-time membership
      CREATE TABLE universe_member(
        snapshot_id INTEGER NOT NULL REFERENCES universe_snapshot(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,           -- as the list writes it (BRK.B)
        yahoo_symbol TEXT NOT NULL,     -- as the provider writes it (BRK-B)
        name TEXT,
        PRIMARY KEY(snapshot_id, symbol)) WITHOUT ROWID;
    `);
  },
};

// ---- parsers (pure) -------------------------------------------------------------------------------------------------------------
function cleanSymbols(rows, skipped) {
  const seen = new Map();
  for (const { symbol, name } of rows) {
    let s;
    try { s = normalizeSymbol(String(symbol).replace('/', '.')); } catch { skipped.push(String(symbol).slice(0, 12)); continue; }
    if (!seen.has(s)) seen.set(s, { symbol: s, yahooSymbol: toYahooSymbol(s), name: String(name || '').slice(0, 120) });
  }
  return [...seen.values()];
}
function tableRows(html, symbolHeaders, nameHeaders) {
  for (const sh of symbolHeaders) {
    for (const nh of nameHeaders) {
      const t = findTable(html, [sh, nh]);
      if (!t) continue;
      const si = t.header.indexOf(sh.toLowerCase()), ni = t.header.indexOf(nh.toLowerCase());
      return t.body.filter(r => r.length > Math.max(si, ni)).map(r => ({ symbol: r[si], name: r[ni] }));
    }
  }
  return null;
}
const parseSp500 = html => tableRows(html, ['Symbol'], ['Security']);
// the Nasdaq-100 pages have used both "Ticker" and "Symbol" for the column (the 2025-01-01 revision says Symbol: found by the live check)
const parseNdxWiki = html => tableRows(html, ['Ticker', 'Symbol'], ['Company']);
function parseNasdaqApi(json) {
  const rows = json?.data?.data?.rows;
  if (!Array.isArray(rows)) return null;
  return rows.map(r => ({ symbol: r?.symbol, name: r?.companyName }));
}

function createUniverse({ fetcher, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), opts = {} } = {}) {
  if (!fetcher || typeof fetcher.getText !== 'function') throw new TypeError('universe needs a fetcher with getText(source, url, opts)');
  const o = { refreshHours: 24, wikiSpacingMs: 6000, backfillFrom: '2020-01-01', backfillPerRun: 8, maxHistoryAttempts: 3, sane: SANE, ...opts };
  let db = null, log = null, stopping = false, lastWikiAt = null;

  // ---- network (all through the fetcher) ------------------------------------------------------------------------------------------
  async function get(source, url, ttlMs = 0) {
    if (source === 'wiki') {   // polite spacing between Wikipedia calls, cached or not asked: only real requests count, so space before each
      if (lastWikiAt !== null) { const wait = lastWikiAt + o.wikiSpacingMs - now(); if (wait > 0) await sleep(wait); }
      lastWikiAt = now();
    }
    let r;
    try { r = await fetcher.getText(source, url, { ttlMs }); } catch (err) { throw err instanceof StockmanError ? err : mapHttpError(err, new URL(url).hostname); }
    if (r.stale) throw new TransientError(`${new URL(url).hostname}: only an old cached copy is available (${Math.round((r.ageMs || 0) / 60000)} min old)`);
    return r.data;
  }

  function saveSnapshot({ index, kind, asOf, source, revid = null, revTime = null, status, members = [], note = null }) {
    return db.tx(() => {
      const id = Number(db.stmt('INSERT INTO universe_snapshot(index_name, kind, as_of, source, revid, rev_time, fetched_at, status, n, note) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(index, kind, asOf, source, revid, revTime, now(), status, members.length, note ? String(note).slice(0, 500) : null).lastInsertRowid);
      const ins = db.stmt('INSERT INTO universe_member(snapshot_id, symbol, yahoo_symbol, name) VALUES (?,?,?,?)');
      for (const m of members) ins.run(id, m.symbol, m.yahooSymbol, m.name);
      return id;
    });
  }
  const sizeOk = (index, n) => n >= o.sane[index][0] && n <= o.sane[index][1];

  // turn parsed rows into a stored snapshot; a table of the wrong size is stored as 'unparsed' (kept for audit, never used)
  function store({ index, kind, asOf, source, rows, extra = {} }) {
    const skipped = [];
    const members = rows ? cleanSymbols(rows, skipped) : [];
    const note = [extra.note, skipped.length ? `skipped invalid symbols: ${skipped.slice(0, 8).join(' ')}` : null].filter(Boolean).join('; ') || null;
    if (!rows) return { status: 'unparsed', id: saveSnapshot({ index, kind, asOf, source, ...extra, status: 'unparsed', note: [note, 'no table found in the response'].filter(Boolean).join('; ') }), members: [] };
    if (!sizeOk(index, members.length)) return { status: 'unparsed', id: saveSnapshot({ index, kind, asOf, source, ...extra, status: 'unparsed', note: [note, `${members.length} symbols is outside the expected ${o.sane[index][0]} to ${o.sane[index][1]}`].filter(Boolean).join('; ') }), members: [] };
    return { status: 'ok', id: saveSnapshot({ index, kind, asOf, source, ...extra, status: 'ok', members, note }), members };
  }
  function recordFailure({ index, kind, asOf, source, err, extra = {} }) {
    try { saveSnapshot({ index, kind, asOf, source, ...extra, status: 'failed', note: `${err.code || 'ERROR'}: ${err.message}` }); } catch { /* the failure is also logged by the caller */ }
  }

  // ---- current lists --------------------------------------------------------------------------------------------------------------
  const latestCurrent = index => db.stmt("SELECT * FROM universe_snapshot WHERE index_name = ? AND kind = 'current' AND status = 'ok' ORDER BY id DESC LIMIT 1").get(index);

  async function fetchSp500(asOf) {
    const html = await get('wiki', SP_PAGE);
    return store({ index: 'sp500', kind: 'current', asOf, source: 'wikipedia', rows: parseSp500(html) });
  }
  async function fetchNdx100(asOf) {
    let primary = null, apiError = null;
    try {
      const json = JSON.parse(await get('finance', NDX_API));
      const rows = parseNasdaqApi(json);
      primary = { source: 'nasdaq-api', rows, note: json?.data?.date ? `list dated ${json.data.date}` : null };
    } catch (err) { apiError = err; }
    let wikiRows = null, wikiError = null;
    try { wikiRows = parseNdxWiki(await get('wiki', NDX_WIKI_PAGE)); } catch (err) { wikiError = err; }
    if (!primary && !wikiRows) throw apiError || wikiError;
    if (!primary || !primary.rows) primary = { source: 'wikipedia-list', rows: wikiRows, note: apiError ? `Nasdaq API failed (${apiError.message}); used the Wikipedia list` : 'Nasdaq API had no table; used the Wikipedia list' };
    // cross-check the two sources: a difference is reported, not resolved
    let note = primary.note;
    if (primary.source === 'nasdaq-api' && wikiRows) {
      const a = new Set(cleanSymbols(primary.rows, []).map(m => m.symbol)), b = new Set(cleanSymbols(wikiRows, []).map(m => m.symbol));
      const onlyApi = [...a].filter(s => !b.has(s)), onlyWiki = [...b].filter(s => !a.has(s));
      note = [note, onlyApi.length + onlyWiki.length ? `cross-check differs: only in API ${onlyApi.slice(0, 6).join(' ') || '-'}; only in Wikipedia ${onlyWiki.slice(0, 6).join(' ') || '-'}` : 'cross-check: Wikipedia list agrees'].filter(Boolean).join('; ');
    } else if (primary.source === 'nasdaq-api') note = [note, `cross-check not possible: ${wikiError ? wikiError.message : 'no Wikipedia table'}`].filter(Boolean).join('; ');
    return store({ index: 'ndx100', kind: 'current', asOf, source: primary.source, rows: primary.rows, extra: { note } });
  }

  // refresh() → { status: 'fresh' | 'refreshed' | 'reused' | 'none', ... }. 'reused' = the fetch failed and the last good snapshot is used, flagged with its age.
  async function refresh({ force = false } = {}) {
    const t = now(), asOf = nyDate(t), problems = [];
    for (const index of INDEXES) {
      if (stopping) break;
      const last = latestCurrent(index);
      if (!force && last && t - last.fetched_at < o.refreshHours * 3600000) continue;
      try {
        const r = await (index === 'sp500' ? fetchSp500 : fetchNdx100)(asOf);
        if (r.status !== 'ok') problems.push(`${index}: list could not be read (${r.status})`);
      } catch (err) {
        problems.push(`${index}: ${err.message}`);
        recordFailure({ index, kind: 'current', asOf, source: index === 'sp500' ? 'wikipedia' : 'nasdaq-api', err });
        log?.warn(`universe: could not refresh ${index}`, { code: err.code, message: err.message });
      }
    }
    const info = describe();
    // none: no list at all; incomplete: only one of the two lists exists; reused: a fetch failed, the last good lists are used; ok
    const status = !info.n ? 'none' : !info.complete ? 'incomplete' : problems.length ? 'reused' : 'ok';
    return { status, problems, ...info };
  }

  // ---- reading the stored universe ------------------------------------------------------------------------------------------------
  function members(snapshotId) { return db.stmt('SELECT symbol, yahoo_symbol AS yahooSymbol, name FROM universe_member WHERE snapshot_id = ? ORDER BY symbol').all(snapshotId); }

  // today's universe: both current lists merged, one entry per symbol, with the indexes it belongs to
  function symbols() {
    const by = new Map();
    for (const index of INDEXES) {
      const snap = latestCurrent(index);
      if (!snap) continue;
      for (const m of members(snap.id)) {
        const e = by.get(m.symbol) || { symbol: m.symbol, yahooSymbol: m.yahooSymbol, name: m.name, indexes: [] };
        e.indexes.push(index);
        by.set(m.symbol, e);
      }
    }
    return [...by.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }
  function describe() {
    const list = symbols(), snaps = INDEXES.map(i => latestCurrent(i)).filter(Boolean);
    const byIndex = Object.fromEntries(INDEXES.map(i => [i, list.filter(s => s.indexes.includes(i)).length]));
    const oldest = snaps.length ? Math.min(...snaps.map(s => s.fetched_at)) : null;
    return { n: list.length, byIndex, overlap: byIndex.sp500 + byIndex.ndx100 - list.length, snapshotAt: oldest, ageMs: oldest === null ? null : now() - oldest, sources: Object.fromEntries(snaps.map(s => [s.index_name, s.source])), complete: snaps.length === INDEXES.length };
  }
  // point-in-time membership: the members of the newest ok snapshot dated on or before `date`, per index; null where there is none
  function membersAsOf(date) {
    parseDate(date);
    const out = {};
    for (const index of INDEXES) {
      const s = db.stmt("SELECT id, as_of, kind FROM universe_snapshot WHERE index_name = ? AND status = 'ok' AND as_of <= ? ORDER BY as_of DESC, id DESC LIMIT 1").get(index, date);
      out[index] = s ? { snapshotAsOf: s.as_of, kind: s.kind, symbols: members(s.id).map(m => m.symbol) } : null;
    }
    return out;
  }

  // ---- point-in-time backfill -----------------------------------------------------------------------------------------------------
  // quarter starts from backfillFrom up to (not including) the first current snapshot's date
  function backfillDates() {
    const first = db.stmt("SELECT MIN(as_of) AS d FROM universe_snapshot WHERE kind = 'current' AND status = 'ok'").get().d || nyDate(now());
    const out = [];
    let [y, m] = o.backfillFrom.split('-').map(Number);
    for (;;) {
      const d = `${y}-${String(m).padStart(2, '0')}-01`;
      if (d >= first) break;
      out.push(d);
      m += 3; if (m > 12) { m -= 12; y++; }
    }
    return out;
  }
  function pending() {
    const todo = [];
    for (const d of backfillDates()) for (const index of INDEXES) {
      // 'ok' and 'unparsed' are final (a dated revision never changes, so it would parse the same way again); only network failures are retried
      const done = db.stmt("SELECT SUM(status IN ('ok','unparsed')) AS final, SUM(status = 'failed') AS failed FROM universe_snapshot WHERE kind = 'history' AND index_name = ? AND as_of = ?").get(index, d);
      if (!done.final && (done.failed || 0) < o.maxHistoryAttempts) todo.push({ index, date: d });
    }
    return todo;
  }
  async function snapshotAt(index, date) {
    const title = HISTORY_TITLE[index];
    const rev = JSON.parse(await get('wiki', REV_API(title, date), 3600000));
    const page = Object.values(rev?.query?.pages || {})[0];
    const r = page?.revisions?.[0];
    if (!r || !Number.isInteger(r.revid)) { saveSnapshot({ index, kind: 'history', asOf: date, source: 'wikipedia', status: 'failed', note: `no revision of "${title}" on or before ${date}` }); return 'failed'; }
    const html = await get('wiki', OLDID(r.revid), 30 * 86400000);
    const rows = index === 'sp500' ? parseSp500(html) : parseNdxWiki(html);
    return store({ index, kind: 'history', asOf: date, source: 'wikipedia', rows, extra: { revid: r.revid, revTime: r.timestamp || null } }).status;
  }
  // do up to `limit` pending (index, date) snapshots; returns what happened. Each one is stored on its own, so a stop or a crash loses nothing.
  async function backfill({ limit = o.backfillPerRun } = {}) {
    const todo = pending(), result = { attempted: 0, ok: 0, failed: 0, unparsed: 0, remaining: todo.length };
    for (const job of todo.slice(0, limit)) {
      if (stopping) break;
      result.attempted++;
      try {
        const st = await snapshotAt(job.index, job.date);
        if (st === 'ok') result.ok++; else if (st === 'unparsed') result.unparsed++; else result.failed++;
      } catch (err) {
        result.failed++;
        recordFailure({ index: job.index, kind: 'history', asOf: job.date, source: 'wikipedia', err });
        log?.warn(`universe: backfill ${job.index} ${job.date} failed`, { code: err.code, message: err.message });
        if (err.code === 'POLICY') break;   // switched off: stop trying this run
      }
    }
    result.remaining = pending().length;
    return result;
  }
  // per (index, quarter): ok, unparsed (final: a dated revision parses the same way every time), given up (failed maxHistoryAttempts times)
  function backfillStatus() {
    const n = sql => Number(db.stmt(sql).get().n);
    const unparsed = db.stmt("SELECT index_name AS i, as_of AS d FROM universe_snapshot s WHERE kind = 'history' AND status = 'unparsed' AND NOT EXISTS (SELECT 1 FROM universe_snapshot t WHERE t.kind = 'history' AND t.status = 'ok' AND t.index_name = s.index_name AND t.as_of = s.as_of) GROUP BY index_name, as_of").all();
    return {
      pending: pending().length, total: backfillDates().length * INDEXES.length,
      ok: n("SELECT COUNT(*) AS n FROM universe_snapshot WHERE kind = 'history' AND status = 'ok'"),
      unparsed: unparsed.length, unparsedList: unparsed.slice(0, 20).map(r => `${r.i} ${r.d}`),
      givenUp: n(`SELECT COUNT(*) AS n FROM (SELECT index_name, as_of FROM universe_snapshot s WHERE kind = 'history' GROUP BY index_name, as_of
        HAVING SUM(status IN ('ok','unparsed')) = 0 AND SUM(status = 'failed') >= ${Number(o.maxHistoryAttempts)})`),
    };
  }
  // every symbol that is in any stored ok list (today's or a dated one): what the backtest needs bars for
  const allSymbols = () => db.stmt("SELECT DISTINCT m.symbol FROM universe_member m JOIN universe_snapshot s ON s.id = m.snapshot_id WHERE s.status = 'ok' ORDER BY m.symbol").all().map(r => r.symbol);

  const api = { refresh, symbols, allSymbols, describe, membersAsOf, backfill, backfillStatus, parseSp500, parseNdxWiki, parseNasdaqApi };
  const feature = {
    id: 'universe', migrations: [migration],
    async start(ctx) { db = ctx.db; log = ctx.log; stopping = false; },
    async stop() { stopping = true; },
  };
  return { feature, api };
}

module.exports = { createUniverse, parseSp500, parseNdxWiki, parseNasdaqApi, MIGRATION_VERSION };
