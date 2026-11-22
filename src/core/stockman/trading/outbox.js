'use strict';
// Trade outbox (vault D30, CL-0050): tells jarvis when paper positions close, so its cortex writer can record them.
//
// The ledger is the one record. This feature only watches it: every tick it looks for closed paper positions (paper-internal or
// broker-paper; backtest rows never) with an id above the last one it announced, publishes one `trade-closed` event with the newest id,
// and asks calibration to recalculate at once instead of waiting for its own timer (a loss shows in calibration now, not in 5 minutes).
// jarvis's writer does not trust the event's content: it asks `closedTrades(sinceId)` and replays from the ledger, so a missed event, a
// closed app or a crashed writer loses nothing and writes nothing twice. No table, no migration, no network, no model.

const LIVE_SOURCES = ['paper-internal', 'broker-paper'];

function createTradeOutbox({ publish = () => {}, calibration = null, opts = {} } = {}) {
  const o = { tickMs: 60_000, autoRun: true, ...opts };
  let db = null, log = null, timer = null, lastSeen = null;

  // closed live paper trades after `sinceId`, oldest first. Numbers come from the ledger only (rule 7: no model writes a number).
  function closedTrades({ sinceId = 0, limit = 200 } = {}) {
    if (!db) return [];
    const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
    return db.stmt(`SELECT id, source, run_id, scoring_build, symbol, signal_day, entry_day, exit_day, fill_entry_price, fill_exit_price,
                           gross_return, cost_bps, net_return, benchmark_return, note, closed_at
                    FROM paper_position WHERE status = 'closed' AND source IN ('paper-internal','broker-paper') AND id > ?
                    ORDER BY id LIMIT ?`).all(Math.max(0, Number(sinceId) || 0), lim)
      .map(r => {
        const candidate = /candidate=([^\s;]+)/.exec(r.note || '')?.[1] ?? null;
        const excess = r.net_return !== null && r.benchmark_return !== null ? r.net_return - r.benchmark_return : null;
        return {
          positionId: r.id, source: r.source, runId: r.run_id, candidateId: candidate, build: r.scoring_build, symbol: r.symbol,
          signalDay: r.signal_day, entryDay: r.entry_day, exitDay: r.exit_day, entryPrice: r.fill_entry_price, exitPrice: r.fill_exit_price,
          grossReturn: r.gross_return, costBps: r.cost_bps, netReturn: r.net_return, benchmarkReturn: r.benchmark_return,
          excessReturn: excess, win: excess === null ? null : excess > 0, closedAt: r.closed_at,
        };
      });
  }

  function newestId() {
    return db ? Number(db.stmt("SELECT COALESCE(MAX(id), 0) AS n FROM paper_position WHERE status = 'closed' AND source IN ('paper-internal','broker-paper')").get().n) : 0;
  }

  async function tick() {
    if (!db) return { status: 'off' };
    const n = newestId();
    if (lastSeen === null) { lastSeen = n; publish('trade-closed', { newestId: n, startup: true }); return { status: 'startup', newestId: n }; }
    if (n <= lastSeen) return { status: 'idle', newestId: n };
    lastSeen = n;
    publish('trade-closed', { newestId: n });
    if (calibration?.step) { try { await calibration.step(); } catch (err) { log?.warn('calibration after a close failed', { message: err.message }); } }
    return { status: 'announced', newestId: n };
  }

  const api = { closedTrades, tick, LIVE_SOURCES };
  const feature = {
    id: 'outbox',
    async start(ctx) {
      db = ctx.db; log = ctx.log; lastSeen = null;
      if (o.autoRun) {
        tick().catch(err => log?.warn('trade outbox failed', { message: err.message }));
        timer = setInterval(() => tick().catch(err => log?.warn('trade outbox failed', { message: err.message })), o.tickMs); timer.unref?.();
      }
    },
    async stop() { clearInterval(timer); timer = null; },
  };
  return { feature, api };
}

module.exports = { createTradeOutbox, LIVE_SOURCES };
