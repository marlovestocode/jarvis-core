// Feature "sandbox" (vault D28, CL-0071): runs the user-edited strategy (strategy.js) against the Alpaca PAPER account. SANDBOX, USER-EDITED, NOT EVIDENCE
// OF AN EDGE: rows are ledger source 'broker-paper' with build `sbx-<hash of the strategy file>`; nothing here feeds calibration or the shadow log, it
// never touches the holdout, and it does not count toward the 12 tried variants.
//   Orders need ALL THREE switches: online.broker (jarvis config), broker.enabled and sandbox.enabled (stockman.config.json). The strategy file cannot
//   turn any of them on. Live money is refused (D1): trading/alpaca.js has no live host.
//   Daily cycle (a timer, every minute in market hours, every 5 minutes otherwise):
//     1 reload the strategy file when it changed (a bad edit is refused, the last good version keeps running)
//     2 PLAN, after the close once the day's bars are stored (16:45 New York time or later): score, build targets, compare with what the sandbox holds
//       (its own ledger positions), apply the exit rules and the risk limits, store the plan. A refused order is logged with its reason, never shrunk.
//     3 EXECUTE, in the first 30 minutes after the next open (for `opg`: before 9:28): send each order once (client id sm-sbx-<signalDay>-<symbol>-<leg>,
//       so repeating a run never doubles an order). With execution.dryRun true the plan is stored and printed, and NOTHING is sent.
//     4 RECONCILE fills into the ledger next to the expected price; a position with both fills is closed with no extra cost and the SPY return.
//   Holdings change only by entering new targets and exiting names that dropped out, hit a time, stop, take-profit or trailing exit: a held name is never
//   resized by a rebalance. State (kill switch, equity history, last plan) is a JSON file in the data folder: no table.
//   Kill switch: if the account's equity fell by dailyLossKillPct or more since the last recorded close, orders are switched off until the user runs
//   `strategy enable` again; the reason is logged loudly and shown on the dashboard.
const fs = require('node:fs');
const path = require('node:path');
const { nyDate, nyWallToMs } = require('../../features/ny-time');
const { dayInfo, isTradingDay, nextTradingDay } = require('../../features/calendar-rules');
const { StockmanError, PolicyError } = require('../../errors');
const { buildTargets, isRebalanceDay } = require('./engine');
const E = require('../engine');

const SOURCE = 'broker-paper';
const PLAN_AFTER_CLOSE_MIN = 45, EXEC_WINDOW_MIN = 30;
const LABEL = 'sandbox, user-edited, not evidence of an edge';
const SIGNAL_SESSIONS = 430;

function sessionsAfter(day, n) { let d = day; for (let i = 0; i < n; i++) d = nextTradingDay(d); return d; }

