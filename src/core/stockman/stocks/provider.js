// The stock data port. Everything above this file (service, features) speaks only these shapes, so a provider can be swapped or mocked.
//
// StockProvider = {
//   name: string,
//   capabilities: { ranges: string[], intervals: string[] },   // what getHistory accepts; the service rejects anything else up front
//   getQuote(symbol, opts?)   → Quote
//   getHistory(req, opts?)    → History          req = { symbol, range, interval }
// }
// opts = { ttlMs?, signal? }. Providers throw only the classes in ../errors.js (NotFoundError, RateLimitError, TransientError, ...).
//
// Quote   = { symbol, price, currency, asOf, fetchedAt, source, stale, ageMs, exchange?, volume? }
//             asOf: ms epoch of the provider's own timestamp for the price; fetchedAt: ms epoch we got it.
//             stale: true when the provider could not be reached and an older cached answer is returned (ageMs says how old).
//             Nothing here claims "real time": how delayed asOf is stays unmeasured until the market-hours check (vault CL-0008).
// History = { symbol, currency, range, interval, source, fetchedAt, stale, ageMs, bars: Bar[], skipped }
// Bar     = { t, open, high, low, close, adjClose, volume }    t: ms epoch of the bar start; adjClose may be null
//             skipped: bars the provider returned with no close (it does this for gaps); counted, never filled in.
const { InvalidRequestError, ProviderDataError } = require('../errors');

const SYMBOL = /^[A-Z0-9]{1,6}([.-][A-Z0-9]{1,2})?$/;

// canonical form: upper case, share-class dot as written by the index lists (BRK.B). Providers map it to their own spelling.
function normalizeSymbol(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!SYMBOL.test(s)) throw new InvalidRequestError(`not a valid ticker symbol: ${JSON.stringify(String(raw).slice(0, 20))}`);
  return s;
}

function assertProvider(p) {
  const bad = [];
  if (!p || typeof p !== 'object') bad.push('an object');
  else {
    if (typeof p.name !== 'string' || !p.name) bad.push('name');
    if (typeof p.getQuote !== 'function') bad.push('getQuote()');
    if (typeof p.getHistory !== 'function') bad.push('getHistory()');
    if (!p.capabilities || !Array.isArray(p.capabilities.ranges) || !Array.isArray(p.capabilities.intervals)) bad.push('capabilities { ranges, intervals }');
  }
  if (bad.length) throw new TypeError(`not a StockProvider, missing: ${bad.join(', ')}`);
  return p;
}

const finite = v => typeof v === 'number' && Number.isFinite(v);
const sane = ms => finite(ms) && ms > 946684800000 && ms < 4102444800000;   // 2000-01-01 .. 2100-01-01

// A provider's output is checked before anything trusts it: wrong data is a ProviderDataError, never a silent number.
function checkQuote(q, who = 'provider') {
  if (!q || typeof q.symbol !== 'string') throw new ProviderDataError(`${who}: quote has no symbol`);
  if (!finite(q.price) || q.price <= 0) throw new ProviderDataError(`${who}: bad price for ${q.symbol}`);
  if (!sane(q.asOf)) throw new ProviderDataError(`${who}: bad timestamp for ${q.symbol}`);
  if (typeof q.currency !== 'string' || !q.currency) throw new ProviderDataError(`${who}: no currency for ${q.symbol}`);
  return q;
}

function checkHistory(h, who = 'provider') {
  if (!h || !Array.isArray(h.bars)) throw new ProviderDataError(`${who}: history has no bars`);
  let prev = 0;
  for (const b of h.bars) {
    if (!sane(b.t) || b.t <= prev) throw new ProviderDataError(`${who}: bars are not in strictly rising time order`);
    prev = b.t;
    for (const k of ['open', 'high', 'low', 'close']) if (!finite(b[k]) || b[k] <= 0) throw new ProviderDataError(`${who}: bad ${k} in a bar of ${h.symbol}`);
    if (b.high < b.low) throw new ProviderDataError(`${who}: high below low in a bar of ${h.symbol}`);
    if (b.adjClose !== null && !finite(b.adjClose)) throw new ProviderDataError(`${who}: bad adjClose in a bar of ${h.symbol}`);
    if (!finite(b.volume) || b.volume < 0) throw new ProviderDataError(`${who}: bad volume in a bar of ${h.symbol}`);
  }
  return h;
}

module.exports = { normalizeSymbol, assertProvider, checkQuote, checkHistory, SYMBOL };
