'use strict';
// StockMan → cortex writer (vault D30, CL-0050). Runs in jarvis's main process, outside any conversational turn.
//
// On every `trade-closed` event from the engine (and once at start) it asks the engine for closed paper trades after the last one it
// stored (cortex meta `stockman.lastTradeId`) and, for each, in one cortex transaction:
//   - upserts entity nodes `stock:SYMBOL` and `strategy:BUILD` (text from a template, never from a model),
//   - adds one event of kind `trade` on the instrument node, carrying the ledger's numbers,
//   - links strategy → instrument with edge type `traded` (a win grows it), and on a loss weakens that one edge at once,
//   - advances the stored id.
// The source is kind `tool`, ref `stockman-engine`, and the writes pass tainted: false legitimately: the writer reads no outside text,
// only the engine's ledger (D11, G12). Idempotent: the id moves inside the same transaction as the writes, so a crash replays at most
// what was not committed, and a re-run writes nothing twice.

const META_KEY = 'stockman.lastTradeId';
const SOURCE_REF = 'stockman-engine';
const pct = x => (x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : (x * 100).toFixed(2) + '%');
// six decimals: enough for a return, and no long digit run (the cortex refuses 13+ digits in a row as a possible card number)
const r6 = x => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6);
const SYMBOL_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const BUILD_RE = /^[A-Za-z0-9._\-/]{1,60}$/;

function createCortexWriter({ cortex, request, bus = null, log = () => {}, retryMs = 30_000 } = {}) {
  if (!cortex || typeof request !== 'function') throw new Error('cortex writer needs cortex and request');
  let busy = false, again = false, sourceId = null, off = null, retryTimer = null, stopped = false;

  function source() {
    if (sourceId) return sourceId;
    sourceId = cortex.source.find({ kind: 'tool', ref: SOURCE_REF }) || cortex.source.add({ kind: 'tool', ref: SOURCE_REF, title: 'StockMan engine (paper trades)' });
    return sourceId;
  }

  function valid(t) {
    return t && Number.isInteger(t.positionId) && t.positionId > 0 && SYMBOL_RE.test(String(t.symbol || '')) && BUILD_RE.test(String(t.build || ''))
      && [t.netReturn, t.grossReturn].every(v => v === null || Number.isFinite(v));
  }

  function writeOne(t) {
    const src = source();
    const stock = cortex.node.upsert({ kind: 'entity', key: `stock:${t.symbol}`, text: `${t.symbol} (stock, traded by StockMan on paper)`, source: src, tainted: false, importance: 0.3 });
    const strat = cortex.node.upsert({ kind: 'entity', key: `strategy:${t.build}`, text: `StockMan paper strategy ${t.build}`, source: src, tainted: false, importance: 0.3 });
    cortex.event.add({ kind: 'trade', nodeId: stock.id, payload: {
      positionId: t.positionId, source: t.source, build: t.build, symbol: t.symbol, runId: t.runId ?? null, candidateId: t.candidateId ?? null,
      entryDay: t.entryDay, exitDay: t.exitDay, grossReturn: r6(t.grossReturn), netReturn: r6(t.netReturn), benchmarkReturn: r6(t.benchmarkReturn),
      excessReturn: r6(t.excessReturn), win: t.win,
    } });
    // a win (or an unknown result) grows the edge; a loss only weakens it (creating it first if this pair never traded, so the loss is recorded)
    if (t.win === false) {
      if (!cortex.weakenEdge(strat.id, stock.id, 'traded')) { cortex.link(strat.id, stock.id, 'traded'); cortex.weakenEdge(strat.id, stock.id, 'traded'); }
    } else cortex.link(strat.id, stock.id, 'traded');
    cortex.meta.set(META_KEY, String(t.positionId));
    return `${t.symbol} ${t.build}: net ${pct(t.netReturn)}, vs SPY ${pct(t.excessReturn)}`;
  }

  // replay everything after the stored id; returns how many trades were written
  async function sync() {
    if (busy) { again = true; return 0; }
    busy = true;
    let written = 0;
    try {
      do {
        again = false;
        for (;;) {
          const since = Number(cortex.meta.get(META_KEY) || 0) || 0;
          const batch = await request('closedTrades', { sinceId: since, limit: 200 });
          if (!Array.isArray(batch) || batch.length === 0) break;
          for (const t of batch) {
            if (!valid(t) || t.positionId <= since) { log(`stockman cortex: skipped a malformed trade row (${String(t?.positionId)})`); cortex.meta.set(META_KEY, String(Math.max(since, Number(t?.positionId) || since))); continue; }
            cortex.transaction(() => writeOne(t));
            written++;
          }
          if (batch.length < 200) break;
        }
      } while (again);
    } catch (err) {
      log(`stockman cortex: sync failed: ${err.message}`);
      // the engine's start events reach jarvis before the supervisor marks it running (seen live, CL-0083): try once more a little later
      if (!retryTimer && !stopped) { retryTimer = setTimeout(() => { retryTimer = null; sync(); }, retryMs); retryTimer.unref?.(); }
    } finally { busy = false; }
    if (written) log(`stockman cortex: wrote ${written} closed paper trade(s)`);
    return written;
  }

  function start() {
    if (bus && typeof bus.on === 'function') {
      off = bus.on('stockman', e => { if (e && (e.topic === 'trade-closed' || e.topic === 'ready')) sync(); });
    }
    return sync();
  }
  function stop() { stopped = true; clearTimeout(retryTimer); retryTimer = null; try { if (typeof off === 'function') off(); } catch { /* bus gone */ } off = null; }

  return { start, stop, sync, META_KEY, SOURCE_REF };
}

module.exports = { createCortexWriter, META_KEY, SOURCE_REF };
