// Alpaca PAPER broker adapter (vault D23, G22, CL-0062). Paper money only: the only trading host in the code and in the network allowlist is
// paper-api.alpaca.markets (market data: data.alpaca.markets). There is NO live-trading host anywhere; a request to the live host is refused by
// the policy and no code here names it (a test pins both). Live money stays refused (vault D1).
//   switch:   online.broker in jarvis's config (default OFF) through net/policy.js source 'broker', AND config.broker.enabled for the order
//             methods (default OFF). With either off nothing is sent.
//   keys:     ONLY from the environment: ALPACA_PAPER_KEY_ID and ALPACA_PAPER_SECRET_KEY (paper keys differ from live keys, Alpaca docs).
//             Never read from a file, never logged, never put in a URL, redacted from every error message and result.
//   facts verified against Alpaca's docs on 2026-11-17: hosts above; paper trading is free; paper keys differ from live; the `opg`
//             time-in-force exists for market-on-open and an opg order submitted between 9:28 and 19:00 New York time is rejected; the free data
//             plan serves the IEX feed. NOT verified (from memory, no key to try them): the header names APCA-API-KEY-ID and
//             APCA-API-SECRET-KEY, the order fields id, client_order_id, status, filled_avg_price, filled_qty, filled_at, the account fields,
//             and the shape of /v2/stocks/{symbol}/quotes/latest. The first real call with a paper key must confirm them; parsing is defensive.
//   safety:   long-only buys and sells of what a ledger position holds; market orders only; notional capped per order (default USD 1,000);
//             client_order_id = sm-<positionId>-<leg>, so a retry can never place a second order for the same leg (Alpaca rejects a repeated
//             client_order_id and the adapter then looks the order up); fills reach the ledger ONLY through a subscribe-only fill port
//             (ledger.attachFillSource refuses a port that can place orders), so the ledger side cannot send an order.
const { PolicyError, RateLimitError, TransientError, ProviderDataError, InvalidRequestError, NotFoundError, StockmanError } = require('../errors');
const { normalizeSymbol } = require('../stocks/provider');
const { nyDate } = require('../features/ny-time');

const PAPER_BASE = 'https://paper-api.alpaca.markets';
const DATA_BASE = 'https://data.alpaca.markets';
const KEY_ENV = 'ALPACA_PAPER_KEY_ID', SECRET_ENV = 'ALPACA_PAPER_SECRET_KEY';
const SOURCE = 'broker';   // the net policy source (online.broker)
const TIFS = Object.freeze(['day', 'opg', 'cls']);
const MAX_BYTES = 1024 * 1024;

const redact = (s, ...secrets) => secrets.filter(Boolean).reduce((t, x) => String(t).split(x).join('[redacted]'), String(s));

