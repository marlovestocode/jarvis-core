// The stock service: the only thing features call. Wraps any StockProvider with input checks, the resilience guard
// (rate limit, breaker, retry, deadline), output checks and logging. It adds no analysis, scoring or advice: data in, data out.
//   getQuote(symbol, opts?) → Quote
//   getQuotes(symbols, opts?) → [{ symbol, ok: true, quote } | { symbol, ok: false, error: { code, message } }]   one bad symbol never aborts the rest
//   getHistory({ symbol, range, interval }, opts?) → History
//   status() → { provider, breaker, limiter, calls, failures, lastOkAt, lastError }
const { InvalidRequestError, StockmanError } = require('../errors');
const { assertProvider, normalizeSymbol, checkQuote, checkHistory } = require('./provider');

const MAX_BATCH = 600;   // a little above the 518-symbol universe measured on 2026-11-14

function createStockService({ provider, guard, log, now = Date.now }) {
  assertProvider(provider);
  if (!guard || typeof guard.run !== 'function') throw new TypeError('createStockService needs a guard (resilience.createGuard)');
  const stats = { calls: 0, failures: 0, lastOkAt: null, lastError: null };

  async function call(label, fn) {
    stats.calls++;
    const t0 = now();
    try {
      const out = await guard.run(label, fn);
      stats.lastOkAt = now();
      log?.debug(`${label} ok`, { ms: now() - t0 });
      return out;
    } catch (err) {
      stats.failures++;
      const known = err instanceof StockmanError;
      // a missing symbol or a bad request is the caller's problem, not an incident
      const level = known && (err.code === 'NOT_FOUND' || err.code === 'INVALID_REQUEST') ? 'info' : 'warn';
      if (level === 'warn') stats.lastError = { at: now(), code: err.code || 'UNKNOWN', message: String(err.message).slice(0, 300) };
      log?.[level](`${label} failed`, { code: err.code || 'UNKNOWN', message: err.message, ms: now() - t0 });
      throw err;
    }
  }

  return {
    async getQuote(symbol, opts = {}) {
      const s = normalizeSymbol(symbol);
      return call(`quote ${s}`, () => provider.getQuote(s, opts).then(q => checkQuote(q, provider.name)));
    },

    async getQuotes(symbols, opts = {}) {
      if (!Array.isArray(symbols) || !symbols.length) throw new InvalidRequestError('getQuotes needs a non-empty array of symbols');
      if (symbols.length > MAX_BATCH) throw new InvalidRequestError(`getQuotes takes at most ${MAX_BATCH} symbols`);
      const unique = [...new Set(symbols.map(normalizeSymbol))];
      const out = [];
      for (const symbol of unique) {   // one at a time: the rate limiter paces them, and a tripped breaker fails the rest fast
        try { out.push({ symbol, ok: true, quote: await this.getQuote(symbol, opts) }); } catch (err) { out.push({ symbol, ok: false, error: { code: err.code || 'UNKNOWN', message: String(err.message).slice(0, 300) } }); }
      }
      return out;
    },

    async getHistory(req, opts = {}) {
      if (!req || typeof req !== 'object') throw new InvalidRequestError('getHistory needs { symbol, range, interval }');
      const symbol = normalizeSymbol(req.symbol);
      const { range, interval } = req;
      if (!provider.capabilities.ranges.includes(range)) throw new InvalidRequestError(`range ${JSON.stringify(range)} is not offered by ${provider.name}; use one of ${provider.capabilities.ranges.join(', ')}`);
      if (!provider.capabilities.intervals.includes(interval)) throw new InvalidRequestError(`interval ${JSON.stringify(interval)} is not offered by ${provider.name}; use one of ${provider.capabilities.intervals.join(', ')}`);
      return call(`history ${symbol} ${range}/${interval}`, () => provider.getHistory({ symbol, range, interval }, opts).then(h => checkHistory(h, provider.name)));
    },

    status: () => ({ provider: provider.name, breaker: guard.breaker.state(), limiter: guard.limiter.state(), ...stats }),
  };
}

module.exports = { createStockService, MAX_BATCH };
