// Feature "earnings" (vault G23, note 06 "Earnings"): the Nasdaq earnings calendar by date, stored, and the per-trade earnings flags.
//   source:  https://api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD, one request per date, keyless, host already in net/policy.js
//            BASE_HOSTS (CL-0007), fetched through jarvis's fetcher under the 'finance' source (online.finance switches it off).
//   shape, seen live 2026-11-17: { data: { asOf, headers, rows: [{ symbol, name, time, eps, surprise, epsForecast, fiscalQuarterEnding,
//            lastYearRptDt?, lastYearEPS?, marketCap, noOfEsts }] }, message, status }. A past date has eps and surprise; a future date has
//            lastYearRptDt and lastYearEPS instead. time is time-pre-market | time-after-hours | time-not-supplied. A date with no reports
//            has rows null or [] (a Saturday, 2026-11-21). 2020-01-28 had 80 rows with AAPL in them (Apple reported that day).
//   storage: earnings_fetch = what was fetched for each date; earnings_event = one row per symbol and report date. A date's fetch
//            REPLACES that date's rows, so a report that moved to another date disappears from the old one.
//   plan:    future dates (today to +lookaheadDays) are fetched again every day, because dates move; past dates once from historyFrom,
//            and once more when the first fetch was made before the date had passed (then the rows were forecasts, not reports).
// Flags (note 06 rules), flags({ symbol, entryDay, exitDay }):
//   earnings_in_window  a stored report date falls between the entry day and one trading day after the exit day
//   earnings_possible   no stored date in the window, but the last report + 91 days falls within 7 days of the window
//   earnings_data       confirmed (the calendar was fetched for every day of the window and either shows the report or shows a later one)
//                       | estimated (the estimate was used) | unknown (nothing to go on)
// Honest limit for backtests: past dates are the dates reports actually happened. A trader at the time usually knew them in advance
// (companies announce them weeks before), but not always: using them as "known" is an ASSUMPTION, recorded in vault note 06.
const { addDays, nyDate, parseDate, dayOfWeek } = require('./ny-time');
const { nextTradingDay } = require('./calendar-rules');
const { normalizeSymbol } = require('../stocks/provider');
const { mapHttpError } = require('../stocks/yahoo');
const { ProviderDataError, TransientError, StockmanError } = require('../errors');

const MIGRATION_VERSION = 7;
const URL_FOR = day => `https://api.nasdaq.com/api/calendar/earnings?date=${day}`;
const TIMING = { 'time-pre-market': 'pre', 'time-after-hours': 'after' };

const migration = {
  version: MIGRATION_VERSION, name: 'earnings',
  up(raw) {
    raw.exec(`
      -- one row per calendar date asked for. fetched_day is the New York date of the fetch: rows fetched on or before their own date are
      -- forecasts (kind 'scheduled'), rows fetched after it are what happened (kind 'actual').
      CREATE TABLE earnings_fetch(
        day TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('ok','failed')),
        n INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        fetched_at INTEGER NOT NULL, fetched_day TEXT NOT NULL, note TEXT);
      CREATE TABLE earnings_event(
        symbol TEXT NOT NULL,                 -- the index lists' spelling (BRK.B)
        report_day TEXT NOT NULL,             -- YYYY-MM-DD, the calendar date it is listed under
        timing TEXT NOT NULL CHECK(timing IN ('pre','after','unknown')),
        kind TEXT NOT NULL CHECK(kind IN ('actual','scheduled')),
        eps REAL, eps_forecast REAL, surprise_pct REAL,
        fiscal_quarter TEXT, last_year_day TEXT,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY(symbol, report_day)) WITHOUT ROWID;
      CREATE INDEX earnings_event_day ON earnings_event(report_day);
    `);
  },
};

// ---- parsing (pure) -------------------------------------------------------------------------------------------------------------
// "$4.99" → 4.99, "($0.12)" or "-$0.12" → -0.12, "N/A" / "" → null
function money(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || /^n\/?a$/i.test(s)) return null;
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  const n = Number(s.replace(/[$,()\s-]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}
const pct = v => { const n = Number(String(v ?? '').replace(/[%,\s]/g, '')); return v === '' || v === null || v === undefined || !Number.isFinite(n) ? null : n; };
// "11/20/2025" → "2025-11-20"
function usDate(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v ?? '').trim());
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}
// parseCalendar(json) → { rows: [{ symbol, timing, eps, epsForecast, surprisePct, fiscalQuarter, lastYearDay }], skipped } | null (wrong shape)
function parseCalendar(json) {
  if (!json || typeof json !== 'object' || !('data' in json)) return null;
  const data = json.data;
  if (data === null) return { rows: [], skipped: 0 };   // seen as "no data" on quiet dates by other users of this API; treated as empty
  if (typeof data !== 'object') return null;
  if (data.rows === null || data.rows === undefined) return { rows: [], skipped: 0 };
  if (!Array.isArray(data.rows)) return null;
  const out = new Map(); let skipped = 0;
  for (const r of data.rows) {
    let symbol;
    try { symbol = normalizeSymbol(String(r?.symbol ?? '').replace('/', '.')); } catch { skipped++; continue; }
    out.set(symbol, {
      symbol, timing: TIMING[r.time] || 'unknown',
      eps: money(r.eps), epsForecast: money(r.epsForecast), surprisePct: pct(r.surprise),
      fiscalQuarter: r.fiscalQuarterEnding ? String(r.fiscalQuarterEnding).slice(0, 20) : null, lastYearDay: usDate(r.lastYearRptDt),
    });
  }
  return { rows: [...out.values()], skipped };
}

