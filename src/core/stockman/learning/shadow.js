// Feature "shadow" (vault Phase 3, G14, note 07 stages S3 to S4 and S8 for candidates): every trading day, score EVERY symbol of the
// point-in-time universe with the scoring build and log it as a candidate, taken or not; when the 5-session horizon has passed, fill
// the forward outcome. This removes the selection bias and the data starvation of learning only from trades taken.
//   run_id → candidate_id → outcome: candidate_id = "<run_id>/<symbol>/<scoring build>", so re-scoring with a NEW build adds rows and
//   never overwrites old ones, and re-running the same build is a no-op (idempotent).
//   Ineligible candidates are logged too, with their reasons; earnings-flagged ones carry the flag (D19) and get their own calibration buckets.
//   Outcome (note 06): entry = open of the next session, exit = close of the 5th session held, both on the provider's adjusted basis
//   (the entry open is adjusted with that day's close factor, so dividends are in the return), excess = stock return minus the benchmark's
//   return (SPY adjusted prices, assumption D22) over the same open-to-close dates. GROSS of costs: the cost model is applied downstream
//   (calibration takes a cost in basis points; the ledger session owns the real cost model).
//   Gaps (G24): a symbol with no bar, or an outcome with no entry or exit bar, is RECORDED with a reason. Nothing is ever filled,
//   interpolated or copied from another day. An outcome that cannot be filled is retried each step (a late bar can still arrive).
//   Catch-up (G17): each step logs every trading day from the first logged day (or today's target on a first start) to the newest finished
//   session that has no row yet, oldest first and bounded, so a closed app costs nothing but time. A day is logged only after its data run
//   is `ingested`. A day logged after its entry session is marked `late` (earnings dates and index lists may then carry hindsight).
//   Holdout guard: days on or before HOLDOUT_END (2026-11-13, note 06) are refused. Those windows belong to the backtest's frozen holdout
//   and are touched once, by the backtest harness; live shadow logging starts after it, so calibration never sees holdout days.
const { nyDate } = require('../features/ny-time');
const { tradingDays, nextTradingDay, lastCompletedSession, isTradingDay } = require('../features/calendar-rules');
const { StockmanError } = require('../errors');

const MIGRATION_VERSION = 10;
const HOLDOUT_END = '2026-11-13';   // note 06: the backtest and its frozen holdout end here
const migration = {
  version: MIGRATION_VERSION, name: 'shadow-candidates',
  up(raw) {
    raw.exec(`
      -- one row per (trading day, scoring build): the day was scored and logged. The counts are what a reader checks first.
      CREATE TABLE shadow_day(
        day TEXT NOT NULL, scoring_build TEXT NOT NULL, run_id TEXT NOT NULL,
        n_members INTEGER NOT NULL, n_scored INTEGER NOT NULL, n_eligible INTEGER NOT NULL, n_earnings_flagged INTEGER NOT NULL,
        n_no_bar INTEGER NOT NULL, n_not_found INTEGER NOT NULL,
        universe TEXT NOT NULL,                 -- JSON: per index, the snapshot date the membership came from (null when none)
        late INTEGER NOT NULL DEFAULT 0,        -- 1 when logged after the entry session
        logged_at INTEGER NOT NULL,
        PRIMARY KEY(day, scoring_build)) WITHOUT ROWID;
      -- every scored symbol, taken or not. features and variants are JSON; earnings is the earnings feature's flags() for this trade window.
      CREATE TABLE candidate(
        candidate_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL, day TEXT NOT NULL, symbol TEXT NOT NULL, scoring_build TEXT NOT NULL,
        indexes TEXT NOT NULL,                  -- point-in-time lists the symbol was in: sp500, ndx100 or both
        eligible INTEGER NOT NULL, reasons TEXT NOT NULL,
        score REAL, rank INTEGER, in_basket INTEGER NOT NULL DEFAULT 0,
        features TEXT, variants TEXT, earnings TEXT,
        entry_day TEXT NOT NULL, exit_day TEXT NOT NULL, logged_at INTEGER NOT NULL,
        UNIQUE(run_id, symbol, scoring_build));
      CREATE INDEX candidate_day ON candidate(scoring_build, day);
      CREATE INDEX candidate_exit ON candidate(scoring_build, exit_day);
      -- the forward result. Absent = not due yet. status 'ok' (filled) or 'gap' (a bar was missing; never filled, retried each step).
      CREATE TABLE candidate_outcome(
        candidate_id TEXT PRIMARY KEY REFERENCES candidate(candidate_id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('ok','gap')), reason TEXT,
        entry_day TEXT NOT NULL, exit_day TEXT NOT NULL,
        entry_open REAL, entry_factor REAL, exit_adj REAL,     -- the stock's raw entry open, its adj/close factor that day, its adjusted exit close
        ret REAL, bench_ret REAL, excess REAL,                 -- gross of costs; excess = ret - bench_ret
        attempts INTEGER NOT NULL DEFAULT 1, resolved_at INTEGER NOT NULL);
      CREATE INDEX candidate_outcome_status ON candidate_outcome(status);
    `);
  },
};

