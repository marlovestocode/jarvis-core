// Feature "bars" (vault S2, note 05 feed sweep): daily bars for the universe through the existing StockProvider (ctx.stocks), stored in
// stockman.db, with a coverage figure and honest gaps.
//   - one history call per symbol, paced (default: calls start at least 150 ms apart; the framework rate limiter, 5 per second by
//     default, still applies on top, so a 518-symbol sweep is about 2 minutes, matching the 2026-11-14 measurement);
//   - only FINISHED sessions are stored: a bar dated after `target` (the last completed session) is the day in progress and is dropped
//     and counted, never stored, because a partial bar looks like a real one;
//   - a missing day is recorded in bar_gap with a reason. It is never filled, interpolated or copied from the previous day;
//   - a stale answer (the provider was unreachable and an old cached copy came back) is NOT stored: it is recorded as a gap reason;
//   - a sweep is idempotent and resumable: a symbol that already has the target day is skipped, so a crash or a stop costs nothing.
// Quote delay is unmeasured (vault CL-0008): nothing here claims real time. Day = New York calendar date of the bar's timestamp.
// Daily bar timestamps seen live on 2026-11-17 (BRK-B, 1mo): 14:30 UTC in winter = 09:30 New York, one per session.
const { addDays, nyDate } = require('./ny-time');
const { tradingDays } = require('./calendar-rules');
const { StockmanError } = require('../errors');

const MIGRATION_VERSION = 3;
const HISTORY_MIGRATION_VERSION = 6;
const MAX_GAP_ROWS = 30;   // per symbol per sweep
// Two stored bars of the same symbol and day disagree when a later fetch re-adjusted the series (a split changes `close`, a dividend
// changes `adj_close` of every earlier day). Below these relative differences they are the same number (float noise in the provider).
const CLOSE_TOL = 1e-4, ADJ_TOL = 1e-5;
const migration = {
  version: MIGRATION_VERSION, name: 'bars',
  up(raw) {
    raw.exec(`
      -- one finished trading day of one symbol. adj_close is the provider's split/dividend adjusted close and can be revised later,
      -- so a re-fetch updates it. day is the New York date (YYYY-MM-DD). The symbol is the list's spelling (BRK.B).
      CREATE TABLE bar(
        symbol TEXT NOT NULL, day TEXT NOT NULL,
        open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
        adj_close REAL, volume REAL NOT NULL,
        source TEXT NOT NULL, fetched_at INTEGER NOT NULL,
        PRIMARY KEY(symbol, day)) WITHOUT ROWID;
      CREATE INDEX bar_day ON bar(day);
      -- a symbol-day that should have a bar and does not (or a symbol that could not be fetched). Never filled in; resolved_at is set
      -- only when a real bar for that symbol and day is later stored.
      CREATE TABLE bar_gap(
        id INTEGER PRIMARY KEY,
        symbol TEXT NOT NULL, day TEXT NOT NULL,
        reason TEXT NOT NULL,           -- no_data | not_found | not_returned | before_range | stale_only | fetch_failed:<CODE> | not_returned_<N>_more_days_from_here
        detected_at INTEGER NOT NULL, resolved_at INTEGER,
        UNIQUE(symbol, day));
      CREATE INDEX bar_gap_open ON bar_gap(resolved_at);
      -- one row per sweep: how much of the universe had fresh data when it finished
      CREATE TABLE coverage(
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL, target_day TEXT NOT NULL,
        universe_n INTEGER NOT NULL, fresh_n INTEGER NOT NULL, stale_n INTEGER NOT NULL, missing_n INTEGER NOT NULL,
        oldest_latest_day TEXT, newest_day TEXT,
        failed_n INTEGER NOT NULL DEFAULT 0, sweep_ms INTEGER, note TEXT);
    `);
  },
};

// Deep history (backtest data): one full-series fetch per symbol back to `from`, for every symbol that was ever in the point-in-time
// universe plus the benchmark. One row per symbol says whether that fetch was done and what it found.
//   status ok          fetched and stored in full (one fetch, so all its adjusted closes are on one basis)
//          not_found   the provider has no such symbol (delisted, merged, renamed): a survivorship gap, reported, never filled
//          failed      network or data failure; retried up to `deepAttempts` times
//          readjust    a daily sweep saw stored closes change (split or dividend): the whole series is fetched again
const historyMigration = {
  version: HISTORY_MIGRATION_VERSION, name: 'bars-history',
  up(raw) {
    raw.exec(`
      CREATE TABLE bar_history(
        symbol TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('ok','not_found','failed','readjust')),
        from_day TEXT,                    -- the oldest day this fetch asked for
        first_day TEXT, last_day TEXT,    -- the oldest and newest finished day it returned (null when none)
        n INTEGER NOT NULL DEFAULT 0,     -- bars stored by it
        missing_n INTEGER NOT NULL DEFAULT 0,   -- trading days between first_day and last_day it did not return
        provider_name TEXT,               -- the provider's company name, kept for a ticker-reuse check
        attempts INTEGER NOT NULL DEFAULT 0,
        fetched_at INTEGER, note TEXT);
      CREATE INDEX bar_history_status ON bar_history(status);
    `);
  },
};

