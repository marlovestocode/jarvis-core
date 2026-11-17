// A StockProvider that never touches the network: for tests, for running the framework offline, and as the reference for what a
// provider must do. Data is whatever the caller supplies; nothing here is a real price.
//   createMockProvider({ quotes: { AAPL: 100 }, bars: { AAPL: [Bar,...] }, now })
//   mock.failNext(error, times = 1)   the next calls throw `error` (use the classes in ../errors)
//   mock.calls                        every call made, in order: { method, args }
const { NotFoundError } = require('../errors');
const { normalizeSymbol, checkQuote, checkHistory } = require('./provider');

function createMockProvider({ quotes = {}, bars = {}, currency = 'USD', now = Date.now, ranges = ['1d', '5d', '1mo'], intervals = ['1d'] } = {}) {
  const calls = [];
  let failure = null;   // { error, left }
  function maybeFail() { if (failure && failure.left > 0) { failure.left--; throw failure.error; } }
  return {
    name: 'mock',
    capabilities: { ranges, intervals },
    calls,
    failNext(error, times = 1) { failure = { error, left: times }; },
    async getQuote(rawSymbol) {
      calls.push({ method: 'getQuote', args: [rawSymbol] });
      maybeFail();
      const symbol = normalizeSymbol(rawSymbol);
      if (!(symbol in quotes)) throw new NotFoundError(`mock: no quote for ${symbol}`);
      return checkQuote({ symbol, price: quotes[symbol], currency, asOf: now(), fetchedAt: now(), source: 'mock', stale: false, ageMs: 0 }, 'mock');
    },
    async getHistory(req) {
      calls.push({ method: 'getHistory', args: [req] });
      maybeFail();
      const symbol = normalizeSymbol(req.symbol);
      if (!(symbol in bars)) throw new NotFoundError(`mock: no history for ${symbol}`);
      return checkHistory({ symbol, currency, range: req.range, interval: req.interval, source: 'mock', fetchedAt: now(), stale: false, ageMs: 0, bars: bars[symbol], skipped: 0 }, 'mock');
    },
  };
}

module.exports = { createMockProvider };