const candidateId = (runId, symbol, build) => `${runId}/${symbol}/${build}`;
const json = v => (v === undefined || v === null ? null : JSON.stringify(v));

// deps: { scoring (api), universe: { membersAsOf }, runs: { getRun, runId }, bars: { lastBarDay }, earnings: { flags } | null, now, opts }
function createShadow({ scoring, universe, runs, bars, earnings = null, now = Date.now, opts = {} } = {}) {
  for (const [n, x] of Object.entries({ scoring, universe, runs, bars })) if (!x) throw new TypeError(`shadow needs the ${n} api`);
  const o = { benchmark: 'SPY', gapGraceSessions: 3, maxDaysPerStep: 30, resolvePerStep: 5000, gapRetryPerStep: 300, bufferMin: 30, startDay: null, tickMs: 5 * 60000, startDelayMs: 4000, healthCacheMs: 30000, autoRun: true, ...opts };
  let db = null, log = null, stopping = false, busy = false, tick = null, startTimer = null, healthCache = null;

  const done = day => Boolean(db.stmt('SELECT 1 AS x FROM shadow_day WHERE day = ? AND scoring_build = ?').get(day, scoring.build));

  // ---- logging ----------------------------------------------------------------------------------------------------------------------
  // logDay(day) → { day, status: 'logged' | 'already' | 'waiting', ... }. Throws for a holdout day or a day that is not a session.
  function logDay(day) {
    if (!db) throw new StockmanError('shadow: not started');
    if (day <= HOLDOUT_END) throw new StockmanError(`shadow: ${day} is inside the backtest holdout (up to ${HOLDOUT_END}); shadow logging starts after it`);
    if (!isTradingDay(day)) throw new TypeError(`shadow: ${day} is not a trading session`);
    if (done(day)) return { day, status: 'already' };
    const run = runs.getRun(day);
    if (!run) return { day, status: 'waiting', reason: 'no data run for this day yet' };
    if (run.state !== 'ingested') return { day, status: 'waiting', reason: `data run is ${run.state}, not ingested` };
    const pit = universe.membersAsOf(day);
    const indexesOf = new Map();
    const lists = {};
    for (const [index, snap] of Object.entries(pit)) {
      lists[index] = snap ? snap.snapshotAsOf : null;
      for (const s of snap ? snap.symbols : []) indexesOf.set(s, [...(indexesOf.get(s) || []), index]);
    }
    if (!indexesOf.size) return { day, status: 'waiting', reason: 'no point-in-time universe snapshot on or before this day' };
    const symbols = [...indexesOf.keys()];
    const flagsOf = earnings ? (symbol, entryDay, exitDay) => earnings.flags({ symbol, entryDay, exitDay }) : null;
    const res = scoring.scoreDay({ day, symbols, flagsOf });
    const t = now();
    const late = nyDate(t) > res.entryDay ? 1 : 0;
    const runId = run.run_id;
    const counts = { members: res.rows.length, scored: 0, eligible: 0, flagged: 0, noBar: 0, notFound: 0 };
    db.tx(() => {
      const ins = db.stmt(`INSERT OR IGNORE INTO candidate(candidate_id, run_id, day, symbol, scoring_build, indexes, eligible, reasons, score, rank, in_basket, features, variants, earnings, entry_day, exit_day, logged_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const r of res.rows) {
        if (r.score !== null) counts.scored++;
        if (r.eligible) counts.eligible++;
        if (r.reasons.includes('earnings_in_window') || r.reasons.includes('earnings_possible')) counts.flagged++;
        if (r.reasons.includes('no_bar_on_day')) counts.noBar++;
        if (r.reasons.includes('provider_has_no_bars')) counts.notFound++;
        ins.run(candidateId(runId, r.symbol, res.build), runId, day, r.symbol, res.build, indexesOf.get(r.symbol).join(','), r.eligible ? 1 : 0, JSON.stringify(r.reasons),
          r.score, r.rank, r.inBasket ? 1 : 0, json(r.features), json(r.variants), json(r.earnings), res.entryDay, res.exitDay, t);
      }
      db.stmt('INSERT OR REPLACE INTO shadow_day(day, scoring_build, run_id, n_members, n_scored, n_eligible, n_earnings_flagged, n_no_bar, n_not_found, universe, late, logged_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(day, res.build, runId, counts.members, counts.scored, counts.eligible, counts.flagged, counts.noBar, counts.notFound, JSON.stringify(lists), late, t);
    });
    healthCache = null;
    return { day, status: 'logged', runId, late: Boolean(late), ...counts };
  }

  // the days a step would log: from the first logged day (or the start day / the newest finished session on a first start) to the newest finished session
  function pendingDays() {
    const target = lastCompletedSession(now(), o.bufferMin);
    const first = db.stmt('SELECT MIN(day) AS d FROM shadow_day WHERE scoring_build = ?').get(scoring.build).d;
    let start = first || o.startDay || target;
    const floor = nextTradingDay(HOLDOUT_END);
    if (start < floor) start = floor;
    if (start > target) return { target, days: [] };
    const have = new Set(db.stmt('SELECT day FROM shadow_day WHERE scoring_build = ? AND day >= ?').all(scoring.build, start).map(r => r.day));
    return { target, days: tradingDays(start, target).filter(d => !have.has(d)) };
  }

  // ---- outcomes ---------------------------------------------------------------------------------------------------------------------
  const barOn = (symbol, day) => db.stmt('SELECT open, close, adj_close AS adj FROM bar WHERE symbol = ? AND day = ?').get(symbol, day) || null;
  const usable = b => b && [b.open, b.close, b.adj].every(x => typeof x === 'number' && Number.isFinite(x) && x > 0);
  // total return open-to-close on the adjusted basis; null with a reason when a bar is missing
  function legReturn(symbol, entryDay, exitDay) {
    const e = barOn(symbol, entryDay), x = barOn(symbol, exitDay);
    if (!e) return { reason: 'no_entry_bar' };
    if (!x) return { reason: 'no_exit_bar' };
    if (!usable(e) || !usable(x)) return { reason: 'unusable_bar' };
    const factor = e.adj / e.close;
    return { entryOpen: e.open, factor, exitAdj: x.adj, ret: x.adj / (e.open * factor) - 1 };
  }
  const sessionsAfter = (day, n) => { let d = day; for (let i = 0; i < n; i++) d = nextTradingDay(d); return d; };

  function writeOutcome(id, f, attempts) {
    db.stmt(`INSERT INTO candidate_outcome(candidate_id, status, reason, entry_day, exit_day, entry_open, entry_factor, exit_adj, ret, bench_ret, excess, attempts, resolved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(candidate_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, entry_open = excluded.entry_open, entry_factor = excluded.entry_factor, exit_adj = excluded.exit_adj,
        ret = excluded.ret, bench_ret = excluded.bench_ret, excess = excluded.excess, attempts = candidate_outcome.attempts + 1, resolved_at = excluded.resolved_at
      WHERE candidate_outcome.status != 'ok'`)
      .run(id, f.status, f.reason ?? null, f.entryDay, f.exitDay, f.entryOpen ?? null, f.factor ?? null, f.exitAdj ?? null, f.ret ?? null, f.benchRet ?? null, f.excess ?? null, attempts, now());
  }

  // fill every outcome that is due. `latest` = the newest session with stored bars; a candidate is due when its exit session is on or before it.
  function resolveOutcomes() {
    const latest = bars.lastBarDay();
    const res = { latest, due: 0, filled: 0, gaps: 0, waiting: 0, retried: 0 };
    if (!latest) return res;
    const fresh = db.stmt(`SELECT c.candidate_id AS id, c.symbol, c.entry_day AS entryDay, c.exit_day AS exitDay FROM candidate c
      LEFT JOIN candidate_outcome o ON o.candidate_id = c.candidate_id
      WHERE c.scoring_build = ? AND c.score IS NOT NULL AND c.exit_day <= ? AND o.candidate_id IS NULL ORDER BY c.exit_day, c.symbol LIMIT ?`).all(scoring.build, latest, o.resolvePerStep);
    const retry = db.stmt(`SELECT c.candidate_id AS id, c.symbol, c.entry_day AS entryDay, c.exit_day AS exitDay FROM candidate c
      JOIN candidate_outcome o ON o.candidate_id = c.candidate_id
      WHERE c.scoring_build = ? AND o.status = 'gap' ORDER BY o.resolved_at LIMIT ?`).all(scoring.build, o.gapRetryPerStep);
    const benchCache = new Map();
    const bench = (entryDay, exitDay) => { const k = `${entryDay}|${exitDay}`; if (!benchCache.has(k)) benchCache.set(k, legReturn(o.benchmark, entryDay, exitDay)); return benchCache.get(k); };
    const attempt = (c, isRetry) => {
      if (stopping) return;
      res.due++;
      const s = legReturn(c.symbol, c.entryDay, c.exitDay), b = bench(c.entryDay, c.exitDay);
      const reason = s.reason ? s.reason : b.reason ? `benchmark_${b.reason}` : null;
      if (reason) {
        // a missing bar may still arrive: record the gap only once the grace sessions after the exit day have passed
        if (latest < sessionsAfter(c.exitDay, o.gapGraceSessions)) { res.waiting++; return; }
        const prev = db.stmt('SELECT attempts FROM candidate_outcome WHERE candidate_id = ?').get(c.id);
        writeOutcome(c.id, { status: 'gap', reason, entryDay: c.entryDay, exitDay: c.exitDay }, prev ? prev.attempts + 1 : 1);
        if (!isRetry) res.gaps++;
        return;
      }
      writeOutcome(c.id, { status: 'ok', entryDay: c.entryDay, exitDay: c.exitDay, entryOpen: s.entryOpen, factor: s.factor, exitAdj: s.exitAdj, ret: s.ret, benchRet: b.ret, excess: s.ret - b.ret }, 1);
      if (isRetry) res.retried++; else res.filled++;
    };
    db.tx(() => { for (const c of fresh) attempt(c, false); for (const c of retry) attempt(c, true); });
    healthCache = null;
    return res;
  }

  // one step: log the missing days (oldest first, bounded), then fill the outcomes that are due. Never overlaps itself.
  async function step() {
    if (!db) throw new StockmanError('shadow: not started');
    if (busy) return { status: 'busy' };
    busy = true;
    try {
      const { target, days } = pendingDays();
      const out = { status: 'ok', target, logged: [], waiting: [], errors: [], remainingDays: 0 };
      for (const day of days.slice(0, o.maxDaysPerStep)) {
        if (stopping) break;
        try {
          const r = logDay(day);
          if (r.status === 'logged') out.logged.push({ day, candidates: r.members, eligible: r.eligible, late: r.late });
          else if (r.status === 'waiting') out.waiting.push({ day, reason: r.reason });
        } catch (err) { out.errors.push({ day, message: String(err.message).slice(0, 200) }); log?.warn(`shadow: could not log ${day}`, { message: err.message }); }
      }
      out.remainingDays = Math.max(0, days.length - out.logged.length);
      out.outcomes = resolveOutcomes();
      return out;
    } finally { busy = false; }
  }

  // ---- reading ----------------------------------------------------------------------------------------------------------------------
  function status() {
    const n = (sql, ...a) => Number(db.stmt(sql).get(...a).n);
    const b = scoring.build, latest = bars.lastBarDay();
    const last = db.stmt('SELECT day, n_members AS members, n_eligible AS eligible, n_no_bar AS noBar, n_not_found AS notFound, n_earnings_flagged AS flagged, late FROM shadow_day WHERE scoring_build = ? ORDER BY day DESC LIMIT 1').get(b) || null;
    const due = latest ? n("SELECT COUNT(*) AS n FROM candidate c LEFT JOIN candidate_outcome o ON o.candidate_id = c.candidate_id WHERE c.scoring_build = ? AND c.score IS NOT NULL AND c.exit_day <= ? AND (o.candidate_id IS NULL OR o.status = 'gap')", b, latest) : 0;
    return {
      build: b, days: n('SELECT COUNT(*) AS n FROM shadow_day WHERE scoring_build = ?', b), lastDay: last?.day ?? null, last,
      candidates: n('SELECT COUNT(*) AS n FROM candidate WHERE scoring_build = ?', b),
      outcomesOk: n("SELECT COUNT(*) AS n FROM candidate_outcome o JOIN candidate c ON c.candidate_id = o.candidate_id WHERE c.scoring_build = ? AND o.status = 'ok'", b),
      outcomesGap: n("SELECT COUNT(*) AS n FROM candidate_outcome o JOIN candidate c ON c.candidate_id = o.candidate_id WHERE c.scoring_build = ? AND o.status = 'gap'", b),
      outcomesDue: due, pendingDays: pendingDays().days.length, holdoutEnd: HOLDOUT_END,
    };
  }
  function health() {
    if (!db) return { summary: '' };
    const t = now();
    if (healthCache && t - healthCache.at < o.healthCacheMs) return healthCache.value;
    let value;
    try {
      const s = status();
      const bits = [`shadow candidates (build ${s.build}): ${s.days} day${s.days === 1 ? '' : 's'} logged${s.lastDay ? `, newest ${s.lastDay}` : ''}, ${s.candidates} candidates`];
      if (s.last) bits.push(`${s.last.eligible} of ${s.last.members} eligible that day${s.last.noBar ? `, ${s.last.noBar} with no bar` : ''}`);
      bits.push(`${s.outcomesOk} outcomes filled${s.outcomesGap ? `, ${s.outcomesGap} gaps (never filled)` : ''}${s.outcomesDue ? `, ${s.outcomesDue} due` : ''}`);
      if (s.pendingDays) bits.push(`${s.pendingDays} day${s.pendingDays === 1 ? '' : 's'} to catch up`);
      value = { summary: `${bits.join('; ')}. Paper analysis only, not a prediction.`, ...s, last: undefined };
    } catch (err) { value = { summary: '', error: String(err.message).slice(0, 200) }; }
    healthCache = { at: t, value };
    return value;
  }

  const api = { logDay, resolveOutcomes, step, pendingDays, status, health, candidateId, HOLDOUT_END, options: o };
  const feature = {
    id: 'shadow', migrations: [migration],
    async start(ctx) {
      db = ctx.db; log = ctx.log; stopping = false; healthCache = null;
      if (o.autoRun) {
        startTimer = setTimeout(() => { startTimer = null; step().catch(err => log?.warn('shadow step failed', { message: err.message })); }, o.startDelayMs); startTimer.unref?.();
        tick = setInterval(() => { if (!busy && !stopping) step().catch(err => log?.warn('shadow step failed', { message: err.message })); }, o.tickMs); tick.unref?.();
      }
    },
    async stop() { stopping = true; clearTimeout(startTimer); clearInterval(tick); startTimer = tick = null; },
    health,
  };
  return { feature, api };
}

module.exports = { createShadow, MIGRATION_VERSION, HOLDOUT_END, candidateId };
