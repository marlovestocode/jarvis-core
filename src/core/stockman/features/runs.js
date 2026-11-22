// Feature "runs" (vault note 07 run state machine, data stages only; G17 catch-up on start; the data_quality summary).
//   One run per trading day: run_id "run-YYYY-MM-DD", state created → universe_ok → ingested (only forward, never back).
//   Stages talk through the database only: S1 "universe" (refresh the lists), S2 "ingest" (sweep bars, check coverage). Each stage row
//   records attempts, times, error and detail, so a crash or a stop resumes at the first stage that is not ok, and a finished run is a no-op.
//   Features, scoring, selection and everything after ingest belong to later phases and are NOT here.
// Trigger (S0): on start (catch-up) and then every `tickMs` (default 15 min). A cycle finds the newest finished session (calendar-rules),
// creates a run for every trading day since the last run or stored bar, and covers all of them with one sweep over a range chosen for the
// size of the gap. Nothing is fetched when nothing is missing. It never fetches during a session for the session in progress.
// A day is ingested when at least `minCoverage` (default 90%) of the universe has its bar. After `maxAttempts` (default 3) tries a day
// below that is accepted as partial, recorded in catchup_gap as low_coverage, and shown in data_quality. A day on which no symbol returned
// a bar, after a sweep with no failures, is accepted and recorded as no_bars_any_symbol (an unscheduled closure, a wrong calendar rule, or
// the provider's range limit): flagged, never filled.
// Coverage for an older day is measured against TODAY's universe size (point-in-time sizes are not applied): approximate.
// data_quality: health() returns a small cached object; app.health().dataQuality.runs carries it and the jarvis status tool prints its
// `summary`. Quote delay is unmeasured, so the summary says daily bars of finished sessions, not real time.
const { addDays, nyDate } = require('./ny-time');
const { tradingDays, lastCompletedSession, marketOpenNow, sessionCloseMs } = require('./calendar-rules');
const { pickRange } = require('./bars');
const { StockmanError } = require('../errors');

const MIGRATION_VERSION = 5;
const ORDER = ['created', 'universe_ok', 'ingested'];
const MAX_SESSIONS = 1240;   // the provider's widest offered range we use (5y)
const migration = {
  version: MIGRATION_VERSION, name: 'runs',
  up(raw) {
    raw.exec(`
      -- one row per trading day the data layer has to cover. run_id is the first link of the ID spine in vault note 07.
      CREATE TABLE run(
        run_id TEXT PRIMARY KEY,
        trade_day TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('created','universe_ok','ingested')),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_error TEXT);
      CREATE INDEX run_state ON run(state, trade_day);
      -- what happened at each stage of each run; this is what makes a run resumable and idempotent
      CREATE TABLE run_stage(
        run_id TEXT NOT NULL REFERENCES run(run_id) ON DELETE CASCADE,
        stage TEXT NOT NULL CHECK(stage IN ('universe','ingest')),
        status TEXT NOT NULL CHECK(status IN ('running','ok','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER, finished_at INTEGER, error TEXT, detail TEXT,
        PRIMARY KEY(run_id, stage)) WITHOUT ROWID;
    `);
  },
};

const runId = day => `run-${day}`;
const rank = s => ORDER.indexOf(s);
const ago = ms => (ms < 90 * 60000 ? `${Math.max(1, Math.round(ms / 60000))} min` : ms < 48 * 3600000 ? `${Math.round(ms / 3600000)} h` : `${Math.round(ms / 86400000)} days`);