// the smallest provider range that covers `missing` trading days (the provider's 1mo holds about 21 sessions; thresholds leave slack)
function pickRange(missing) {
  if (missing <= 3) return '5d';
  if (missing <= 18) return '1mo';
  if (missing <= 58) return '3mo';
  if (missing <= 120) return '6mo';
  if (missing <= 245) return '1y';
  if (missing <= 490) return '2y';
  if (missing <= 1240) return '5y';
  return '10y';
}
const RANGE_SESSIONS = { '5d': 5, '1mo': 21, '3mo': 63, '6mo': 126, '1y': 252, '2y': 504, '5y': 1260, '10y': 2520 };

function createBars({ now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), opts = {} } = {}) {
  const o = { paceMs: 150, initialRange: '1y', deepPerRun: 200, deepAttempts: 3, ...opts };
  let db = null, stocks = null, log = null, stopping = false, lastCallAt = null;

  const latestDays = () => new Map(db.stmt('SELECT symbol, MAX(day) AS d FROM bar GROUP BY symbol').all().map(r => [r.symbol, r.d]));
  const setGap = (symbol, day, reason) => db.stmt('INSERT INTO bar_gap(symbol, day, reason, detected_at) VALUES (?,?,?,?) ON CONFLICT(symbol, day) DO UPDATE SET reason = excluded.reason WHERE resolved_at IS NULL').run(symbol, day, reason, now());

  async function pace() {
    if (lastCallAt !== null) { const wait = lastCallAt + o.paceMs - now(); if (wait > 0) await sleep(wait); }
    lastCallAt = now();
  }

  // store one symbol's history. Returns { written, partialDropped, gaps, readjusted, firstDay, lastDay }.
  // `from` (deep fetches) drops bars older than the history start. Without `deep`, stored days that the new fetch returns with a different
  // close or adjusted close mark the symbol 'readjust': the older stored days it did NOT return are now on a different basis.
  function store(symbol, history, target, before, { from = null, deep = false } = {}) {
    const byDay = new Map();
    let partialDropped = 0;
    for (const b of history.bars) {
      const day = nyDate(b.t);
      if (day > target) { partialDropped++; continue; }   // the session in progress, or a day the calendar says is not finished
      if (from && day < from) continue;                    // older than the history kept
      byDay.set(day, b);
    }
    const days = [...byDay.keys()].sort();
    return db.tx(() => {
      let readjusted = false;
      if (!deep && days.length) {
        const old = db.stmt('SELECT day, close, adj_close AS adj FROM bar WHERE symbol = ? AND day >= ? AND day <= ?').all(symbol, days[0], days.at(-1));
        const olderKept = old.length > 0 && db.stmt('SELECT 1 AS x FROM bar WHERE symbol = ? AND day < ? LIMIT 1').get(symbol, days[0]);
        const differs = (a, b, tol) => a != null && b != null && Math.abs(a / b - 1) > tol;
        readjusted = Boolean(olderKept) && old.some(r => { const b = byDay.get(r.day); return differs(b.close, r.close, CLOSE_TOL) || differs(b.adjClose, r.adj, ADJ_TOL); });
        if (readjusted) {
          db.stmt(`INSERT INTO bar_history(symbol, status, attempts, note) VALUES (?, 'readjust', 0, ?)
            ON CONFLICT(symbol) DO UPDATE SET status = 'readjust', attempts = 0, note = excluded.note`).run(symbol, `stored closes changed on ${nyDate(now())} (split or dividend); the full series is fetched again`);
        }
      }
      const up = db.stmt(`INSERT INTO bar(symbol, day, open, high, low, close, adj_close, volume, source, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(symbol, day) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, adj_close = excluded.adj_close, volume = excluded.volume, source = excluded.source, fetched_at = excluded.fetched_at`);
      const resolve = db.stmt('UPDATE bar_gap SET resolved_at = ? WHERE symbol = ? AND day = ? AND resolved_at IS NULL');
      for (const day of days) {
        const b = byDay.get(day);
        up.run(symbol, day, b.open, b.high, b.low, b.close, b.adjClose, b.volume, history.source, history.fetchedAt);
        resolve.run(now(), symbol, day);
      }
      // gaps: trading days between where we expect data to begin and the target that are still missing. A symbol with no stored bar before
      // this sweep is expected to start at its first returned day (it may have listed recently), so days before that are not gaps.
      const have = new Set(db.stmt('SELECT day FROM bar WHERE symbol = ? AND day >= ?').all(symbol, before ? addDays(before, 1) : (days[0] || target)).map(r => r.day));
      const from = before ? addDays(before, 1) : days[0];
      let gaps = 0;
      if (!from) { setGap(symbol, target, 'no_data'); gaps = 1; } else {
        const missing = tradingDays(from, target).filter(d => !have.has(d));
        // a long run of missing days is one fact, not hundreds of rows: keep the newest MAX_GAP_ROWS and one summary row at the first missing day
        const keep = missing.length > MAX_GAP_ROWS ? missing.slice(-MAX_GAP_ROWS) : missing;
        if (missing.length > MAX_GAP_ROWS) setGap(symbol, missing[0], `not_returned_${missing.length - MAX_GAP_ROWS}_more_days_from_here`);
        for (const d of keep) setGap(symbol, d, days.length && d < days[0] ? 'before_range' : 'not_returned');
        gaps = missing.length;
      }
      return { written: days.length, partialDropped, gaps, readjusted, firstDay: days[0] || null, lastDay: days.at(-1) || null };
    });
  }

  // sweep({ symbols: string[], target, range?, newSymbolRange? }) → summary. `target` = last completed session (calendar-rules.lastCompletedSession).
// `range` is for symbols that already have bars (just the missing sessions); a symbol with no bar yet gets `newSymbolRange` (default the initial history).
  async function sweep({ symbols, target, range = o.initialRange, newSymbolRange = o.initialRange, onProgress } = {}) {
    if (!db) throw new StockmanError('bars: not started');
    if (!Array.isArray(symbols)) throw new TypeError('sweep needs { symbols: string[], target }');
    const t0 = now(), latest = latestDays();
    const res = { target, range, universe: symbols.length, attempted: 0, skippedFresh: 0, symbolsStored: 0, barsWritten: 0, partialDropped: 0, gaps: 0, readjust: 0, failed: 0, failures: [], aborted: null, stopped: false, ms: 0 };
    for (const symbol of symbols) {
      if (stopping) { res.stopped = true; break; }
      const before = latest.get(symbol) || null;
      if (before && before >= target) { res.skippedFresh++; continue; }
      await pace();
      res.attempted++;
      let history;
      try { history = await stocks.getHistory({ symbol, range: before ? range : newSymbolRange, interval: '1d' }); } catch (err) {
        res.failed++;
        const code = err.code || 'UNKNOWN';
        const reason = code === 'NOT_FOUND' ? 'not_found' : `fetch_failed:${code}`;
        try { setGap(symbol, target, reason); } catch { /* the gap table must not stop the sweep */ }
        if (res.failures.length < 10) res.failures.push({ symbol, code, message: String(err.message).slice(0, 160) });
        if (code === 'CIRCUIT_OPEN' || code === 'POLICY') { res.aborted = code === 'POLICY' ? 'policy: market-data lookups are off' : 'circuit open: the provider looks unhealthy'; break; }
        continue;
      }
      if (history.stale) {
        res.failed++; setGap(symbol, target, 'stale_only');
        if (res.failures.length < 10) res.failures.push({ symbol, code: 'STALE', message: 'only an old cached copy was available' });
        continue;
      }
      const r = store(symbol, history, target, before);
      res.barsWritten += r.written; res.partialDropped += r.partialDropped; res.gaps += r.gaps;
      if (r.readjusted) res.readjust++;
      if (r.written) res.symbolsStored++;
      try { onProgress?.({ done: res.attempted + res.skippedFresh, of: symbols.length }); } catch { /* progress is informational */ }
    }
    res.ms = now() - t0;
    return res;
  }

  // ---- deep history ----------------------------------------------------------------------------------------------------------------
  // which of `symbols` still need a full-series fetch back to `from`: never fetched, fetched from a later start, flagged readjust, or
  // failed fewer than deepAttempts times. 'not_found' is final for that start (the provider does not know the symbol).
  function deepPending({ symbols, from }) {
    const rows = new Map(db.stmt('SELECT symbol, status, from_day AS fromDay, attempts FROM bar_history').all().map(r => [r.symbol, r]));
    const out = [];
    for (const s of new Set(symbols)) {
      const r = rows.get(s);
      if (!r || r.status === 'readjust') { out.push(s); continue; }
      if (r.fromDay === null || r.fromDay > from) { out.push(s); continue; }   // asked for a later start before: this start needs more
      if (r.status === 'failed' && r.attempts < o.deepAttempts) out.push(s);
    }
    return out;
  }
  function setHistory(symbol, f) {
    db.stmt(`INSERT INTO bar_history(symbol, status, from_day, first_day, last_day, n, missing_n, provider_name, attempts, fetched_at, note) VALUES (?,?,?,?,?,?,?,?,1,?,?)
      ON CONFLICT(symbol) DO UPDATE SET status = excluded.status, from_day = excluded.from_day, first_day = excluded.first_day, last_day = excluded.last_day, n = excluded.n,
        missing_n = excluded.missing_n, provider_name = COALESCE(excluded.provider_name, bar_history.provider_name),
        attempts = CASE WHEN excluded.status = 'failed' THEN bar_history.attempts + 1 ELSE 1 END, fetched_at = excluded.fetched_at, note = excluded.note`)
      .run(symbol, f.status, f.from, f.firstDay ?? null, f.lastDay ?? null, f.n ?? 0, f.missing ?? 0, f.name ?? null, now(), f.note ? String(f.note).slice(0, 400) : null);
  }
  // deepen({ symbols, from, target, limit }) → summary. One full-series fetch per pending symbol, paced like the sweep, each stored on its
  // own (resumable). The whole returned series is written, so every stored adjusted close of that symbol is on one basis.
  async function deepen({ symbols, from, target, limit = o.deepPerRun, onProgress } = {}) {
    if (!db) throw new StockmanError('bars: not started');
    if (!Array.isArray(symbols) || !from || !target) throw new TypeError('deepen needs { symbols: string[], from, target }');
    const todo = deepPending({ symbols, from }).slice(0, Math.max(0, limit));
    const range = pickRange(tradingDays(from, target).length + 5);
    const res = { from, target, range, attempted: 0, ok: 0, notFound: 0, failed: 0, barsWritten: 0, failures: [], aborted: null, stopped: false, remaining: 0 };
    for (const symbol of todo) {
      if (stopping) { res.stopped = true; break; }
      await pace();
      res.attempted++;
      let history;
      try { history = await stocks.getHistory({ symbol, range, interval: '1d' }); } catch (err) {
        const code = err.code || 'UNKNOWN';
        if (code === 'NOT_FOUND') { setHistory(symbol, { status: 'not_found', from, note: String(err.message).slice(0, 200) }); res.notFound++; continue; }
        res.failed++;
        try { setHistory(symbol, { status: 'failed', from, note: `${code}: ${err.message}` }); } catch { /* keep going */ }
        if (res.failures.length < 10) res.failures.push({ symbol, code, message: String(err.message).slice(0, 160) });
        if (code === 'CIRCUIT_OPEN' || code === 'POLICY') { res.aborted = code === 'POLICY' ? 'policy: market-data lookups are off' : 'circuit open: the provider looks unhealthy'; break; }
        continue;
      }
      if (history.stale) { res.failed++; setHistory(symbol, { status: 'failed', from, note: 'STALE: only an old cached copy was available' }); continue; }
      const r = store(symbol, history, target, null, { from, deep: true });
      const missing = r.firstDay ? tradingDays(r.firstDay, r.lastDay).length - r.written : 0;
      // an answer with no usable bars at all (seen live 2026-11-17: BK, K, CTRA, WBD and others, relisted or renamed tickers) is the same
      // survivorship gap as an unknown symbol: recorded as not_found so reports count it, never as a symbol with history
      if (!r.written) { setHistory(symbol, { status: 'not_found', from, name: history.name, note: 'the provider returned no finished bars in range' }); res.notFound++; continue; }
      setHistory(symbol, {
        status: 'ok', from, firstDay: r.firstDay, lastDay: r.lastDay, n: r.written, missing, name: history.name,
        note: r.firstDay > from ? `series starts ${r.firstDay}, after ${from}: listed later, or the provider's history is shorter` : null,
      });
      res.ok++; res.barsWritten += r.written;
      try { onProgress?.({ done: res.attempted, of: todo.length, symbol }); } catch { /* informational */ }
    }
    res.remaining = deepPending({ symbols, from }).length;
    return res;
  }
  // how far the deep history is for `symbols` (counts only rows fetched from `from` or earlier)
  function deepStatus({ symbols, from }) {
    const want = new Set(symbols);
    const rows = db.stmt('SELECT symbol, status, from_day AS fromDay FROM bar_history').all().filter(r => want.has(r.symbol));
    const c = { from, wanted: want.size, ok: 0, notFound: 0, failed: 0, readjust: 0, pending: 0, notFoundSymbols: [] };
    for (const r of rows) {
      if (r.status === 'readjust') { c.readjust++; continue; }
      if (r.fromDay === null || r.fromDay > from) continue;
      if (r.status === 'ok') c.ok++; else if (r.status === 'not_found') { c.notFound++; c.notFoundSymbols.push(r.symbol); } else c.failed++;
    }
    c.notFoundSymbols = c.notFoundSymbols.sort().slice(0, 60);
    c.pending = deepPending({ symbols, from }).length;
    return c;
  }

  // ---- reading --------------------------------------------------------------------------------------------------------------------
  // coverage: of the given symbols, how many have a bar for the target day ('fresh'), how many only older bars ('stale'), how many none
  function coverageNow({ symbols, target }) {
    const latest = latestDays();
    let fresh = 0, stale = 0, missing = 0, oldest = null, newest = null;
    for (const s of symbols) {
      const d = latest.get(s);
      if (!d) { missing++; continue; }
      if (d >= target) fresh++; else stale++;
      if (oldest === null || d < oldest) oldest = d;
      if (newest === null || d > newest) newest = d;
    }
    return { target, universe: symbols.length, fresh, stale, missing, oldestLatestDay: oldest, newestDay: newest };
  }
  function recordCoverage(c, { failed = 0, ms = null, note = null } = {}) {
    db.stmt('INSERT INTO coverage(at, target_day, universe_n, fresh_n, stale_n, missing_n, oldest_latest_day, newest_day, failed_n, sweep_ms, note) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(now(), c.target, c.universe, c.fresh, c.stale, c.missing, c.oldestLatestDay, c.newestDay, failed, ms, note);
  }
  const lastCoverage = () => db.stmt('SELECT * FROM coverage ORDER BY id DESC LIMIT 1').get() || null;
  // how many symbols have a bar on each given day (for the calendar cross-check). With `symbols`, only those count: deep history and the
  // benchmark also store recent bars, and they are not part of today's universe.
  function symbolsWithBarOn(days, symbols = null) {
    const out = {}, list = symbols ? JSON.stringify(symbols) : null;
    for (const d of days) {
      out[d] = Number((list
        ? db.stmt('SELECT COUNT(*) AS n FROM bar WHERE day = ? AND symbol IN (SELECT value FROM json_each(?))').get(d, list)
        : db.stmt('SELECT COUNT(*) AS n FROM bar WHERE day = ?').get(d)).n);
    }
    return out;
  }
  const gapDays = () => Number(db.stmt('SELECT COUNT(DISTINCT day) AS n FROM bar_gap WHERE resolved_at IS NULL').get().n);
  const gapCount = () => Number(db.stmt('SELECT COUNT(*) AS n FROM bar_gap WHERE resolved_at IS NULL').get().n);
  const openGaps = ({ limit = 50 } = {}) => db.stmt('SELECT symbol, day, reason, detected_at AS detectedAt FROM bar_gap WHERE resolved_at IS NULL ORDER BY day DESC, symbol LIMIT ?').all(Math.max(1, Math.min(500, limit)));
  const lastBarDay = () => db.stmt('SELECT MAX(day) AS d FROM bar').get().d || null;
  // trading days after the newest stored bar up to target: the span a catch-up has to cover (all of the days, when nothing is stored)
  const missingTradingDays = target => { const last = lastBarDay(); return last ? (last >= target ? [] : tradingDays(addDays(last, 1), target)) : null; };

  const api = { sweep, deepen, deepPending, deepStatus, coverageNow, recordCoverage, lastCoverage, symbolsWithBarOn, gapCount, gapDays, openGaps, lastBarDay, missingTradingDays, pickRange, options: o };
  const feature = {
    id: 'bars', migrations: [migration, historyMigration],
    async start(ctx) { db = ctx.db; stocks = ctx.stocks; log = ctx.log; stopping = false; void log; },
    async stop() { stopping = true; },
  };
  return { feature, api };
}

module.exports = { createBars, pickRange, RANGE_SESSIONS, MIGRATION_VERSION, HISTORY_MIGRATION_VERSION };