// http: { policy, fetch, env, timeoutMs }. policy.allowed(url, source) is the one gate (allowlist, https only, exact host, online switches).
function createAlpacaHttp({ policy, fetch: doFetch = (...a) => globalThis.fetch(...a), env = process.env, timeoutMs = 8000 } = {}) {
  if (!policy || typeof policy.allowed !== 'function') throw new TypeError('alpaca needs the net policy');
  const keys = () => ({ id: env[KEY_ENV] || '', secret: env[SECRET_ENV] || '' });
  const configured = () => { const k = keys(); return Boolean(k.id && k.secret); };

  async function request(method, base, path, { query = null, body = null } = {}) {
    const k = keys();
    if (!k.id || !k.secret) throw new PolicyError(`alpaca: no paper keys (set ${KEY_ENV} and ${SECRET_ENV} in the environment)`);
    const url = new URL(base + path);
    for (const [name, value] of Object.entries(query || {})) if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    const verdict = policy.allowed(url.href, SOURCE);
    if (!verdict.ok) throw new PolicyError(`alpaca: ${verdict.reason}`);
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res, text;
    try {
      res = await doFetch(url.href, {
        method, redirect: 'manual', signal: ctl.signal,
        headers: { 'APCA-API-KEY-ID': k.id, 'APCA-API-SECRET-KEY': k.secret, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      text = await res.text();
    } catch (err) {
      throw new TransientError(`alpaca: could not reach ${url.hostname}: ${redact(err?.message || err, k.id, k.secret)}`);
    } finally { clearTimeout(timer); }
    if (text.length > MAX_BYTES) throw new ProviderDataError('alpaca: response too large');
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    if (res.status >= 300 && res.status < 400) throw new ProviderDataError(`alpaca: unexpected redirect (HTTP ${res.status}); refused`);
    if (res.status >= 400) {
      const msg = redact(json?.message || text.slice(0, 200), k.id, k.secret);
      if (res.status === 401 || res.status === 403) throw new PolicyError(`alpaca: the paper keys were refused (HTTP ${res.status}): ${msg}`);
      if (res.status === 404) throw new NotFoundError(`alpaca: not found (HTTP 404): ${msg}`);
      if (res.status === 422 || res.status === 400) throw new InvalidRequestError(`alpaca: the request was refused (HTTP ${res.status}): ${msg}`);
      if (res.status === 429) throw new RateLimitError('alpaca: rate limited (HTTP 429)');
      if (res.status >= 500) throw new TransientError(`alpaca: server error (HTTP ${res.status})`);
      throw new ProviderDataError(`alpaca: HTTP ${res.status}: ${msg}`);
    }
    if (json === null) throw new ProviderDataError('alpaca: the answer is not JSON');
    return json;
  }
  return { request, configured, hosts: Object.freeze({ trading: PAPER_BASE, data: DATA_BASE }) };
}

const num = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const pos = v => { const x = num(v); return x !== null && x > 0 ? x : null; };

// opts: { enabled (order methods), maxNotionalUsd, feed }
function createAlpaca({ http, opts = {} } = {}) {
  if (!http) throw new TypeError('alpaca needs an http client');
  const o = { enabled: false, maxNotionalUsd: 1000, feed: 'iex', ...opts };

  // ---- read-only (allowed whenever the broker switch is on) -------------------------------------------------------------------------
  async function account() {
    const a = await http.request('GET', PAPER_BASE, '/v2/account');
    return {
      status: a.status ?? null, currency: a.currency ?? null, buyingPower: num(a.buying_power), cash: num(a.cash), equity: num(a.equity),
      tradingBlocked: Boolean(a.trading_blocked), accountBlocked: Boolean(a.account_blocked),
      // an account number is shown only in part; paper accounts start with PA (not verified)
      number: a.account_number ? `…${String(a.account_number).slice(-4)}` : null,
    };
  }
  async function clock() {
    const c = await http.request('GET', PAPER_BASE, '/v2/clock');
    if (typeof c.is_open !== 'boolean') throw new ProviderDataError('alpaca: the clock answer is not in the expected shape');
    return { isOpen: c.is_open, timestamp: c.timestamp ?? null, nextOpen: c.next_open ?? null, nextClose: c.next_close ?? null };
  }
  // the latest quote (IEX feed on the free plan): { bid, ask, bidSize, askSize, at, spreadBps }
  async function latestQuote(symbol) {
    const s = normalizeSymbol(symbol);
    const r = await http.request('GET', DATA_BASE, `/v2/stocks/${encodeURIComponent(s)}/quotes/latest`, { query: { feed: o.feed } });
    const q = r.quote;
    if (!q || typeof q !== 'object') throw new ProviderDataError('alpaca: the quote answer is not in the expected shape');
    const bid = pos(q.bp), ask = pos(q.ap);
    return { symbol: s, bid, ask, bidSize: num(q.bs), askSize: num(q.as), at: q.t ?? null, spreadBps: bid && ask && ask >= bid ? (ask - bid) / ((ask + bid) / 2) * 1e4 : null };
  }
  // daily bars for one symbol (G24, D32): read-only, for history Yahoo no longer serves (delisted or renamed tickers). The SIP feed holds
  // history of symbols that no longer trade; `adjustment` is 'raw' or 'all' (splits and dividends). Paged; at most 20 pages (about 200,000 bars).
  async function dailyBars(symbol, { start, end, adjustment = 'raw', feed = 'sip' } = {}) {
    const s = normalizeSymbol(symbol);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(end))) throw new TypeError('dailyBars needs start and end as YYYY-MM-DD');
    if (!['raw', 'all', 'split'].includes(adjustment)) throw new TypeError('adjustment is raw, split or all');
    const out = [];
    let pageToken = null;
    for (let page = 0; page < 20; page++) {
      const r = await http.request('GET', DATA_BASE, `/v2/stocks/${encodeURIComponent(s)}/bars`, { query: { timeframe: '1Day', start, end, adjustment, feed, limit: 10000, page_token: pageToken } });
      const rows = Array.isArray(r?.bars) ? r.bars : r?.bars === null || r?.bars === undefined ? [] : null;
      if (rows === null) throw new ProviderDataError('alpaca: the bars answer is not in the expected shape');
      for (const b of rows) {
        const o2 = pos(b.o), h = pos(b.h), l = pos(b.l), c = pos(b.c);
        if (typeof b.t !== 'string' || !o2 || !h || !l || !c || h < l) continue;   // an unusable bar is skipped, never repaired
        out.push({ t: b.t, open: o2, high: h, low: l, close: c, volume: num(b.v) });
      }
      pageToken = r.next_page_token || null;
      if (!pageToken) break;
    }
    return out;
  }
  // the stock's quote midpoint (IEX feed), for the options sampler: throws when there is no two-sided quote
  async function stockMid(symbol) {
    const q = await latestQuote(symbol);
    if (!q.bid || !q.ask) throw new ProviderDataError(`alpaca: no two-sided stock quote for ${q.symbol}`);
    return (q.bid + q.ask) / 2;
  }
  // option snapshots of one underlying (indicative feed): { snapshots: { OCCSYMBOL: {...} }, nextPageToken }. Read-only.
  async function optionSnapshots({ underlying, expiryLte = null, strikeGte = null, strikeLte = null, type = null, pageToken = null, limit = 1000 }) {
    const r = await http.request('GET', DATA_BASE, `/v1beta1/options/snapshots/${encodeURIComponent(normalizeSymbol(underlying))}`, {
      query: { feed: 'indicative', limit, expiration_date_lte: expiryLte, strike_price_gte: strikeGte, strike_price_lte: strikeLte, type, page_token: pageToken } });
    if (!r || typeof r.snapshots !== 'object' || r.snapshots === null || Array.isArray(r.snapshots)) throw new ProviderDataError('alpaca: the option snapshots answer is not in the expected shape');
    return { snapshots: r.snapshots, nextPageToken: r.next_page_token || null };
  }
  // the paper account's open positions (read-only): [{ symbol, qty, marketValue, avgEntry }]
  async function positions() {
    const list = await http.request('GET', PAPER_BASE, '/v2/positions');
    if (!Array.isArray(list)) throw new ProviderDataError('alpaca: the positions answer is not an array');
    return list.map(p => ({ symbol: String(p.symbol), qty: num(p.qty), marketValue: num(p.market_value), avgEntry: num(p.avg_entry_price) }));
  }
  async function getOrder(id) { return mapOrder(await http.request('GET', PAPER_BASE, `/v2/orders/${encodeURIComponent(id)}`)); }
  async function getOrderByClientId(clientOrderId) {
    return mapOrder(await http.request('GET', PAPER_BASE, '/v2/orders:by_client_order_id', { query: { client_order_id: clientOrderId } }));
  }
  async function listOrders({ status = 'all', after = null, limit = 100 } = {}) {
    const list = await http.request('GET', PAPER_BASE, '/v2/orders', { query: { status, after, limit, direction: 'asc' } });
    if (!Array.isArray(list)) throw new ProviderDataError('alpaca: the order list is not an array');
    return list.map(mapOrder);
  }

  // ---- orders (paper only; need config.broker.enabled) -------------------------------------------------------------------------------
  const clientOrderId = (positionId, leg) => `sm-${positionId}-${leg}`;
  // a ledger position (source broker-paper, open) and its leg → one paper order. buy for the entry, sell for the exit; market orders only.
  //   notionalUsd (fractional) or qty (whole shares), one of them; timeInForce: day (default), opg (market on open: must be sent before 9:28 NY) or cls.
  //   clientId (optional): the sandbox strategy's own id (sm-sbx-<day>-<symbol>-<leg>) instead of sm-<positionId>-<leg>.
  //   limitPrice (optional): a limit order at that price; it needs a whole-share qty (a limit order cannot be placed by notional).
  async function placeOrder({ positionId = null, clientId = null, leg, symbol, notionalUsd = null, qty = null, timeInForce = 'day', limitPrice = null }) {
    if (!o.enabled) throw new PolicyError('alpaca: orders are switched off (config.broker.enabled is false)');
    if (clientId !== null) { if (typeof clientId !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(clientId)) throw new InvalidRequestError('alpaca: the client order id has characters or a length Alpaca does not take'); }
    else if (!Number.isInteger(positionId) || positionId < 1) throw new InvalidRequestError('alpaca: a ledger position id is required');
    if (limitPrice !== null && !(pos(limitPrice) && qty !== null && Number.isInteger(qty))) throw new InvalidRequestError('alpaca: a limit order needs a limit price above 0 and a whole-share qty');
    if (leg !== 'entry' && leg !== 'exit') throw new InvalidRequestError('alpaca: leg is entry or exit');
    if (!TIFS.includes(timeInForce)) throw new InvalidRequestError(`alpaca: time in force is one of ${TIFS.join(', ')}`);
    if ((notionalUsd === null) === (qty === null)) throw new InvalidRequestError('alpaca: give notionalUsd or qty, not both and not neither');
    if (notionalUsd !== null && !(pos(notionalUsd) && notionalUsd <= o.maxNotionalUsd)) throw new InvalidRequestError(`alpaca: notional must be above 0 and at most USD ${o.maxNotionalUsd} per order`);
    // fractional shares are allowed (a notional buy fills a fractional quantity, and its exit sells exactly that); a `day` market order only
    if (qty !== null && !(typeof qty === 'number' && Number.isFinite(qty) && qty > 0 && qty < 1e7)) throw new InvalidRequestError('alpaca: qty must be a number above 0');
    if (qty !== null && !Number.isInteger(qty) && timeInForce !== 'day') throw new InvalidRequestError('alpaca: a fractional quantity needs time in force day');
    const s = normalizeSymbol(symbol);
    const cid = clientId !== null ? clientId : clientOrderId(positionId, leg);
    const body = { symbol: s, side: leg === 'entry' ? 'buy' : 'sell', type: limitPrice !== null ? 'limit' : 'market', time_in_force: timeInForce, client_order_id: cid, ...(limitPrice !== null ? { limit_price: String(Number(limitPrice.toFixed(2))) } : {}), ...(notionalUsd !== null ? { notional: String(notionalUsd) } : { qty: String(Number(qty.toFixed(9))) }) };
    try {
      return { ...mapOrder(await http.request('POST', PAPER_BASE, '/v2/orders', { body })), duplicate: false };
    } catch (err) {
      // Alpaca refuses a repeated client_order_id (HTTP 422): the order already exists, so return it instead of failing or placing another
      if (err instanceof InvalidRequestError && /client_order_id/i.test(err.message)) return { ...(await getOrderByClientId(cid)), duplicate: true };
      throw err;
    }
  }
  async function cancelOrder(id) {
    if (!o.enabled) throw new PolicyError('alpaca: orders are switched off (config.broker.enabled is false)');
    await http.request('DELETE', PAPER_BASE, `/v2/orders/${encodeURIComponent(id)}`);
    return { id, cancelled: true };
  }

  function mapOrder(r) {
    if (!r || typeof r !== 'object' || !r.id) throw new ProviderDataError('alpaca: the order answer is not in the expected shape');
    return {
      id: String(r.id), clientOrderId: r.client_order_id ?? null, symbol: r.symbol ?? null, side: r.side ?? null, status: String(r.status || 'unknown'),
      filledQty: num(r.filled_qty), filledAvgPrice: pos(r.filled_avg_price), filledAt: r.filled_at ?? null, submittedAt: r.submitted_at ?? null,
    };
  }

  return { account, clock, positions, latestQuote, dailyBars, stockMid, optionSnapshots, getOrder, getOrderByClientId, listOrders, placeOrder, cancelOrder, clientOrderId, options: o, configured: http.configured };
}

// ---- fills into the ledger (subscribe-only port: it has no order method, as ledger.attachFillSource requires) ------------------------
const CID = /^sm-(\d+)-(entry|exit)$/;
function createAlpacaFillPort() {
  const handlers = new Set();
  return {
    name: 'alpaca-paper', source: 'broker-paper',
    subscribe(h) { handlers.add(h); return () => handlers.delete(h); },
    // deliver the filled orders of `orders` (mapOrder results); returns how many were delivered. The ledger stores each externalId once.
    deliverFilled(orders) {
      let n = 0;
      for (const ord of orders) {
        const m = CID.exec(ord.clientOrderId || '');
        if (!m || ord.status !== 'filled' || !ord.filledAvgPrice || !ord.filledAt) continue;
        const day = nyDate(Date.parse(ord.filledAt));
        for (const h of [...handlers]) h({ positionId: Number(m[1]), leg: m[2], price: ord.filledAvgPrice, day, quantity: ord.filledQty && ord.filledQty > 0 ? ord.filledQty : null, externalId: ord.id });
        n++;
      }
      return n;
    },
  };
}

// poll the paper account's orders and deliver the filled ones to the port. Safe to repeat: the ledger ignores a fill it already stored.
async function reconcile({ alpaca, port, afterIso = null }) {
  const orders = await alpaca.listOrders({ status: 'all', after: afterIso });
  return { seen: orders.length, delivered: port.deliverFilled(orders) };
}

module.exports = { createAlpacaHttp, createAlpaca, createAlpacaFillPort, reconcile, PAPER_BASE, DATA_BASE, KEY_ENV, SECRET_ENV, TIFS };
