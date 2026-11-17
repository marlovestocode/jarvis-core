// Yahoo chart adapter: the unofficial, undocumented endpoint probed on 2026-11-14 (vault notes 04 D8, 05).
//   GET https://query1.finance.yahoo.com/v8/finance/chart/<SYMBOL>?range=<range>&interval=<interval>
// Response shape CONFIRMED by a live call on 2026-11-17 (AAPL, range=5d, interval=1d):
//   chart.result[0].meta { symbol, currency, exchangeName, regularMarketPrice, regularMarketTime (seconds), regularMarketVolume, validRanges[] }
//   chart.result[0].timestamp[] (seconds) and indicators.quote[0].{open,high,low,close,volume}[], indicators.adjclose[0].adjclose[]
// Also confirmed live on 2026-11-17: quote via range=1d&interval=1d; an unknown symbol answers HTTP 404 (mapped to NotFoundError).
// NOT confirmed: the JSON error body for an unknown symbol (jarvis's fetcher drops the body of a non-2xx answer, so the
// chart.error branch below is untested against the real service); intervals other than 1d and 1m; the 429 rate-limit
// threshold (a burst of probes did trigger HTTP 429 on 2026-11-17, so limits exist; the default pacing is the vault's 150 ms sweep);
// quote delay (vault CL-0008: needs a trading day); any behaviour during US market hours.
// It is unofficial: it can change or vanish, which is why this sits behind the StockProvider port and the breaker (vault G16).
// It goes out through jarvis's fetcher (policy check, timeout, size cap, stale cache): the `http` port below.
const { NotFoundError, PolicyError, RateLimitError, TransientError, ProviderDataError } = require('../errors');
const { normalizeSymbol, checkQuote, checkHistory } = require('./provider');

const BASE = 'https://query1.finance.yahoo.com';    // exact host in src/core/net/policy.js BASE_HOSTS
const RANGES = Object.freeze(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);   // meta.validRanges, as returned
const INTERVALS = Object.freeze(['1m', '1d']);       // the two used and seen working in the vault probes; others unverified, so not offered

// Yahoo writes the share-class separator as a dash (BRK.B → BRK-B); vault note 05
const toYahooSymbol = s => s.replace('.', '-');

// http port: { getJson(url, { ttlMs }) → { data, cached, stale?, ageMs, error? } }. createFetcherHttp adapts jarvis's fetcher.
function createFetcherHttp({ fetcher, source = 'finance' }) {
  return { getJson: (url, opts) => fetcher.getJson(source, url, opts) };
}

// the fetcher throws plain Errors with these messages (src/core/net/fetcher.js); classify them
function mapHttpError(err, host = 'provider') {
  const msg = String(err?.message || err);
  if (err?.code === 'REFUSED') return new PolicyError(msg, { cause: err });
  const m = /HTTP (\d{3})/.exec(msg);
  if (m) {
    const status = Number(m[1]);
    if (status === 404) return new NotFoundError(`${host}: not found (HTTP 404)`, { cause: err });
    if (status === 429) return new RateLimitError(`${host}: rate limited (HTTP 429)`, { cause: err });
    if (status >= 500) return new TransientError(`${host}: server error (HTTP ${status})`, { cause: err });
    return new ProviderDataError(`${host}: refused the request (HTTP ${status})`, { cause: err });
  }
  if (/timed out|could not reach|ECONN|ETIMEDOUT|EAI_AGAIN|fetch failed|socket/i.test(msg)) return new TransientError(`${host}: ${msg}`, { cause: err });
  if (/bad JSON|too large|too many redirects|redirect/i.test(msg)) return new ProviderDataError(`${host}: ${msg}`, { cause: err });
  return new ProviderDataError(`${host}: unexpected failure: ${msg}`, { cause: err });
}