const isWeekday = d => { const w = dayOfWeek(d); return w !== 0 && w !== 6; };
function weekdays(from, to) { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) if (isWeekday(d)) out.push(d); return out; }

function createEarnings({ fetcher, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), opts = {} } = {}) {
  if (!fetcher || typeof fetcher.getText !== 'function') throw new TypeError('earnings needs a fetcher with getText(source, url, opts)');
  const o = { historyFrom: '2019-10-01', lookaheadDays: 28, refreshHours: 20, paceMs: 1000, perRun: 120, maxAttempts: 3, estimateDays: 91, estimateSlackDays: 7, confirmHorizonDays: 100, ...opts };
  let db = null, log = null, stopping = false, lastCallAt = null;

  async function fetchDay(day) {
    if (lastCallAt !== null) { const wait = lastCallAt + o.paceMs - now(); if (wait > 0) await sleep(wait); }
    lastCallAt = now();
    let r;
    try { r = await fetcher.getText('finance', URL_FOR(day), { ttlMs: 0 }); } catch (err) { throw err instanceof StockmanError ? err : mapHttpError(err, 'api.nasdaq.com'); }
    if (r.stale) throw new TransientError(`api.nasdaq.com: only an old cached copy is available for ${day}`);
    let json;
    try { json = JSON.parse(r.data); } catch { throw new ProviderDataError(`api.nasdaq.com: the earnings calendar for ${day} is not JSON`); }
    const parsed = parseCalendar(json);
    if (!parsed) throw new ProviderDataError(`api.nasdaq.com: the earnings calendar for ${day} is not in the expected shape`);
    return parsed;
  }

  function storeDay(day, parsed) {
    const t = now(), fetchedDay = nyDate(t), kind = fetchedDay > day ? 'actual' : 'scheduled';
    db.tx(() => {
      db.stmt('DELETE FROM earnings_event WHERE report_day = ?').run(day);   // this date's fetch is the truth for this date
      const ins = db.stmt('INSERT INTO earnings_event(symbol, report_day, timing, kind, eps, eps_forecast, surprise_pct, fiscal_quarter, last_year_day, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const r of parsed.rows) ins.run(r.symbol, day, r.timing, kind, r.eps, r.epsForecast, r.surprisePct, r.fiscalQuarter, r.lastYearDay, t);
      db.stmt(`INSERT INTO earnings_fetch(day, status, n, skipped, attempts, fetched_at, fetched_day, note) VALUES (?, 'ok', ?, ?, 1, ?, ?, NULL)
        ON CONFLICT(day) DO UPDATE SET status = 'ok', n = excluded.n, skipped = excluded.skipped, attempts = earnings_fetch.attempts + 1, fetched_at = excluded.fetched_at, fetched_day = excluded.fetched_day, note = NULL`)
        .run(day, parsed.rows.length, parsed.skipped, t, fetchedDay);
    });
  }
  function failDay(day, err) {
    const t = now();
    // a failure never removes rows a good fetch stored earlier, and never turns an earlier 'ok' into 'failed'
    db.stmt(`INSERT INTO earnings_fetch(day, status, n, attempts, fetched_at, fetched_day, note) VALUES (?, 'failed', 0, 1, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET attempts = earnings_fetch.attempts + 1, note = excluded.note,
        status = CASE WHEN earnings_fetch.status = 'ok' THEN 'ok' ELSE 'failed' END`).run(day, t, nyDate(t), `${err.code || 'ERROR'}: ${String(err.message).slice(0, 300)}`);
  }

  // which dates need a fetch now, most useful first: the coming weeks (dates move), then the past, newest first
  function pendingDays(today = nyDate(now())) {
    const rows = new Map(db.stmt('SELECT day, status, attempts, fetched_at AS at, fetched_day AS fday FROM earnings_fetch').all().map(r => [r.day, r]));
    const future = [], past = [];
    for (const d of weekdays(today, addDays(today, o.lookaheadDays))) {
      const r = rows.get(d);
      if (!r || r.status === 'failed' || now() - r.at >= o.refreshHours * 3600000) future.push(d);   // future dates are always worth another try
    }
    for (const d of weekdays(o.historyFrom, addDays(today, -1)).reverse()) {
      const r = rows.get(d);
      if (!r) past.push(d);
      else if (r.status === 'ok' && r.fday <= d) past.push(d);                     // fetched before it happened: get what happened
      else if (r.status === 'failed' && r.attempts < o.maxAttempts) past.push(d);
    }
    return [...future, ...past];
  }

  // step({ limit, today }) → summary. Bounded and resumable; each date is stored on its own.
  async function step({ limit = o.perRun, today, onProgress } = {}) {
    if (!db) throw new StockmanError('earnings: not started');
    const todo = pendingDays(today).slice(0, Math.max(0, limit));
    const res = { attempted: 0, ok: 0, failed: 0, rows: 0, failures: [], aborted: null, stopped: false, remaining: 0 };
    for (const day of todo) {
      if (stopping) { res.stopped = true; break; }
      res.attempted++;
      try {
        const parsed = await fetchDay(day);
        storeDay(day, parsed);
        res.ok++; res.rows += parsed.rows.length;
      } catch (err) {
        res.failed++;
        try { failDay(day, err); } catch { /* keep going */ }
        if (res.failures.length < 10) res.failures.push({ day, code: err.code || 'UNKNOWN', message: String(err.message).slice(0, 160) });
        if (err.code === 'POLICY') { res.aborted = 'policy: market-data lookups are off'; break; }
        if (res.failed >= 5 && res.ok === 0) { res.aborted = 'five failures in a row: the calendar host looks unhealthy'; break; }
      }
      try { onProgress?.({ done: res.attempted, of: todo.length, day }); } catch { /* informational */ }
    }
    res.remaining = pendingDays(today).length;
    if (res.failed) log?.warn(`earnings: ${res.failed} of ${res.attempted} calendar dates failed`, { first: res.failures[0] });
    return res;
  }

  // ---- reading ------------------------------------------------------------------------------------------------------------------
  // were all weekdays in [from, to] fetched successfully?
  function fetchedThrough(from, to) {
    const want = weekdays(from, to);
    if (!want.length) return true;
    const n = Number(db.stmt("SELECT COUNT(*) AS n FROM earnings_fetch WHERE status = 'ok' AND day >= ? AND day <= ?").get(from, to).n);
    return n >= want.length;
  }
  function flags({ symbol, entryDay, exitDay }) {
    parseDate(entryDay); parseDate(exitDay);
    const s = normalizeSymbol(symbol);
    const end = nextTradingDay(exitDay);   // an after-hours report on the exit day reacts on the next session (note 06)
    const hit = db.stmt('SELECT report_day AS day, timing, kind FROM earnings_event WHERE symbol = ? AND report_day >= ? AND report_day <= ? ORDER BY report_day LIMIT 1').get(s, entryDay, end);
    if (hit) return { earnings_in_window: true, earnings_possible: false, earnings_data: 'confirmed', report: { day: hit.day, timing: hit.timing, kind: hit.kind } };
    const covered = fetchedThrough(entryDay, end);
    const next = db.stmt('SELECT report_day AS day FROM earnings_event WHERE symbol = ? AND report_day > ? AND report_day <= ? ORDER BY report_day LIMIT 1').get(s, end, addDays(end, o.confirmHorizonDays));
    if (covered && next) return { earnings_in_window: false, earnings_possible: false, earnings_data: 'confirmed', next: next.day };
    const last = db.stmt('SELECT report_day AS day FROM earnings_event WHERE symbol = ? AND report_day < ? ORDER BY report_day DESC LIMIT 1').get(s, entryDay);
    if (!last) return { earnings_in_window: false, earnings_possible: false, earnings_data: 'unknown', reason: covered ? 'no report on record for this symbol' : 'calendar not fetched for the whole window' };
    const est = addDays(last.day, o.estimateDays);
    const possible = est >= addDays(entryDay, -o.estimateSlackDays) && est <= addDays(end, o.estimateSlackDays);
    return { earnings_in_window: false, earnings_possible: possible, earnings_data: 'estimated', lastReport: last.day, estimate: est, ...(covered ? {} : { reason: 'calendar not fetched for the whole window' }) };
  }
  function status(today = nyDate(now())) {
    const n = sql => Number(db.stmt(sql).get().n);
    const past = weekdays(o.historyFrom, addDays(today, -1)).length;
    const pastOk = Number(db.stmt("SELECT COUNT(*) AS n FROM earnings_fetch WHERE status = 'ok' AND day < ? AND day >= ? AND fetched_day > day").get(today, o.historyFrom).n);
    return {
      from: o.historyFrom, pastDays: past, pastDone: pastOk, pending: pendingDays(today).length,
      failed: n("SELECT COUNT(*) AS n FROM earnings_fetch WHERE status = 'failed'"),
      events: n('SELECT COUNT(*) AS n FROM earnings_event'), lastFetchAt: db.stmt('SELECT MAX(fetched_at) AS t FROM earnings_fetch').get().t ?? null,
    };
  }

  const api = { step, pendingDays, flags, status, fetchedThrough, parseCalendar, options: o };
  const feature = {
    id: 'earnings', migrations: [migration],
    async start(ctx) { db = ctx.db; log = ctx.log; stopping = false; },
    async stop() { stopping = true; },
  };
  return { feature, api };
}

module.exports = { createEarnings, parseCalendar, money, usDate, MIGRATION_VERSION };