// History (backtest data, after the daily data and never in its way): a bounded step per cycle, and on ticks when no daily work is due,
// until done: (1) point-in-time universe snapshots, (2) deep bars back to historyFrom for every symbol ever in a list plus the benchmarks,
// (3) the earnings calendar (earnings api optional). Benchmarks (SPY) are also swept daily, outside the coverage figures.
function createRuns({ universe, bars, calendar, earnings = null, halt = async () => {}, now = Date.now, opts = {} } = {}) {
  for (const [n, x] of Object.entries({ universe, bars, calendar })) if (!x) throw new TypeError(`runs needs the ${n} api`);
  const o = { minCoverage: 0.9, maxAttempts: 3, tickMs: 15 * 60000, startDelayMs: 3000, qualityEveryMs: 60000, bufferMin: 30, calendarYears: 3, backfill: true, history: true, historyFrom: '2019-10-01', benchmarks: [], autoRun: true, ...opts };
  let db = null, log = null, events = null, stopping = false, current = null, tick = null, startTimer = null, qualityTimer = null;
  let cached = null, lastCycle = null;

  const json = v => (v === undefined ? null : JSON.stringify(v));
  const getRun = day => db.stmt('SELECT * FROM run WHERE trade_day = ?').get(day) || null;
  function ensureRun(day) {
    return Number(db.stmt('INSERT OR IGNORE INTO run(run_id, trade_day, state, created_at, updated_at) VALUES (?,?,?,?,?)').run(runId(day), day, 'created', now(), now()).changes) === 1;
  }
  function advance(day, to) {
    const r = getRun(day);
    if (r && rank(to) > rank(r.state)) db.stmt('UPDATE run SET state = ?, updated_at = ? WHERE run_id = ?').run(to, now(), r.run_id);
  }
  function beginStage(day, stage) {
    db.stmt(`INSERT INTO run_stage(run_id, stage, status, attempts, started_at) VALUES (?,?,'running',1,?)
      ON CONFLICT(run_id, stage) DO UPDATE SET status = 'running', attempts = attempts + 1, started_at = excluded.started_at, finished_at = NULL, error = NULL`).run(runId(day), stage, now());
  }
  function endStage(day, stage, status, { error = null, detail } = {}) {
    db.stmt('UPDATE run_stage SET status = ?, finished_at = ?, error = ?, detail = ? WHERE run_id = ? AND stage = ?').run(status, now(), error ? String(error).slice(0, 400) : null, json(detail), runId(day), stage);
    db.stmt('UPDATE run SET last_error = ?, updated_at = ? WHERE run_id = ?').run(status === 'failed' ? String(error).slice(0, 400) : null, now(), runId(day));
  }
  const attempts = (day, stage) => db.stmt('SELECT attempts FROM run_stage WHERE run_id = ? AND stage = ?').get(runId(day), stage)?.attempts || 0;

  // ---- one cycle: S0 catch-up, S1 universe, S2 ingest ------------------------------------------------------------------------------
  async function cycleBody(reason) {
    const nowMs = now(), today = nyDate(nowMs), target = lastCompletedSession(nowMs, o.bufferMin);
    const res = { reason, at: nowMs, target, newRuns: 0, work: 0, missedSessions: 0, status: 'idle' };
    calendar.materialize(addDays(today, -365 * o.calendarYears), addDays(today, 400));

    // S0: which days need a run
    const lastRun = db.stmt('SELECT MAX(trade_day) AS d FROM run').get().d;
    const anchor = [lastRun, bars.lastBarDay()].filter(Boolean).sort().at(-1) || null;
    let newDays = anchor === null ? [target] : anchor >= target ? [] : tradingDays(addDays(anchor, 1), target);
    if (newDays.length > MAX_SESSIONS) {
      const dropped = newDays.length - MAX_SESSIONS;
      calendar.recordUnfillable(newDays[0], 'beyond_provider_range', `${dropped} sessions from ${newDays[0]} are older than the widest range requested (5y)`);
      newDays = newDays.slice(dropped);
    }
    db.tx(() => { for (const d of newDays) if (ensureRun(d)) res.newRuns++; });
    const unfinished = db.stmt("SELECT trade_day AS d FROM run WHERE state != 'ingested' AND trade_day <= ? ORDER BY trade_day").all(target).map(r => r.d);
    const work = [...new Set([...unfinished, ...newDays])].sort();
    res.work = work.length;
    if (anchor !== null && newDays.length > 1) res.missedSessions = newDays.length;
    if (!work.length) { res.status = 'up_to_date'; return res; }
    if (work.length > 1) log.info(`catch-up: ${work.length} sessions to cover, ${work[0]} to ${target}`, { reason });
    if (stopping) { res.status = 'stopped'; return res; }

    // S1: universe
    db.tx(() => { for (const d of work) beginStage(d, 'universe'); });
    let u;
    try { u = await universe.refresh(); } catch (err) { u = { status: 'none', problems: [err.message] }; }
    if (u.status === 'none' || u.status === 'incomplete') {
      const why = `universe ${u.status}: ${(u.problems || []).join('; ') || 'no list available'}`;
      db.tx(() => { for (const d of work) endStage(d, 'universe', 'failed', { error: why }); });
      log.warn('run stopped at the universe stage', { why });
      return { ...res, status: 'failed_universe', error: why };
    }
    db.tx(() => { for (const d of work) { endStage(d, 'universe', 'ok', { detail: { status: u.status, n: u.n, ageMs: u.ageMs, sources: u.sources, problems: u.problems } }); advance(d, 'universe_ok'); } });
    if (stopping) return { ...res, status: 'stopped' };

    // S2: ingest
    const symbols = universe.symbols().map(s => s.symbol);
    const empty = bars.lastBarDay() === null;
    const missing = empty ? 0 : tradingDays(work[0], target).length;
    const range = empty ? bars.options.initialRange : pickRange(missing);
    db.tx(() => { for (const d of work) beginStage(d, 'ingest'); });
    // the benchmarks ride along in the same sweep; a benchmark failure is logged but never counts against the universe's coverage
    const benchmarks = o.benchmarks.filter(b => !symbols.includes(b));
    const sweep = await bars.sweep({ symbols: [...symbols, ...benchmarks], target, range });
    const benchFailed = sweep.failures.filter(f => benchmarks.includes(f.symbol)).length;
    if (benchFailed) log.warn(`benchmark sweep failed for ${sweep.failures.filter(f => benchmarks.includes(f.symbol)).map(f => f.symbol).join(', ')}`);
    sweep.failed -= benchFailed;
    const cov = bars.coverageNow({ symbols, target });
    bars.recordCoverage(cov, { failed: sweep.failed, ms: sweep.ms, note: sweep.aborted || (sweep.stopped ? 'stopped' : null) });

    // does the calendar agree with what arrived? every date in the window, closed days included; universe symbols only
    const window = []; for (let d = work[0]; d <= target; d = addDays(d, 1)) window.push(d);
    const counts = bars.symbolsWithBarOn(window, symbols);
    const suspects = calendar.crossCheck({ counts, universeN: symbols.length });
    for (const s of suspects.slice(0, 10)) log.warn(`calendar check: ${s.day} ${s.verdict} (calendar says ${s.calendar}${s.reason ? `, ${s.reason}` : ''}; ${s.observed} of ${s.universe} symbols have a bar)`);

    const clean = !sweep.aborted && !sweep.stopped && sweep.failed === 0;
    const need = Math.ceil(o.minCoverage * symbols.length);
    let ingested = 0, partial = 0, failed = 0;
    db.tx(() => {
      for (const d of work) {
        const n = counts[d] ?? 0, detail = { symbolsWithBar: n, universe: symbols.length, range, failedSymbols: sweep.failed };
        if (n >= need && symbols.length) { endStage(d, 'ingest', 'ok', { detail }); advance(d, 'ingested'); calendar.resolveUnfillable(d); ingested++; }
        else if (n === 0 && clean) {
          endStage(d, 'ingest', 'ok', { detail: { ...detail, noBars: true } }); advance(d, 'ingested'); partial++;
          calendar.recordUnfillable(d, 'no_bars_any_symbol', `no symbol returned a bar; the calendar says ${calendar.day(d)?.kind || 'open'}: unscheduled closure, wrong rule or range limit`);
        } else if (!sweep.aborted && !sweep.stopped && attempts(d, 'ingest') >= o.maxAttempts) {
          endStage(d, 'ingest', 'ok', { detail: { ...detail, partial: true } }); advance(d, 'ingested'); partial++;
          calendar.recordUnfillable(d, 'low_coverage', `${n} of ${symbols.length} symbols have a bar after ${attempts(d, 'ingest')} attempts`);
        } else {
          endStage(d, 'ingest', 'failed', { error: sweep.aborted ? `sweep stopped: ${sweep.aborted}` : sweep.stopped ? 'stopped before it finished' : `coverage ${n} of ${symbols.length} is under ${Math.round(o.minCoverage * 100)}%`, detail });
          failed++;
        }
      }
    });
    Object.assign(res, { status: failed ? 'incomplete' : 'ok', universe: u.status, range, sweep: { attempted: sweep.attempted, skippedFresh: sweep.skippedFresh, symbolsStored: sweep.symbolsStored, barsWritten: sweep.barsWritten, partialDropped: sweep.partialDropped, gaps: sweep.gaps, failed: sweep.failed, aborted: sweep.aborted, stopped: sweep.stopped, ms: sweep.ms }, ingested, partial, failed, suspects: suspects.length, coverage: cov });

    // history is slow and low priority: a bounded step, only after the daily data is in
    if (!stopping && !sweep.aborted) Object.assign(res, await historyBody());
    return res;
  }

  // ---- history (backtest data) ------------------------------------------------------------------------------------------------------
  const historySymbols = () => [...new Set([...o.benchmarks, ...universe.allSymbols()])];
  function historyPending() {
    const p = { universe: 0, bars: 0, earnings: 0 };
    if (o.backfill) p.universe = universe.backfillStatus().pending;
    if (o.history) {
      p.bars = bars.deepPending({ symbols: historySymbols(), from: o.historyFrom }).length;
      if (earnings) p.earnings = earnings.pendingDays().length;
    }
    return p;
  }
  // one bounded step of each kind; each is caught on its own so one failing source does not stop the others
  async function historyBody() {
    const out = {};
    const target = lastCompletedSession(now(), o.bufferMin);
    if (o.backfill && !stopping) { try { out.backfill = await universe.backfill(); } catch (err) { log.warn('universe backfill failed', { message: err.message }); } }
    if (o.history && !stopping && bars.lastBarDay() !== null) {
      // only once the daily data exists: the deep fetch must not race the first sweep for the same symbols
      try { out.deepen = await bars.deepen({ symbols: historySymbols(), from: o.historyFrom, target }); } catch (err) { log.warn('deep history step failed', { message: err.message }); }
    }
    if (o.history && earnings && !stopping) { try { out.earnings = await earnings.step(); } catch (err) { log.warn('earnings calendar step failed', { message: err.message }); } }
    return out;
  }

  async function exclusive(reason, body) {
    if (!db) throw new StockmanError('runs: not started');
    if (current) return { reason, status: 'busy' };
    current = (async () => {
      let res;
      try { res = await body(); } catch (err) {
        log.error(`${reason === 'history' ? 'history step' : 'data cycle'} failed`, { message: err.message, code: err.code });
        res = { reason, status: 'error', error: String(err.message).slice(0, 300) };
      }
      if (reason !== 'history') lastCycle = { at: now(), ...res };
      try { events?.append({ level: ['ok', 'up_to_date', 'idle'].includes(res.status) ? 'info' : 'warn', source: 'runs', message: `${reason === 'history' ? 'history step' : 'data cycle'} ${res.status}`, data: { ...res, coverage: undefined } }); } catch { /* log only */ }
      try { refreshQuality(); } catch (err) { log.warn('could not refresh data_quality', { message: err.message }); }
      return res;
    })();
    try { return await current; } finally { current = null; }
  }
  const runCycle = ({ reason = 'manual' } = {}) => exclusive(reason, () => cycleBody(reason));
  // one bounded history step on its own (ticks with no daily work, and the CLI). Status ok when it did something, idle when nothing was due.
  const runHistory = () => exclusive('history', async () => {
    const out = await historyBody();
    const did = Object.values(out).some(r => r && r.attempted > 0);
    return { reason: 'history', status: did ? 'ok' : 'idle', ...out, pending: historyPending() };
  });
  const needsHistory = () => Object.values(historyPending()).some(n => n > 0);

  // is there something a cycle would do? (cheap: no network)
  function needsCycle() {
    const target = lastCompletedSession(now(), o.bufferMin);
    const lastRun = db.stmt('SELECT MAX(trade_day) AS d FROM run').get().d;
    if (!lastRun || lastRun < target) return true;
    return Number(db.stmt("SELECT COUNT(*) AS n FROM run WHERE state != 'ingested' AND trade_day <= ?").get(target).n) > 0;
  }

  // ---- data_quality ---------------------------------------------------------------------------------------------------------------
  function refreshQuality() {
    const nowMs = now(), target = lastCompletedSession(nowMs, o.bufferMin);
    const symbols = universe.symbols().map(s => s.symbol), uni = universe.describe();
    const cov = bars.coverageNow({ symbols, target });
    const last = db.stmt('SELECT run_id, trade_day, state, last_error FROM run ORDER BY trade_day DESC LIMIT 1').get() || null;
    const open = db.stmt("SELECT run_id, trade_day, state, last_error FROM run WHERE state != 'ingested' AND trade_day <= ? ORDER BY trade_day LIMIT 1").get(target) || null;
    const stageErr = db.stmt("SELECT run_id, stage, error FROM run_stage WHERE status = 'failed' ORDER BY finished_at DESC LIMIT 1").get() || null;
    cached = {
      computedAt: nowMs, target, universe: { n: uni.n, byIndex: uni.byIndex, overlap: uni.overlap, snapshotAt: uni.snapshotAt, sources: uni.sources, complete: uni.complete },
      coverage: cov, lastSweepAt: bars.lastCoverage()?.at ?? null,
      gaps: { bars: bars.gapCount(), days: bars.gapDays(), unfillable: calendar.unfillableCount() }, calendarSuspects: calendar.suspects({ limit: 3 }),
      lastRun: last, unfinishedRun: open, lastStageError: open ? stageErr : null,
      history: universe.backfillStatus(),
      deep: o.history ? bars.deepStatus({ symbols: historySymbols(), from: o.historyFrom }) : null,
      earnings: o.history && earnings ? earnings.status() : null,
    };
    return cached;
  }

  // the small object app.health() reports; ages are computed now from cached facts, so this is cheap and always current in its wording
  function health() {
    if (!db) return { summary: '' };
    if (!cached) { try { refreshQuality(); } catch { return { summary: 'data layer: data quality not computed yet' }; } }
    const q = cached, t = now();
    const newestCloseMs = q.coverage.newestDay ? sessionCloseMs(q.coverage.newestDay) : null;
    const dq = {
      asOfNy: nyDate(t), marketOpenNow: marketOpenNow(t), targetSession: q.target,
      universe: { symbols: q.universe.n, ageMs: q.universe.snapshotAt ? t - q.universe.snapshotAt : null, complete: q.universe.complete },
      coverage: { fresh: q.coverage.fresh, stale: q.coverage.stale, missing: q.coverage.missing, of: q.coverage.universe, ratio: q.coverage.universe ? q.coverage.fresh / q.coverage.universe : null, oldestLatestDay: q.coverage.oldestLatestDay, newestDay: q.coverage.newestDay },
      dataAgeMs: newestCloseMs === null ? null : Math.max(0, t - newestCloseMs),
      lastSweepAgeMs: q.lastSweepAt ? t - q.lastSweepAt : null,
      gaps: q.gaps, calendarSuspects: q.calendarSuspects,
      lastRun: q.lastRun ? { runId: q.lastRun.run_id, tradeDay: q.lastRun.trade_day, state: q.lastRun.state, error: q.lastRun.last_error } : null,
      unfinishedRun: q.unfinishedRun ? { runId: q.unfinishedRun.run_id, state: q.unfinishedRun.state, error: q.unfinishedRun.last_error } : null,
      pointInTimeHistory: q.history,
      deepHistory: q.deep, earnings: q.earnings,
      lastCycle: lastCycle ? { at: lastCycle.at, status: lastCycle.status, error: lastCycle.error || null } : null,
      delayNote: 'daily bars of finished sessions only; quote delay is not measured',
    };
    dq.summary = summarize(dq);
    return dq;
  }
  function summarize(d) {
    if (!d.universe.symbols) return `data layer: no universe yet${d.lastCycle?.error ? ` (${d.lastCycle.error})` : ', first sweep pending'}. Daily bars only; quote delay not measured.`;
    const c = d.coverage, bits = [];
    bits.push(c.newestDay ? `daily bars through ${c.newestDay} for ${c.fresh} of ${c.of} symbols fresh for ${d.targetSession}${c.stale ? `, ${c.stale} stale` : ''}${c.missing ? `, ${c.missing} with none` : ''}${d.dataAgeMs !== null ? `, data ${ago(d.dataAgeMs)} past that close` : ''}` : `no daily bars yet for ${c.of} symbols`);
    bits.push(`universe ${d.universe.symbols} symbols${d.universe.ageMs !== null ? `, list ${ago(d.universe.ageMs)} old` : ''}${d.universe.complete ? '' : ', INCOMPLETE'}`);
    if (d.gaps.bars) bits.push(`${d.gaps.bars} open symbol-day gap${d.gaps.bars === 1 ? '' : 's'} over ${d.gaps.days} day${d.gaps.days === 1 ? '' : 's'}`);
    if (d.gaps.unfillable) bits.push(`${d.gaps.unfillable} catch-up gap${d.gaps.unfillable === 1 ? '' : 's'} not fillable`);
    if (d.calendarSuspects.length) bits.push(`calendar doubts: ${d.calendarSuspects.map(s => `${s.day} ${s.verdict.replace('_', ' ')}`).join(', ')}`);
    const h = d.pointInTimeHistory;
    if (h && h.total) bits.push(`index history ${h.ok} of ${h.total} quarterly lists${h.pending ? `, ${h.pending} pending` : ''}${h.unparsed ? `, ${h.unparsed} unreadable` : ''}${h.givenUp ? `, ${h.givenUp} given up` : ''}`);
    const dh = d.deepHistory;
    if (dh && dh.wanted) bits.push(`bars from ${dh.from}: ${dh.ok} of ${dh.wanted} symbols${dh.notFound ? `, ${dh.notFound} unknown to the provider (delisted or renamed: survivorship gap)` : ''}${dh.pending ? `, ${dh.pending} pending` : ''}`);
    const e = d.earnings;
    if (e) bits.push(`earnings calendar ${e.pastDone} of ${e.pastDays} past days${e.failed ? `, ${e.failed} failed` : ''}`);
    if (d.unfinishedRun) bits.push(`run ${d.unfinishedRun.runId} not finished (${d.unfinishedRun.state}${d.unfinishedRun.error ? `: ${d.unfinishedRun.error}` : ''})`);
    else if (d.lastRun) bits.push(`last run ${d.lastRun.runId} ${d.lastRun.state}`);
    return `data layer: ${bits.join('; ')}. ${d.delayNote[0].toUpperCase()}${d.delayNote.slice(1)}.`;
  }

  const listRuns = ({ limit = 20 } = {}) => db.stmt('SELECT run_id AS runId, trade_day AS tradeDay, state, last_error AS error FROM run ORDER BY trade_day DESC LIMIT ?').all(Math.max(1, Math.min(500, limit)));
  const stagesOf = day => db.stmt('SELECT stage, status, attempts, started_at AS startedAt, finished_at AS finishedAt, error, detail FROM run_stage WHERE run_id = ? ORDER BY stage').all(runId(day)).map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));

  const feature = {
    id: 'runs', migrations: [migration],
    async start(ctx) {
      db = ctx.db; log = ctx.log; events = ctx.events; stopping = false; cached = null;
      // a stage left 'running' means the engine stopped or crashed mid-stage: mark it failed so the next cycle resumes from it
      const n = Number(db.stmt("UPDATE run_stage SET status = 'failed', finished_at = ?, error = 'interrupted: the engine stopped while this stage was running' WHERE status = 'running'").run(now()).changes);
      if (n) log.warn(`${n} stage(s) were interrupted by the last shutdown; they will resume`, { stages: n });
      calendar.materialize(addDays(nyDate(now()), -365 * o.calendarYears), addDays(nyDate(now()), 400));
      try { refreshQuality(); } catch (err) { log.warn('could not compute data_quality at start', { message: err.message }); }
      if (o.autoRun) {
        startTimer = setTimeout(() => { startTimer = null; runCycle({ reason: 'start' }).catch(() => {}); }, o.startDelayMs); startTimer.unref?.();
        tick = setInterval(() => {
          try {
            if (current || stopping) return;
            if (needsCycle()) runCycle({ reason: 'tick' }).catch(() => {});
            else if (bars.lastBarDay() !== null && needsHistory()) runHistory().catch(() => {});   // daily data first, history after
          } catch (err) { log.warn('tick failed', { message: err.message }); }
        }, o.tickMs); tick.unref?.();
      }
      qualityTimer = setInterval(() => { try { if (!current) refreshQuality(); } catch { /* the next one will try again */ } }, o.qualityEveryMs); qualityTimer.unref?.();
    },
    async stop() {
      stopping = true;
      clearTimeout(startTimer); clearInterval(tick); clearInterval(qualityTimer); startTimer = tick = qualityTimer = null;
      await halt();   // ask the sweep and the Wikipedia backfill to stop after their current call
      if (current) await Promise.race([current.catch(() => {}), new Promise(r => { const t = setTimeout(r, 4000); t.unref?.(); })]);
    },
    health,
  };

  const api = { runCycle, runHistory, needsCycle, needsHistory, historyPending, health, quality: () => refreshQuality(), listRuns, stagesOf, getRun, runId, options: o };
  return { feature, api };
}

module.exports = { createRuns, runId, MIGRATION_VERSION };