function createSandbox({ ledger, alpaca, data, store, stateFile, now = Date.now, opts = {}, log = null, events = null } = {}) {
  for (const [n, x] of Object.entries({ ledger, alpaca, data, store })) if (!x) throw new TypeError(`sandbox needs the ${n}`);
  const o = { enabled: false, autoRun: true, benchmark: 'SPY', tickOpenMs: 60000, tickClosedMs: 5 * 60000, startDelayMs: 20000, tuner: null, ...opts };
  let db = null, stopping = false, busy = false, timer = null, startTimer = null, lastError = null;
  const on = () => Boolean(typeof o.enabled === 'function' ? o.enabled() : o.enabled);   // a function lets the worker re-read stockman.config.json, so `strategy enable` needs no restart
  const emit = (level, message, extra) => { try { log?.[level === 'warn' ? 'warn' : 'info']?.(message, extra); events?.append?.({ level, source: 'sandbox', message, data: extra }); } catch { /* logging must never break a step */ } };

  // ---- state file ---------------------------------------------------------------------------------------------------------------------
  const emptyState = () => ({ killed: null, equityHistory: [], lastPlanDay: null, lastRebalanceDay: null, ordersByDay: {}, lastPlan: null, lastRun: null, lastTune: null, lastChangeDay: null });
  function readState() {
    try { return { ...emptyState(), ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { return emptyState(); }
  }
  function writeState(s) {
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, stateFile);
  }
  const need = () => { if (!db) throw new StockmanError('sandbox: not started'); return db; };

  // ---- data ---------------------------------------------------------------------------------------------------------------------------
  // aligned series for `symbols` over the last SIGNAL_SESSIONS sessions up to `day` (SPY's sessions are the grid), as the backtest engine builds them
  function loadSeries(day, symbols) {
    const d = need();
    const all = d.stmt('SELECT day FROM bar WHERE symbol = ? AND day <= ? ORDER BY day DESC LIMIT ?').all(o.benchmark, day, SIGNAL_SESSIONS).map(r => r.day).reverse();
    if (all.length < 60 || all.at(-1) !== day) throw new StockmanError(`sandbox: the benchmark ${o.benchmark} has no bar for ${day} yet`);
    const index = new Map(all.map((x, i) => [x, i]));
    const list = JSON.stringify([...new Set([...symbols, o.benchmark])]);
    const rows = new Map();
    for (const r of d.stmt('SELECT symbol, day, open, high, low, close, adj_close, volume FROM bar WHERE day >= ? AND day <= ? AND symbol IN (SELECT value FROM json_each(?)) ORDER BY symbol, day').all(all[0], day, list)) {
      let a = rows.get(r.symbol); if (!a) rows.set(r.symbol, a = []); a.push(r);
    }
    const series = new Map([...rows].map(([s, r]) => [s, E.alignSeries(all, index, r)]));
    const dv = new Map(d.stmt('SELECT symbol, AVG(close * volume) AS v FROM bar WHERE day > ? AND day <= ? AND symbol IN (SELECT value FROM json_each(?)) GROUP BY symbol').all(all[Math.max(0, all.length - 21)], day, list).map(r => [r.symbol, r.v]));
    return { sessions: all, d: all.length - 1, series, bench: series.get(o.benchmark), dollarVolume: s => dv.get(s) ?? 0 };
  }
  function membersFor(strategy, day) {
    const m = data.universe.membersAsOf(day), out = new Set();
    const idx = strategy.universe.index === 'both' ? ['sp500', 'ndx100'] : [strategy.universe.index];
    for (const i of idx) if (m[i]) for (const s of m[i].symbols) out.add(s);
    if (!out.size) throw new StockmanError(`sandbox: no point-in-time membership list on or before ${day}`);
    return [...out];
  }
  const holdings = () => ledger.list({ source: SOURCE, status: 'open', limit: 100000 }).filter(p => typeof p.scoring_build === 'string' && p.scoring_build.startsWith('sbx-'));
  const noteKey = (p, k) => { const m = new RegExp(`\\b${k}=(\\S+)`).exec(p.note || ''); return m ? m[1] : null; };
  const fillQty = p => Number(need().stmt("SELECT SUM(quantity) AS q FROM paper_fill WHERE position_id = ? AND leg = 'entry' AND source = ?").get(p.id, SOURCE).q) || 0;

  // ---- the plan -----------------------------------------------------------------------------------------------------------------------
  // plan(day): everything the strategy would do after the close of `day`. Pure read: no order is sent, no state changes (runPlan stores it).
  function plan(day) {
    const cur = store.check();
    if (!cur.strategy) throw new StockmanError(`sandbox: no valid strategy yet (${cur.error?.errors?.[0] || 'unknown'})`);
    const strategy = cur.strategy, hash = cur.hash, buildId = cur.buildId;
    const members = membersFor(strategy, day);
    const L = loadSeries(day, members);
    const entryDay = nextTradingDay(day), flagExit = sessionsAfter(entryDay, Math.max(1, strategy.universe.excludeEarningsDays));
    const excluded = data.earnings && strategy.universe.excludeEarningsDays > 0
      ? sym => { try { const f = data.earnings.flags({ symbol: sym, entryDay, exitDay: flagExit }); return Boolean(f.earnings_in_window || f.earnings_possible); } catch { return false; } }
      : null;
    const built = buildTargets(strategy, { d: L.d, members, series: L.series, bench: L.bench, dollarVolume: L.dollarVolume, excluded });
    const held = holdings();
    // the first build: with nothing ever rebalanced and nothing held, the first scheduled plan builds the portfolio, so a monthly calendar does not leave it idle for weeks
    const firstBuild = readState().lastRebalanceDay === null && held.length === 0;
    const rebalance = isRebalanceDay(strategy.portfolio.rebalance, L.sessions, L.d, entryDay) || firstBuild;
    const targetSet = new Map(built.targets.map(t => [t.symbol, t]));
    const orders = [], refused = [], R = strategy.risk, X = strategy.exits;
    const state = readState(), ordersToday = (state.ordersByDay[entryDay] || 0);

    // exits first (they free capacity)
    for (const p of held) {
      const s = L.series.get(p.symbol), price = s && s.close[L.d] > 0 ? s.close[L.d] : null, entry = p.fill_entry_price;
      let reason = null;
      if (p.exit_day <= entryDay) reason = `time exit (${X.timeExitSessions} sessions)`;
      else if (price && entry && X.stopLossPct !== null && price <= entry * (1 - X.stopLossPct / 100)) reason = `stop loss ${X.stopLossPct}%`;
      else if (price && entry && X.takeProfitPct !== null && price >= entry * (1 + X.takeProfitPct / 100)) reason = `take profit ${X.takeProfitPct}%`;
      else if (price && entry && X.trailingPct !== null) {
        const hi = Number(need().stmt('SELECT MAX(close) AS h FROM bar WHERE symbol = ? AND day >= ? AND day <= ?').get(p.symbol, p.entry_day, day).h) || 0;
        if (hi > 0 && price <= hi * (1 - X.trailingPct / 100)) reason = `trailing stop ${X.trailingPct}% from the high`;
      }
      if (!reason && rebalance && !targetSet.has(p.symbol)) reason = 'no longer in the target portfolio';
      if (reason && !noteKey(p, 'xit')) {
        const qty = fillQty(p);
        if (qty > 0) orders.push({ leg: 'exit', symbol: p.symbol, positionId: p.id, qty, price, reason, cid: `sm-sbx-${day}-${p.symbol}-exit` });
        else refused.push({ symbol: p.symbol, leg: 'exit', reason: 'no filled entry quantity yet' });
      }
    }
    // entries (only on a rebalance day), within capacity
    const exiting = new Set(orders.filter(x => x.leg === 'exit').map(x => x.symbol));
    const stays = held.filter(p => !exiting.has(p.symbol));
    const heldSymbols = new Set(held.map(p => p.symbol));
    if (rebalance) {
      let slots = R.maxPositions - stays.length, grossNow = stays.reduce((a, p) => a + (p.weight * R.capitalUsd || 0), 0);
      for (const t of built.targets) {
        if (heldSymbols.has(t.symbol)) continue;
        const why = slots <= 0 ? `would exceed maxPositions (${R.maxPositions})` : t.notionalUsd > R.maxOrderNotionalUsd ? `notional ${t.notionalUsd} is above maxOrderNotionalUsd ${R.maxOrderNotionalUsd}`
          : t.notionalUsd > (alpaca.options?.maxNotionalUsd ?? Infinity) ? `notional ${t.notionalUsd} is above the adapter cap ${alpaca.options.maxNotionalUsd}`
          : grossNow + t.notionalUsd > R.capitalUsd * R.maxGrossPct / 100 + 0.5 ? `would exceed maxGrossPct (${R.maxGrossPct}%)` : null;
        if (why) { refused.push({ symbol: t.symbol, leg: 'entry', reason: why }); continue; }
        orders.push({ leg: 'entry', symbol: t.symbol, notionalUsd: t.notionalUsd, price: t.price, weight: t.weight, score: t.score, reason: 'new target', cid: `sm-sbx-${day}-${t.symbol}-entry` });
        slots--; grossNow += t.notionalUsd;
      }
    }
    // order count per day
    let sendable = Math.max(0, R.maxOrdersPerDay - ordersToday);
    const kept = [];
    for (const x of orders) { if (kept.length < sendable) kept.push(x); else refused.push({ symbol: x.symbol, leg: x.leg, reason: `would exceed maxOrdersPerDay (${R.maxOrdersPerDay})` }); }
    return { label: LABEL, day, entryDay, builtAt: now(), strategyHash: hash, buildId, rebalance, firstBuild, rule: strategy.portfolio.rebalance, dryRun: strategy.execution.dryRun, execution: strategy.execution.order,
      regime: built.regime, counts: built.counts, targets: built.targets, orders: kept, refused, holdings: held.length };
  }

  // ---- execution ----------------------------------------------------------------------------------------------------------------------
  function strategySnapshot() { const c = store.state(); return { hash: c.hash, json: JSON.stringify(c.strategy) }; }
  async function send(p, strategy) {
    const ex = strategy.execution, out = { sent: 0, failed: 0, skipped: 0, ids: [] };
    for (const x of p.orders) {
      if (stopping) break;
      try {
        let positionId = x.positionId, tif = ex.order === 'opg' ? 'opg' : 'day', qty = x.qty ?? null, notionalUsd = x.notionalUsd ?? null, limitPrice = null;
        const mid = ex.order === 'limit' || ex.order === 'opg' ? await alpaca.stockMid(x.symbol).catch(() => x.price) : null;
        if (ex.order === 'opg' || ex.order === 'limit') {                      // neither takes a notional: whole shares
          if (x.leg === 'entry') { qty = Math.floor(x.notionalUsd / (mid || x.price)); notionalUsd = null; if (!(qty >= 1)) { out.skipped++; p.refused.push({ symbol: x.symbol, leg: x.leg, reason: 'one whole share costs more than the notional (opg and limit orders use whole shares)' }); continue; } }
          else if (!Number.isInteger(qty)) { tif = 'day'; }                       // a fractional exit can only go as a day market order
        }
        if (ex.order === 'limit' && Number.isInteger(qty)) { limitPrice = mid * (1 + (x.leg === 'entry' ? 1 : -1) * ex.limitBps / 1e4); tif = 'day'; }
        if (x.leg === 'entry') {
          const existing = need().stmt('SELECT id FROM paper_position WHERE source = ? AND scoring_build = ? AND note LIKE ?').get(SOURCE, p.buildId, `%sbx=${x.cid}%`);
          if (existing) positionId = Number(existing.id);
          else {
            const snap = strategySnapshot();
            positionId = ledger.open({ source: SOURCE, runId: `sbx-${p.day}`, basketId: `${p.buildId}/${p.day}`, scoringBuild: p.buildId, symbol: x.symbol, weight: x.weight, score: x.score, signalDay: p.day, entryDay: p.entryDay,
              exitDay: sessionsAfter(p.entryDay, strategy.exits.timeExitSessions), expectedEntryPrice: x.price, note: `sbx=${x.cid} strategy=${snap.hash} json=${snap.json}` });
          }
        }
        const ord = await alpaca.placeOrder({ clientId: x.cid, leg: x.leg, symbol: x.symbol, notionalUsd, qty, timeInForce: tif, limitPrice });
        if (x.leg === 'exit') { const pos = ledger.getPosition(positionId); if (pos && !noteKey(pos, 'xit')) ledger.annotate(positionId, `${(pos.note || '').trim()} xit=${x.cid}`); }
        out.sent++; out.ids.push(ord.id);
      } catch (err) {
        if (err instanceof PolicyError) throw err;
        out.failed++; emit('warn', `sandbox: order failed for ${x.symbol} ${x.leg}`, { message: String(err.message).slice(0, 200) });
      }
    }
    return out;
  }

  // ---- fills --------------------------------------------------------------------------------------------------------------------------
  const CID = /^sm-sbx-(\d{4}-\d{2}-\d{2})-([A-Z0-9.\-]+)-(entry|exit)$/;
  async function reconcile(t) {
    const orders = await alpaca.listOrders({ status: 'all', after: new Date(t - 12 * 86400000).toISOString() });
    let delivered = 0;
    for (const ord of orders) {
      const m = CID.exec(ord.clientOrderId || '');
      if (!m || ord.status !== 'filled' || !ord.filledAvgPrice || !ord.filledAt) continue;
      const key = m[3] === 'entry' ? 'sbx' : 'xit';
      const pos = need().stmt('SELECT id FROM paper_position WHERE source = ? AND scoring_build LIKE ? AND note LIKE ?').get(SOURCE, 'sbx-%', `%${key}=${ord.clientOrderId}%`);
      if (!pos) continue;
      try { ledger.recordFill({ positionId: Number(pos.id), leg: m[3], price: ord.filledAvgPrice, day: nyDate(Date.parse(ord.filledAt)), quantity: ord.filledQty > 0 ? ord.filledQty : null, source: SOURCE, externalId: ord.id }); delivered++; } catch (err) { emit('warn', 'sandbox: fill not stored', { message: String(err.message).slice(0, 160), id: ord.id }); }
    }
    let closed = 0;
    for (const p of need().stmt("SELECT * FROM paper_position WHERE source = ? AND status = 'open' AND scoring_build LIKE 'sbx-%' AND fill_entry_price IS NOT NULL AND fill_exit_price IS NOT NULL").all(SOURCE)) {
      const e = need().stmt('SELECT open, close, adj_close AS adj FROM bar WHERE symbol = ? AND day = ?').get(o.benchmark, p.entry_day), x = need().stmt('SELECT adj_close AS adj FROM bar WHERE symbol = ? AND day = ?').get(o.benchmark, p.exit_day);
      const bench = e && x && e.open > 0 && e.close > 0 ? x.adj / (e.open * (e.adj / e.close)) - 1 : null;
      try { ledger.close(p.id, { costBps: 0, benchmarkReturn: bench }); closed++; } catch (err) { emit('warn', 'sandbox: could not close', { id: p.id, message: String(err.message).slice(0, 160) }); }
    }
    return { seen: orders.length, delivered, closed };
  }

  // ---- the daily cycle ----------------------------------------------------------------------------------------------------------------
  function clockNow(t) {
    const day = nyDate(t);
    if (!isTradingDay(day)) return null;
    const i = dayInfo(day), openMs = nyWallToMs(day, i.open), closeMs = nyWallToMs(day, i.close);
    return { day, openMs, closeMs, minSinceOpen: (t - openMs) / 60000, minSinceClose: (t - closeMs) / 60000 };
  }
  async function recordEquity(state, day) {
    const acc = await alpaca.account(), spy = need().stmt('SELECT adj_close AS a FROM bar WHERE symbol = ? AND day = ?').get(o.benchmark, day);
    const prev = state.equityHistory.at(-1);
    if (!prev || prev.day !== day) state.equityHistory.push({ day, equity: acc.equity, spy: spy ? spy.a : null });
    state.equityHistory = state.equityHistory.slice(-400);
    return { equity: acc.equity, prev: prev && prev.day !== day ? prev : state.equityHistory.at(-2) };
  }

  // store a plan; on the scheduled path also read the equity, apply the kill switch and run the tuner on its day
  async function runPlan({ day, scheduled = false } = {}) {
    const cur = store.check();
    const p = plan(day);
    const state = readState();
    if (scheduled) {
      const eq = await recordEquity(state, day);
      const R = cur.strategy.risk;
      if (eq.prev && eq.prev.equity > 0) {
        const lossPct = (eq.prev.equity - eq.equity) / eq.prev.equity * 100;
        if (lossPct >= R.dailyLossKillPct && !state.killed) {
          state.killed = { at: now(), day, reason: `equity fell ${lossPct.toFixed(2)}% since ${eq.prev.day} (kill at ${R.dailyLossKillPct}%)` };
          emit('warn', `SANDBOX KILL SWITCH: ${state.killed.reason}. Orders are switched off until \`strategy enable\`.`);
        }
      }
      state.lastPlanDay = day;
      if (p.rebalance) state.lastRebalanceDay = day;
    }
    state.lastPlan = { ...p, scheduled };
    writeState(state);
    emit('info', `sandbox plan ${day}: ${p.orders.length} order(s), ${p.refused.length} refused, rebalance ${p.rebalance}, ${p.dryRun ? 'DRY RUN' : 'live paper'}`, { hash: p.strategyHash });
    return state.lastPlan;
  }

  async function step() {
    if (!db) throw new StockmanError('sandbox: not started');
    if (!on()) { store.check(); return { status: 'off' }; }
    if (busy) return { status: 'busy' };
    busy = true;
    const t = now(), res = { status: 'ok', at: t };
    try {
      const cur = store.check();
      if (!cur.strategy) { res.status = 'no-strategy'; res.note = cur.error?.errors?.[0]; lastError = res.note; return res; }
      const state = readState(), c = clockNow(t);
      if (state.killed) res.killed = state.killed;
      // reconcile fills whenever there is something open
      try { res.reconcile = await reconcile(t); } catch (err) { if (err instanceof PolicyError) { res.status = 'refused'; res.note = err.message; lastError = res.note; return res; } res.reconcile = { error: String(err.message).slice(0, 160) }; }
      if (c) {
        // PLAN after the close, once, when the day's benchmark bar is stored
        if (c.minSinceClose >= PLAN_AFTER_CLOSE_MIN && state.lastPlanDay !== c.day && data.bars.lastBarDay() === c.day) {
          try { res.plan = await runPlan({ day: c.day, scheduled: true }); res.planned = { orders: res.plan.orders.length, refused: res.plan.refused.length }; } catch (err) { res.planError = String(err.message).slice(0, 200); emit('warn', `sandbox: could not plan ${c.day}`, { message: res.planError }); }
          if (o.tuner && res.plan?.rebalance && cur.strategy.tuning.enabled && !readState().killed) { try { res.tune = await o.tuner.maybeRun({ day: c.day }); } catch (err) { emit('warn', 'sandbox: the tuner failed; it changes nothing', { message: String(err.message).slice(0, 200) }); } }
        }
        // EXECUTE the stored plan: only the session right after its day, and only if not killed and not a dry run
        const st = readState(), lp = st.lastPlan;
        const opg = cur.strategy.execution.order === 'opg';
        const inWindow = opg ? t < c.openMs - 2 * 60000 : c.minSinceOpen >= 1 && c.minSinceOpen <= EXEC_WINDOW_MIN;
        const fresh = lp && lp.scheduled && lp.entryDay === c.day && !lp.executedAt;
        if (fresh && inWindow) {
          if (st.killed) { res.exec = { status: 'killed', note: st.killed.reason }; }
          else if (lp.dryRun || cur.strategy.execution.dryRun) { lp.executedAt = t; lp.executed = { dryRun: true, sent: 0 }; st.lastPlan = lp; writeState(st); res.exec = { status: 'dry-run', sent: 0 }; }
          else {
            const x = await send(lp, cur.strategy);
            lp.executedAt = t; lp.executed = x; st.ordersByDay[c.day] = (st.ordersByDay[c.day] || 0) + x.sent; st.lastPlan = lp; st.lastRun = t;
            writeState(st); res.exec = { status: 'sent', ...x };
            emit('info', `sandbox: sent ${x.sent} order(s), ${x.failed} failed`, { day: c.day });
          }
        }
      }
    } catch (err) {
      res.status = err instanceof PolicyError ? 'refused' : 'error'; res.note = String(err.message).slice(0, 200); lastError = res.note;
      if (res.status === 'error') emit('warn', 'sandbox step failed', { message: res.note });
    } finally { busy = false; }
    return res;
  }

  // ---- reading ------------------------------------------------------------------------------------------------------------------------
  function status() {
    const cur = store.state(), st = readState(), held = db ? holdings() : [];
    const eh = st.equityHistory, first = eh[0], last = eh.at(-1);
    const pnl = first && last && first.equity > 0 ? { since: first.day, equityPct: (last.equity / first.equity - 1) * 100, spyPct: first.spy && last.spy ? (last.spy / first.spy - 1) * 100 : null } : null;
    return {
      label: LABEL, enabled: on(), hash: cur.hash, buildId: cur.buildId, strategyName: cur.strategy?.name ?? null, dryRun: cur.strategy?.execution.dryRun ?? null, rebalance: cur.strategy?.portfolio.rebalance ?? null,
      strategyError: cur.error ? cur.error.errors.slice(0, 5) : null, loadedAt: cur.loadedAt, killed: st.killed, lastPlanDay: st.lastPlanDay, lastRebalanceDay: st.lastRebalanceDay,
      lastPlan: st.lastPlan && { day: st.lastPlan.day, entryDay: st.lastPlan.entryDay, rebalance: st.lastPlan.rebalance, dryRun: st.lastPlan.dryRun, regime: st.lastPlan.regime, orders: st.lastPlan.orders, refused: st.lastPlan.refused, targets: st.lastPlan.targets, counts: st.lastPlan.counts, executed: st.lastPlan.executed ?? null, executedAt: st.lastPlan.executedAt ?? null },
      openPositions: held.map(p => ({ symbol: p.symbol, entryDay: p.entry_day, exitDay: p.exit_day, fill: p.fill_entry_price })), pnl, lastTune: st.lastTune, lastError,
    };
  }
  function health() {
    if (!db) return { summary: '' };
    try {
      const s = status();
      if (!on()) return { summary: `sandbox strategy: OFF (${LABEL}); strategy ${s.hash ?? 'not loaded'}`, ...s };
      const bits = [`sandbox strategy ${s.hash ?? 'none'} (${LABEL})`, s.killed ? `KILLED: ${s.killed.reason}` : s.dryRun ? 'DRY RUN, no orders sent' : 'live paper orders', `${s.openPositions.length} open`];
      if (s.pnl) bits.push(`P&L ${s.pnl.equityPct.toFixed(2)}% vs SPY ${s.pnl.spyPct === null ? 'n/a' : `${s.pnl.spyPct.toFixed(2)}%`} since ${s.pnl.since}`);
      if (s.strategyError) bits.push(`file refused: ${s.strategyError[0]}`);
      return { summary: bits.join('; '), ...s };
    } catch (err) { return { summary: '', error: String(err.message).slice(0, 200) }; }
  }
    function clearKill() { const s = readState(); s.killed = null; writeState(s); }
  function patchState(fn) { const s = readState(); fn(s); writeState(s); return s; }

  const api = { step, plan, runPlan, status, health, reconcile, readState, patchState, clearKill, loadSeries, membersFor, clockNow, options: o, LABEL };
  const feature = {
    id: 'sandbox',
    async start(ctx) {
      db = ctx.db; stopping = false;
      try { store.load(); } catch (err) { emit('warn', 'sandbox: strategy file could not be loaded', { message: err.message }); }
      if (o.autoRun) {
        const loop = () => {
          if (stopping) return;
          step().catch(err => emit('warn', 'sandbox step failed', { message: err.message })).finally(() => {
            if (stopping) return;
            const c = clockNow(now()), open = c && c.minSinceOpen >= -5 && c.minSinceClose <= 120;
            timer = setTimeout(loop, open ? o.tickOpenMs : o.tickClosedMs); timer.unref?.();
          });
        };
        startTimer = setTimeout(loop, o.startDelayMs); startTimer.unref?.();
      }
    },
    async stop() { stopping = true; clearTimeout(startTimer); clearTimeout(timer); startTimer = timer = null; },
    health,
  };
  return { feature, api };
}

module.exports = { createSandbox, LABEL, SOURCE, PLAN_AFTER_CLOSE_MIN, EXEC_WINDOW_MIN };
