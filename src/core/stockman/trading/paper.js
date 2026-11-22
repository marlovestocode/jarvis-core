// Feature "paper" (vault Phase 1 exit test, D21, D23): the paper-trade opener. PAPER ONLY: it writes rows into the ledger and nothing else.
// No order is placed, no broker is called, there is no network access in this file (vault D1, D14, D23). OFF BY DEFAULT.
//
// What it does, each step, for the scoring build's shadow candidates (learning/shadow.js) where in_basket = 1:
//   1. OPEN   a ledger position (source paper-internal, status open) for every basket candidate of a logged day that has none. Linked by
//             run_id and candidate_id: run_id is the data run, the candidate id is `run-DAY/SYMBOL/BUILD` (also kept in `note` as
//             `candidate=<id>`; the ledger has no candidate column and none was added: that would be a schema change). Sleeve = the 5-session
//             grid ending 2026-11-13, as in the backtest. Weight 1/basket size. Expected entry price = the signal day's adjusted close.
//   2. ENTER  when the entry session's bar exists: the fill is the OPEN of the entry session on the adjusted basis (open x adj/close, as in
//             the backtest and the shadow outcomes), source paper-internal.
//   3. CLOSE  when the exit session's bar (the close of the 5th session held) and the benchmark's bars exist: the exit fill, then the ledger
//             closes the position with the cost model's base case (10 bps round trip, costs.js; reports recompute 5, 10 and 25 bps from the
//             gross return) and SPY's return over the same dates.
// Idempotent and resumable: all state is in stockman.db. A rerun is a no-op; a closed app costs only time, because every position still
// open is entered or closed on the next step once its bars exist (G17). A missing bar is a GAP: the position stays open with a note
// `gap: <reason>` after 3 grace sessions, a late bar can still fix it, and nothing is ever filled, copied or interpolated.
// Honest-start rules: a day logged AFTER its entry session (`late`) is never traded (the decision was not made before the entry), and days on
// or before 2026-11-13 (the backtest and its frozen holdout, note 06) are never traded.
// The vault gate (note 06): paper trading starts only after the rule passes the tuning period. This feature does not check that for you; it
// is off until someone turns it on (STOCKMAN_PAPER_TRADING=on or `paperTrading.enabled` in stockman.config.json).
// Trust path (D11): nothing here imports the cortex, the orchestrator or any conversational code, so a tainted turn cannot reach or block it.
const { StockmanError } = require('../errors');
const { tradingDays, nextTradingDay } = require('../features/calendar-rules');
const { BASE_BPS } = require('./costs');

const SOURCE = 'paper-internal';
const ANCHOR = '2026-11-13';   // the window grid ends here (same as the backtest), so sleeves line up with it
const HOLD_SESSIONS = 5;

