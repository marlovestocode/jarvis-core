// StockMan: the stock manager backend (vault: Finance/StockMan). Phase one is plumbing only, so this group holds read-only health
// tools; later phases add their tools through app.use(feature) in src/core/stockman/app.js. Without a `stockman` dependency the
// group is left out, like lists without a store. No trading, no advice: see the vault's standing refusals.
const { own } = require('../util');

function createGroup({ stockman } = {}) {
  if (!stockman) return null;
  const status = () => {
    const h = stockman.health();
    return h.started ? { ok: h.db?.ok === true, detail: `database v${h.db?.version}, stock data from ${h.stocks.provider}, circuit ${h.stocks.breaker.state}` } : { ok: false, detail: h.enabled ? 'not started' : 'switched off in StockMan config' };
  };
  return { status, id: 'stockman', label: 'StockMan stock manager backend status', summary: 'Checks whether the StockMan stock manager backend is running. Read-only; no prices, trades or advice yet.', examples: ['is stockman working', 'stockman status'], triggers: [
    { re: /\bstock ?man\b/i, w: 3 },
  ], tools: stockman.tools().map(t => own(t)) };
}

module.exports = { createGroup };
