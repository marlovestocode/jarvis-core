// Feature "broker-router" (vault D23, CL-0068): sends the paper opener's baskets to the user's Alpaca PAPER account as real paper orders, so the
// fills carry real slippage and timing, and writes the fills back into the ledger as source 'broker-paper'. Paper money only (trading/alpaca.js has
// no live host). OFF unless BOTH paperTrading.enabled and broker.enabled are on (and online.broker, and the paper keys in the environment).
//   per tick (every minute while the US market is open, every 5 minutes otherwise):
//   1. RECONCILE  poll the paper account's recent orders; filled ones go to the ledger through the subscribe-only fill port (a repeat is stored once).
//   2. ENTER      in the first ENTRY_WINDOW_MIN minutes after the open: for each in-basket shadow candidate whose entry day is today, was logged
//                 before its entry session (not `late`) and is after the backtest holdout, open a broker-paper ledger position and send ONE
//                 market `day` order for notional USD (capital / 5 sleeves / basket size, capped by broker.maxNotionalUsd). A day jarvis was not
//                 running at the open is never traded afterwards (same honest-start rule as the internal opener).
//   3. EXIT       from EXIT_FROM_MIN_BEFORE_CLOSE to the close minus 2 minutes on the exit day (or in the first minutes of any later session
//                 for one that was missed): ONE market `day` sell for the quantity actually bought. The backtest exits at the closing price;
//                 this sells a few minutes before the close, and the fill's difference is recorded, not hidden.
//   4. CLOSE      a position with both fills is closed in the ledger with no extra cost (the fills already contain the slippage) and the SPY
//                 return over the same dates.
//   Idempotent: the client order id is sm-<positionId>-<leg>, a repeated send returns the existing order, and every step re-reads the ledger.
//   Limits: market orders on a paper account fill at simulated prices; notional (fractional) orders are `day` market orders only; at most
//   MAX_OPEN open positions. Nothing here is advice and no result is a prediction.
const { nyDate, nyWallToMs } = require('../features/ny-time');
const { dayInfo, isTradingDay } = require('../features/calendar-rules');
const { StockmanError, PolicyError } = require('../errors');
const { createAlpacaFillPort } = require('./alpaca');

const SOURCE = 'broker-paper';
const ENTRY_WINDOW_MIN = 30, EXIT_FROM_MIN_BEFORE_CLOSE = 15, EXIT_UNTIL_MIN_BEFORE_CLOSE = 2, MAX_OPEN = 200;