// deps: { ledger (api), shadow (api), scoring (api), bars: { lastBarDay }, now, opts }
function createPaper({ ledger, shadow, scoring, bars, now = Date.now, opts = {} } = {}) {
  for (const [n, x] of Object.entries({ ledger, shadow, scoring, bars })) if (!x) throw new TypeError(`paper needs the ${n} api`);
  const o = { enabled: false, benchmark: 'SPY', gapGraceSessions: 3, maxOpenPerStep: 3000, maxPerStep: 5000, costBps: BASE_BPS, tickMs: 5 * 60000, startDelayMs: 6000, healthCacheMs: 30000, autoRun: true, ...opts };
  const ledgerBuild = `${scoring.build}/L5/vol`;   // the same label the backtest gives this variant (engine.buildId)
  let db = null, log = null, stopping = false, busy = false, tick = null, startTimer = null, healthCache = null;

  const need = () => { if (!db) throw new StockmanError('paper: not started'); return db; };
  const sessionsAfter = (day, n) => { let d = day; for (let i = 0; i < n; i++) d = nextTradingDay(d); return d; };
  // sleeve 0..4: sessions between the exit day and the grid's end, modulo 5 (the backtest's formula)
  function sleeveOf(exitDay) {
    const n = exitDay <= ANCHOR ? tradingDays(exitDay, ANCHOR).length - 1 : -(tradingDays(ANCHOR, exitDay).length - 1);
    return ((n % HOLD_SESSIONS) + HOLD_SESSIONS) % HOLD_SESSIONS;
  }
  const barOn = (symbol, day) => need().stmt('SELECT open, close, adj_close AS adj FROM bar WHERE symbol = ? AND day = ?').get(symbol, day) || null;
  const usable = b => b && [b.open, b.close, b.adj].every(x => typeof x === 'number' && Number.isFinite(x) && x > 0);
  const adjOpen = b => b.open * (b.adj / b.close);
  const candidateOf = p => { const m = /^candidate=(\S+)/.exec(p.note || ''); return m ? m[1] : null; };
  const noteOf = p => (p.note || '').replace(/ ?gap: \S+/, '');

  // ---- 1. open ----------------------------------------------------------------------------------------------------------------------
  function openNew() {
    const d = need();
    const rows = d.stmt(`SELECT c.candidate_id AS id, c.run_id AS runId, c.day, c.symbol, c.score, c.entry_day AS entryDay, c.exit_day AS exitDay,
        (SELECT COUNT(*) FROM candidate k WHERE k.run_id = c.run_id AND k.scoring_build = c.scoring_build AND k.in_basket = 1) AS basketSize
      FROM candidate c JOIN shadow_day s ON s.day = c.day AND s.scoring_build = c.scoring_build
      WHERE c.scoring_build = ? AND c.in_basket = 1 AND c.day > ? AND s.late = 0
        AND NOT EXISTS (SELECT 1 FROM paper_position p WHERE p.source = ? AND p.run_id = c.run_id AND p.symbol = c.symbol AND p.scoring_build = ?)
      ORDER BY c.day, c.rank LIMIT ?`).all(scoring.build, shadow.HOLDOUT_END, SOURCE, ledgerBuild, o.maxOpenPerStep);
    let n = 0;
    d.tx(() => {
      for (const c of rows) {
        if (stopping) break;
        const sig = barOn(c.symbol, c.day);
        ledger.open({
          source: SOURCE, runId: c.runId, basketId: `${c.runId}/${ledgerBuild}`, sleeve: sleeveOf(c.exitDay), scoringBuild: ledgerBuild, symbol: c.symbol,
          weight: 1 / c.basketSize, score: c.score, signalDay: c.day, entryDay: c.entryDay, exitDay: c.exitDay,
          expectedEntryPrice: sig && sig.adj > 0 ? sig.adj : null, note: `candidate=${c.id}`,
        });
        n++;
      }
    });
    return n;
  }

  // ---- 2 and 3. enter and close -----------------------------------------------------------------------------------------------------
  const setGap = (p, reason) => { if (!(p.note || '').includes(`gap: ${reason}`)) ledger.annotate(p.id, `${noteOf(p)} gap: ${reason}`.trim()); };
  const clearGap = p => { if ((p.note || '').includes('gap: ')) ledger.annotate(p.id, noteOf(p)); };

  function work() {
    const d = need();
    const latest = bars.lastBarDay();
    const res = { entered: 0, closed: 0, waiting: 0, gaps: 0 };
    if (!latest) return res;
    const open = d.stmt("SELECT * FROM paper_position WHERE source = ? AND status = 'open' ORDER BY entry_day, id LIMIT ?").all(SOURCE, o.maxPerStep);
    const benchCache = new Map();
    const bench = (entryDay, exitDay) => {
      const k = `${entryDay}|${exitDay}`;
      if (!benchCache.has(k)) {
        const e = barOn(o.benchmark, entryDay), x = barOn(o.benchmark, exitDay);
        benchCache.set(k, !usable(e) ? { reason: 'benchmark_no_entry_bar' } : !usable(x) ? { reason: 'benchmark_no_exit_bar' } : { ret: x.adj / adjOpen(e) - 1 });
      }
      return benchCache.get(k);
    };
    d.tx(() => {
      for (const p of open) {
        if (stopping) break;
        // entry
        if (!(p.fill_entry_price > 0)) {
          const e = barOn(p.symbol, p.entry_day);
          if (!usable(e)) {
            if (latest < sessionsAfter(p.entry_day, o.gapGraceSessions)) res.waiting++; else { setGap(p, 'no_entry_bar'); res.gaps++; }
            continue;
          }
          ledger.recordFill({ positionId: p.id, leg: 'entry', price: adjOpen(e), day: p.entry_day, source: SOURCE });
          res.entered++;
          p.fill_entry_price = adjOpen(e);
        }
        // exit: the close of the 5th session held, and the benchmark over the same dates
        const x = barOn(p.symbol, p.exit_day);
        const b = bench(p.entry_day, p.exit_day);
        const reason = !usable(x) ? 'no_exit_bar' : b.reason || null;
        if (reason) {
          if (latest < sessionsAfter(p.exit_day, o.gapGraceSessions)) res.waiting++; else { setGap(p, reason); res.gaps++; }
          continue;
        }
        if (!(p.fill_exit_price > 0)) ledger.recordFill({ positionId: p.id, leg: 'exit', price: x.adj, day: p.exit_day, source: SOURCE });
        clearGap(p);
        ledger.close(p.id, { costBps: o.costBps, benchmarkReturn: b.ret });
        res.closed++;
      }
    });
    return res;
  }

  // one step: open, enter, close. Never overlaps itself; does nothing at all while the switch is off.
  async function step() {
    if (!o.enabled) return { status: 'off' };
    need();
    if (busy) return { status: 'busy' };
    busy = true;
    try {
      const out = { status: 'ok', opened: openNew(), ...work() };
      healthCache = null;
      return out;
    } finally { busy = false; }
  }

  // ---- reading ----------------------------------------------------------------------------------------------------------------------
  function status() {
    const n = (sql, ...a) => Number(need().stmt(sql).get(...a).n);
    const count = st => n('SELECT COUNT(*) AS n FROM paper_position WHERE source = ? AND status = ?', SOURCE, st);
    const last = need().stmt("SELECT symbol, exit_day AS exitDay, net_return AS net FROM paper_position WHERE source = ? AND status = 'closed' ORDER BY closed_at DESC, id DESC LIMIT 1").get(SOURCE) || null;
    return {
      enabled: o.enabled, build: ledgerBuild, open: count('open'), closed: count('closed'), cancelled: count('cancelled'),
      gaps: n("SELECT COUNT(*) AS n FROM paper_position WHERE source = ? AND status = 'open' AND note LIKE '%gap: %'", SOURCE),
      lateDaysSkipped: n('SELECT COUNT(*) AS n FROM shadow_day WHERE scoring_build = ? AND late = 1 AND day > ?', scoring.build, shadow.HOLDOUT_END),
      meanNetClosed: n('SELECT COUNT(*) AS n FROM paper_position WHERE source = ? AND status = ?', SOURCE, 'closed') ? Number(need().stmt("SELECT AVG(net_return) AS m FROM paper_position WHERE source = ? AND status = 'closed'").get(SOURCE).m) : null,
      last, costBps: o.costBps,
    };
  }
  function health() {
    if (!db) return { summary: '' };
    const t = now();
    if (healthCache && t - healthCache.at < o.healthCacheMs) return healthCache.value;
    let value;
    try {
      const s = status();
      let summary;
      if (!s.enabled && s.open + s.closed === 0) summary = 'paper trading: OFF (no positions; it stays off until the rule passes the tuning period, vault note 06). No orders are ever placed';
      else {
        const bits = [`paper trading (internal, no orders, build ${s.build}): ${s.enabled ? 'ON' : 'OFF'}`, `${s.open} open`, `${s.closed} closed${s.closed ? ` (mean net ${(s.meanNetClosed * 100).toFixed(2)}% per name at ${s.costBps} bps, not a prediction)` : ''}`];
        if (s.gaps) bits.push(`${s.gaps} gap${s.gaps === 1 ? '' : 's'} (never filled)`);
        if (s.lateDaysSkipped) bits.push(`${s.lateDaysSkipped} late day${s.lateDaysSkipped === 1 ? '' : 's'} not traded`);
        summary = bits.join('; ');
      }
      value = { summary: `${summary}.`, ...s, last: undefined };
    } catch (err) { value = { summary: '', error: String(err.message).slice(0, 200) }; }
    healthCache = { at: t, value };
    return value;
  }

  const api = { step, openNew, status, health, sleeveOf, candidateOf, ledgerBuild, SOURCE, options: o };
  const feature = {
    id: 'paper',
    async start(ctx) {
      db = ctx.db; log = ctx.log; stopping = false; healthCache = null;
      if (o.enabled && o.autoRun) {
        startTimer = setTimeout(() => { startTimer = null; step().catch(err => log?.warn('paper step failed', { message: err.message })); }, o.startDelayMs); startTimer.unref?.();
        tick = setInterval(() => { if (!busy && !stopping) step().catch(err => log?.warn('paper step failed', { message: err.message })); }, o.tickMs); tick.unref?.();
      }
    },
    async stop() { stopping = true; clearTimeout(startTimer); clearInterval(tick); startTimer = tick = null; },
    health,
  };
  return { feature, api };
}

module.exports = { createPaper, SOURCE, ANCHOR };
