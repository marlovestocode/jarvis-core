// The framework's own jarvis tools: read-only health. Feature tools are added by features (see app.use in ../app.js).
// Tool contract (src/core/tools/registry.js): { name, description, params (JSON Schema), run(args, ctx) → string, risk?, effect?, hint?, examples?, untrusted? }
// Not marked untrusted: the text is built from StockMan's own state, no web text in it (vault D11).
const ago = ms => (ms < 60000 ? `${Math.max(0, Math.round(ms / 1000))} s` : ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 3600000)} h`);

function describeHealth(h, now = Date.now()) {
  if (!h.started) {
    const p = h.process;   // only present when the engine runs as its own process (process.js)
    return p && p.state !== 'stopped' ? `StockMan engine is ${p.state}${p.failReason ? ` (${p.failReason})` : ''}.` : 'StockMan is not started.';
  }
  const parts = [`StockMan framework: database ${h.db.ok ? `ok (schema v${h.db.version})` : 'NOT ok'}`];
  if (h.process?.restarts > 0) parts.push(`engine restarted ${h.process.restarts} time${h.process.restarts === 1 ? '' : 's'}`);
  const s = h.stocks;
  parts.push(`stock data from ${s.provider}, circuit ${s.breaker.state}`);
  parts.push(`${s.calls} call${s.calls === 1 ? '' : 's'}, ${s.failures} failed${s.lastOkAt ? `, last success ${ago(now - s.lastOkAt)} ago` : ', none succeeded yet'}`);
  if (s.lastError) parts.push(`last error: ${s.lastError.message}`);
  if (h.features.length) parts.push(`features: ${h.features.join(', ')}`);
  return parts.join('; ') + '.';
}

function createStockmanTools({ stockman }) {
  return [{
    name: 'stockman_status', risk: 'safe', effect: 'read',
    examples: ['is stockman working', 'stockman status'],
    hint: 'stockman_status: health of the StockMan backend (database, stock data provider). Plumbing only: it has no prices or advice.',
    description: 'Report whether the StockMan backend framework is running: database state, stock data provider, circuit breaker and recent errors.',
    params: { type: 'object', properties: {}, additionalProperties: false },
    async run() { return describeHealth(stockman.health()); },
  }];
}

module.exports = { createStockmanTools, describeHealth };