function createBrokerRouter({ ledger, shadow, scoring, alpaca, now = Date.now, opts = {} } = {}) {
  for (const [n, x] of Object.entries({ ledger, shadow, scoring, alpaca })) if (!x) throw new TypeError(`broker router needs the ${n}`);
  const o = { enabled: false, capitalUsd: 20000, benchmark: 'SPY', tickOpenMs: 60000, tickClosedMs: 5 * 60000, startDelayMs: 15000, autoRun: true, ...opts };
  const ledgerBuild = `${scoring.build}/L5/vol`;
  let db = null, log = null, stopping = false, busy = false, timer = null, startTimer = null, port = null, off = null, last = null;

  const need = () => { if (!db) throw new StockmanError('broker router: not started'); return db; };
  const orderOf = p => { const m = /\border=(\S+)/.exec(p.note || ''); return m ? m[1] : null; };
  const exitOrderOf = p => { const m = /\bexit=(\S+)/.exec(p.note || ''); return m ? m[1] : null; };
  const noteSet = (p, add) => { const n = `${(p.note || '').trim()} ${add}`.trim(); ledger.annotate(p.id, n); p.note = n; };
  const barOn = (symbol, day) => need().stmt('SELECT open, close, adj_close AS adj FROM bar WHERE symbol = ? AND day = ?').get(symbol, day) || null;
  const usable = b => b && [b.open, b.close, b.adj].every(x => typeof x === 'number' && Number.isFinite(x) && x > 0);
  const notionalFor = basketSize => Math.min(alpaca.options.maxNotionalUsd, Math.round((o.capitalUsd / 5 / Math.max(1, basketSize)) * 100) / 100);

  // where "now" sits in today's session: { day, open, close, minSinceOpen, minToClose } or null on a closed day
  function clockNow(t) {
    const day = nyDate(t);
    if (!isTradingDay(day)) return null;
    const i = dayInfo(day);
    const openMs = nyWallToMs(day, i.open), closeMs = nyWallToMs(day, i.close);
    return { day, openMs, closeMs, minSinceOpen: (t - openMs) / 60000, minToClose: (closeMs - t) / 60000 };
  }

  async function reconcile(t) {
    const after = new Date(t - 9 * 86400000).toISOString();
    const orders = await alpaca.listOrders({ status: 'all', after });
    return { seen: orders.length, delivered: port.deliverFilled(orders) };
  }

  async function enter(c, t) {
    const d = need();
    const rows = d.stmt(`SELECT c.candidate_id AS id, c.run_id AS runId, c.day, c.symbol, c.score, c.entry_day AS entryDay, c.exit_day AS exitDay,
        (SELECT COUNT(*) FROM candidate k WHERE k.run_id = c.run_id AND k.scoring_build = c.scoring_build AND k.in_basket = 1) AS basketSize
      FROM candidate c JOIN shadow_day s ON s.day = c.day AND s.scoring_build = c.scoring_build
      WHERE c.scoring_build = ? AND c.in_basket = 1 AND c.entry_day = ? AND c.day > ? AND s.late = 0 ORDER BY c.rank`).all(scoring.build, c.day, shadow.HOLDOUT_END);
    const res = { candidates: rows.length, opened: 0, sent: 0, failed: 0 };
    const openNow = Number(d.stmt("SELECT COUNT(*) AS n FROM paper_position WHERE source = ? AND status = 'open'").get(SOURCE).n);
    for (const r of rows) {
      if (stopping) break;
      let p = d.stmt('SELECT * FROM paper_position WHERE source = ? AND run_id = ? AND symbol = ? AND scoring_build = ?').get(SOURCE, r.runId, r.symbol, ledgerBuild);
      if (!p) {
        if (openNow + res.opened >= MAX_OPEN) break;
        const sig = barOn(r.symbol, r.day);
        const id = ledger.open({ source: SOURCE, runId: r.runId, basketId: `${r.runId}/${ledgerBuild}`, sleeve: null, scoringBuild: ledgerBuild, symbol: r.symbol, weight: 1 / r.basketSize, score: r.score, signalDay: r.day, entryDay: r.entryDay, exitDay: r.exitDay,
          expectedEntryPrice: sig && sig.adj > 0 ? sig.adj : null, note: `candidate=${r.id}` });
        p = ledger.getPosition(id); res.opened++;
      }
      if (orderOf(p)) continue;                       // already sent (a restart re-reads the ledger, so it is never sent twice)
      try {
        const ord = await alpaca.placeOrder({ positionId: p.id, leg: 'entry', symbol: p.symbol, notionalUsd: notionalFor(r.basketSize), timeInForce: 'day' });
        noteSet(p, `order=${ord.id}`); res.sent++;
      } catch (err) {
        if (err instanceof PolicyError) throw err;   // switched off or no keys: stop the whole step
        res.failed++; log?.warn?.('broker router: entry order failed', { symbol: p.symbol, message: String(err.message).slice(0, 200) });
      }
    }
    return res;
  }

  async function exit(c) {
    const d = need();
    const open = d.stmt("SELECT * FROM paper_position WHERE source = ? AND status = 'open' AND exit_day <= ? AND fill_entry_price IS NOT NULL ORDER BY id").all(SOURCE, c.day);
    const res = { due: open.length, sent: 0, failed: 0 };
    for (const p of open) {
      if (stopping) break;
      if (exitOrderOf(p)) continue;
      const qty = Number(d.stmt("SELECT SUM(quantity) AS q FROM paper_fill WHERE position_id = ? AND leg = 'entry' AND source = ?").get(p.id, SOURCE).q);
      if (!(qty > 0)) continue;
      try {
        const ord = await alpaca.placeOrder({ positionId: p.id, leg: 'exit', symbol: p.symbol, qty, timeInForce: 'day' });
        noteSet(p, `exit=${ord.id}${p.exit_day < c.day ? ' late-exit' : ''}`); res.sent++;
      } catch (err) {
        if (err instanceof PolicyError) throw err;
        res.failed++; log?.warn?.('broker router: exit order failed', { symbol: p.symbol, message: String(err.message).slice(0, 200) });
      }
    }
    return res;
  }

  function closeFilled() {
    const d = need();
    let n = 0;
    for (const p of d.stmt("SELECT * FROM paper_position WHERE source = ? AND status = 'open' AND fill_entry_price IS NOT NULL AND fill_exit_price IS NOT NULL").all(SOURCE)) {
      const e = barOn(o.benchmark, p.entry_day), x = barOn(o.benchmark, p.exit_day);
      const bench = usable(e) && usable(x) ? x.adj / (e.open * (e.adj / e.close)) - 1 : null;
      try { ledger.close(p.id, { costBps: 0, benchmarkReturn: bench }); n++; } catch (err) { log?.warn?.('broker router: could not close', { id: p.id, message: String(err.message).slice(0, 200) }); }
    }
    return n;
  }

  async function step() {
    if (!db) throw new StockmanError('broker router: not started');
    if (!o.enabled) return { status: 'off' };
    if (busy) return { status: 'busy' };
    busy = true;
    const t = now(), res = { status: 'ok', at: t };
    try {
      const c = clockNow(t);
      try { res.reconcile = await reconcile(t); } catch (err) { if (err instanceof PolicyError) { res.status = 'refused'; res.note = err.message; last = res; return res; } res.reconcile = { error: String(err.message).slice(0, 160) }; }
      if (c) {
        if (c.minSinceOpen >= 0 && c.minSinceOpen <= ENTRY_WINDOW_MIN) res.enter = await enter(c, t);
        const sellWindow = c.minToClose <= EXIT_FROM_MIN_BEFORE_CLOSE && c.minToClose >= EXIT_UNTIL_MIN_BEFORE_CLOSE;
        const lateWindow = c.minSinceOpen >= 0 && c.minSinceOpen <= ENTRY_WINDOW_MIN;   // a missed exit goes out in the first half hour of a later session
        if (sellWindow || lateWindow) res.exit = await exit(c);
      }
      res.closed = closeFilled();
    } catch (err) {
      res.status = err instanceof PolicyError ? 'refused' : 'error'; res.note = String(err.message).slice(0, 200);
      if (res.status === 'error') log?.warn?.('broker router step failed', { message: res.note });
    } finally { busy = false; }
    last = res;
    return res;
  }

  function status() {
    const d = need();
    const by = d.stmt('SELECT status, COUNT(*) AS n FROM paper_position WHERE source = ? GROUP BY status').all(SOURCE).map(r => [r.status, Number(r.n)]);
    return { enabled: o.enabled, positions: Object.fromEntries(by), last: last && { status: last.status, at: last.at, note: last.note ?? null }, capitalUsd: o.capitalUsd };
  }
  function health() {
    if (!db) return { summary: '' };
    try {
      if (!o.enabled) return { summary: 'broker router: OFF (needs paper trading and broker orders both switched on)' };
      const s = status(), p = s.positions;
      return { summary: `broker router (Alpaca paper): ${p.open || 0} open, ${p.closed || 0} closed positions${s.last ? `; last step ${s.last.status}${s.last.note ? ` (${s.last.note})` : ''}` : ''}; paper money only`, ...s };
    } catch (err) { return { summary: '', error: String(err.message).slice(0, 200) }; }
  }

  const api = { step, status, health, options: o, clockNow };
  const feature = {
    id: 'broker-router',
    async start(ctx) {
      db = ctx.db; log = ctx.log; stopping = false;
      port = createAlpacaFillPort();
      off = ledger.attachFillSource(port, { onError: (e, f) => log?.warn?.('broker router: fill not stored', { message: String(e.message).slice(0, 160), fill: f && f.externalId }) });
      if (o.enabled && o.autoRun) {
        const loop = () => {
          if (stopping) return;
          step().catch(err => log?.warn?.('broker router step failed', { message: err.message })).finally(() => {
            if (stopping) return;
            const c = clockNow(now()), open = c && c.minSinceOpen >= -1 && c.minToClose >= 0;
            timer = setTimeout(loop, open ? o.tickOpenMs : o.tickClosedMs); timer.unref?.();
          });
        };
        startTimer = setTimeout(loop, o.startDelayMs); startTimer.unref?.();
      }
    },
    async stop() { stopping = true; clearTimeout(startTimer); clearTimeout(timer); startTimer = timer = null; try { off?.(); } catch { /* gone */ } },
    health,
  };
  return { feature, api };
}

module.exports = { createBrokerRouter, SOURCE, ENTRY_WINDOW_MIN, EXIT_FROM_MIN_BEFORE_CLOSE, MAX_OPEN };