function createYahooProvider({ http, now = Date.now, baseUrl = BASE } = {}) {
  if (!http || typeof http.getJson !== 'function') throw new TypeError('createYahooProvider needs an http port: { getJson(url, opts) }');

  async function chart(symbol, range, interval, opts = {}) {
    const url = `${baseUrl}/v8/finance/chart/${encodeURIComponent(toYahooSymbol(symbol))}?range=${range}&interval=${interval}`;
    let r;
    try { r = await http.getJson(url, { ttlMs: opts.ttlMs ?? 0 }); } catch (err) { throw mapHttpError(err, 'yahoo'); }
    const chartBody = r?.data?.chart;
    if (!chartBody || typeof chartBody !== 'object') throw new ProviderDataError('yahoo: response has no "chart" object');
    if (chartBody.error) {
      const code = String(chartBody.error.code || ''), text = String(chartBody.error.description || code || 'error');
      if (/not found/i.test(code)) throw new NotFoundError(`yahoo: no data for ${symbol}`);
      throw new ProviderDataError(`yahoo: ${text.slice(0, 160)}`);
    }
    const result = chartBody.result?.[0];
    if (!result || typeof result.meta !== 'object') throw new ProviderDataError(`yahoo: no result for ${symbol}`);
    return { result, stale: r.stale === true, ageMs: Number(r.ageMs) || 0 };
  }

  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  return {
    name: 'yahoo',
    capabilities: { ranges: [...RANGES], intervals: [...INTERVALS] },

    async getQuote(rawSymbol, opts) {
      const symbol = normalizeSymbol(rawSymbol);
      const { result, stale, ageMs } = await chart(symbol, '1d', '1d', opts);
      const m = result.meta;
      const price = num(m.regularMarketPrice), at = num(m.regularMarketTime);
      if (price === null || at === null) throw new ProviderDataError(`yahoo: quote for ${symbol} has no price or time`);
      const q = { symbol, price, currency: String(m.currency || ''), asOf: at * 1000, fetchedAt: now(), source: 'yahoo', stale, ageMs };
      if (typeof m.exchangeName === 'string') q.exchange = m.exchangeName;
      if (num(m.regularMarketVolume) !== null) q.volume = m.regularMarketVolume;
      return checkQuote(q, 'yahoo');
    },

    async getHistory({ symbol: rawSymbol, range, interval }, opts) {
      const symbol = normalizeSymbol(rawSymbol);
      const { result, stale, ageMs } = await chart(symbol, range, interval, opts);
      const ts = result.timestamp, q = result.indicators?.quote?.[0], adj = result.indicators?.adjclose?.[0]?.adjclose;
      if (ts === undefined && q === undefined) return checkHistory({ symbol, currency: String(result.meta.currency || ''), range, interval, source: 'yahoo', fetchedAt: now(), stale, ageMs, bars: [], skipped: 0 }, 'yahoo');
      if (!Array.isArray(ts) || !q || ![q.open, q.high, q.low, q.close, q.volume].every(Array.isArray)) throw new ProviderDataError(`yahoo: history for ${symbol} is not in the expected shape`);
      const bars = []; let skipped = 0;
      for (let i = 0; i < ts.length; i++) {
        const o = num(q.open[i]), h = num(q.high[i]), l = num(q.low[i]), c = num(q.close[i]), v = num(q.volume[i]);
        if (o === null || h === null || l === null || c === null || v === null) { skipped++; continue; }
        bars.push({ t: ts[i] * 1000, open: o, high: h, low: l, close: c, adjClose: Array.isArray(adj) ? num(adj[i]) : null, volume: v });
      }
      const h = { symbol, currency: String(result.meta.currency || ''), range, interval, source: 'yahoo', fetchedAt: now(), stale, ageMs, bars, skipped };
      const name = result.meta.longName || result.meta.shortName;   // seen live 2026-11-17 (AAPL, SPY); used only for a ticker-reuse check
      if (typeof name === 'string' && name) h.name = name.slice(0, 120);
      return checkHistory(h, 'yahoo');
    },
  };
}

module.exports = { createYahooProvider, createFetcherHttp, mapHttpError, toYahooSymbol, RANGES, INTERVALS, BASE };
