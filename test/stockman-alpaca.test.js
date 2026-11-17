// Alpaca PAPER broker adapter (vault D23, CL-0062): the allowlist and switch, keys only from the environment and never leaked, paper host only,
// the order guards and idempotence, and fills reaching the ledger through a port that cannot place orders. Network mocked: no keys, no calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createPolicy, BASE_HOSTS, SOURCES } = require('../src/core/net/policy');
const { createAlpacaHttp, createAlpaca, createAlpacaFillPort, reconcile, PAPER_BASE, DATA_BASE } = require('../src/core/stockman/trading/alpaca');
const { createStockman } = require('../src/core/stockman/app');
const { createMockProvider } = require('../src/core/stockman/stocks/mock');
const { createTradingLayer } = require('../src/core/stockman/trading');
const { PolicyError, InvalidRequestError } = require('../src/core/stockman/errors');

const KEY = 'PKTESTKEY123456', SECRET = 'sEcReTsEcReT987654';
const ENV = { ALPACA_PAPER_KEY_ID: KEY, ALPACA_PAPER_SECRET_KEY: SECRET };
const policyOn = (broker = true) => createPolicy(() => ({ online: { enabled: true, finance: true, broker } }));

// a scripted network: routes keyed "METHOD host/path"; records every call
function net(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, url, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const r = routes[`${init.method} ${u.hostname}${u.pathname}`];
    if (!r) return { status: 404, text: async () => JSON.stringify({ message: 'not found' }) };
    const out = typeof r === 'function' ? r(u, init) : r;
    return { status: out.status ?? 200, text: async () => (typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? {})) };
  };
  return { fetch, calls };
}
const adapter = ({ routes = {}, env = ENV, broker = true, enabled = true, maxNotionalUsd = 1000 } = {}) => {
  const n = net(routes);
  const http = createAlpacaHttp({ policy: policyOn(broker), fetch: n.fetch, env });
  return { a: createAlpaca({ http, opts: { enabled, maxNotionalUsd } }), n, http };
};
const ORDER = (over = {}) => ({ id: 'ord-1', client_order_id: 'sm-7-entry', symbol: 'AAPL', side: 'buy', status: 'new', filled_qty: '0', filled_avg_price: null, filled_at: null, submitted_at: '2026-11-18T14:00:00Z', ...over });

test('policy: the two paper hosts are allowed only through the broker source, which is its own switch; no live host exists', () => {
  assert.ok(BASE_HOSTS.includes('paper-api.alpaca.markets') && BASE_HOSTS.includes('data.alpaca.markets'));
  assert.ok(SOURCES.includes('broker'));
  assert.equal(policyOn(true).allowed(`${PAPER_BASE}/v2/account`, 'broker').ok, true);
  assert.equal(policyOn(true).allowed(`${DATA_BASE}/v2/stocks/AAPL/quotes/latest`, 'broker').ok, true);
  assert.equal(policyOn(false).allowed(`${PAPER_BASE}/v2/account`, 'broker').ok, false, 'online.broker off refuses');
  assert.match(policyOn(false).allowed(`${PAPER_BASE}/v2/account`, 'broker').reason, /broker lookups are off/);
  assert.equal(policyOn(true).allowed('https://api.alpaca.markets/v2/account', 'broker').ok, false, 'the live trading host is refused');
  assert.equal(policyOn(true).allowed('http://paper-api.alpaca.markets/v2/account', 'broker').ok, false, 'https only');
  assert.equal(createPolicy(() => ({})).allowed(`${PAPER_BASE}/v2/account`, 'broker').ok, true, 'no config at all: only an explicit false switches it off, so jarvis config.js defaults it to false');
  const defaults = require('../src/core/config').DEFAULTS.online;
  assert.equal(defaults.broker, false, 'jarvis ships with the broker source OFF');
});

test('no code names the live trading host', () => {
  const dir = path.join(__dirname, '../src/core/stockman');
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(dir).filter(x => x.endsWith('.js'))) {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!/(^|[^-])api\.alpaca\.markets/.test(t), `${path.relative(dir, f)} names the live host`);
  }
});

test('keys: read from the environment only, sent as headers, never in the URL; missing keys fail before any request', async () => {
  const { a, n } = adapter({ routes: { 'GET paper-api.alpaca.markets/v2/account': { body: { status: 'ACTIVE', currency: 'USD', buying_power: '200000', cash: '100000', equity: '100000', account_number: 'PA1234567890' } } } });
  const acc = await a.account();
  assert.deepEqual([acc.status, acc.currency, acc.buyingPower, acc.cash, acc.tradingBlocked], ['ACTIVE', 'USD', 200000, 100000, false]);
  assert.equal(acc.number, '…7890', 'the account number is shown in part only');
  assert.equal(n.calls[0].headers['APCA-API-KEY-ID'], KEY); assert.equal(n.calls[0].headers['APCA-API-SECRET-KEY'], SECRET);
  assert.ok(!n.calls[0].url.includes(KEY) && !n.calls[0].url.includes(SECRET));
  const none = adapter({ env: {} });
  await assert.rejects(() => none.a.account(), e => e instanceof PolicyError && /no paper keys/.test(e.message));
  assert.equal(none.n.calls.length, 0);
  assert.equal(none.a.configured(), false);
});

test('switch: with online.broker off nothing is sent; a key refused by Alpaca and an error body never leak the secret', async () => {
  const off = adapter({ broker: false, routes: { 'GET paper-api.alpaca.markets/v2/account': { body: {} } } });
  await assert.rejects(() => off.a.account(), e => e instanceof PolicyError && /broker lookups are off/.test(e.message));
  assert.equal(off.n.calls.length, 0);
  const bad = adapter({ routes: { 'GET paper-api.alpaca.markets/v2/account': { status: 401, body: { message: `forbidden: key ${KEY} secret ${SECRET}` } } } });
  await assert.rejects(() => bad.a.account(), e => { assert.ok(e instanceof PolicyError); assert.ok(!e.message.includes(KEY) && !e.message.includes(SECRET)); assert.match(e.message, /\[redacted\]/); return true; });
  const flaky = createAlpacaHttp({ policy: policyOn(true), env: ENV, fetch: async () => { throw new Error(`socket hang up ${KEY}`); } });
  await assert.rejects(() => flaky.request('GET', PAPER_BASE, '/v2/clock'), e => { assert.equal(e.code, 'TRANSIENT'); assert.ok(!e.message.includes(KEY)); return true; });
});

test('reads: clock and the latest IEX quote with its spread; an unexpected shape fails loudly', async () => {
  const { a, n } = adapter({ routes: {
    'GET paper-api.alpaca.markets/v2/clock': { body: { is_open: true, timestamp: 't', next_open: 'o', next_close: 'c' } },
    'GET data.alpaca.markets/v2/stocks/AAPL/quotes/latest': { body: { symbol: 'AAPL', quote: { bp: 350.42, ap: 350.48, bs: 6, as: 8, t: '2026-11-17T18:37:00Z' } } },
    'GET data.alpaca.markets/v2/stocks/BAD/quotes/latest': { body: { nothing: true } },
  } });
  assert.equal((await a.clock()).isOpen, true);
  const q = await a.latestQuote('AAPL');
  assert.deepEqual([q.bid, q.ask, q.bidSize, q.askSize], [350.42, 350.48, 6, 8]);
  assert.ok(Math.abs(q.spreadBps - (0.06 / 350.45) * 1e4) < 1e-9);
  assert.equal(n.calls[1].url.includes('feed=iex'), true);
  await assert.rejects(() => a.latestQuote('BAD'), /not in the expected shape/);
});

test('orders: off unless config.broker.enabled; guards on notional, qty and time in force; the body is a paper market order with a client id', async () => {
  const off = adapter({ enabled: false });
  await assert.rejects(() => off.a.placeOrder({ positionId: 7, leg: 'entry', symbol: 'AAPL', notionalUsd: 100 }), /orders are switched off/);
  assert.equal(off.n.calls.length, 0);
  const { a, n } = adapter({ routes: { 'POST paper-api.alpaca.markets/v2/orders': { body: ORDER() } } });
  const bad = p => a.placeOrder({ positionId: 7, leg: 'entry', symbol: 'AAPL', notionalUsd: 100, ...p });
  await assert.rejects(() => bad({ notionalUsd: 1001 }), InvalidRequestError);
  await assert.rejects(() => bad({ notionalUsd: 0 }), InvalidRequestError);
  await assert.rejects(() => bad({ notionalUsd: 100, qty: 1 }), /not both/);
  await assert.rejects(() => bad({ notionalUsd: null, qty: null }), /not both and not neither/);
  await assert.rejects(() => bad({ notionalUsd: null, qty: 1.5 }), /whole number/);
  await assert.rejects(() => bad({ timeInForce: 'gtc' }), /time in force/);
  await assert.rejects(() => bad({ leg: 'hold' }), /entry or exit/);
  await assert.rejects(() => bad({ positionId: 0 }), /position id/);
  assert.equal(n.calls.length, 0, 'every guard fires before anything is sent');
  const o = await bad({ timeInForce: 'opg' });
  assert.equal(o.id, 'ord-1'); assert.equal(o.duplicate, false);
  assert.deepEqual(n.calls[0].body, { symbol: 'AAPL', side: 'buy', type: 'market', time_in_force: 'opg', client_order_id: 'sm-7-entry', notional: '100' });
  assert.equal(n.calls[0].url, 'https://paper-api.alpaca.markets/v2/orders');
  await a.placeOrder({ positionId: 7, leg: 'exit', symbol: 'AAPL', qty: 3, timeInForce: 'cls' });
  assert.deepEqual([n.calls[1].body.side, n.calls[1].body.qty, n.calls[1].body.client_order_id, n.calls[1].body.notional], ['sell', '3', 'sm-7-exit', undefined]);
});

test('orders: a repeated client order id returns the existing order and never places a second one', async () => {
  const { a, n } = adapter({ routes: {
    'POST paper-api.alpaca.markets/v2/orders': { status: 422, body: { message: 'client_order_id must be unique' } },
    'GET paper-api.alpaca.markets/v2/orders:by_client_order_id': u => ({ body: ORDER({ client_order_id: u.searchParams.get('client_order_id'), status: 'filled' }) }),
  } });
  const r = await a.placeOrder({ positionId: 7, leg: 'entry', symbol: 'AAPL', notionalUsd: 100 });
  assert.equal(r.duplicate, true); assert.equal(r.status, 'filled');
  assert.equal(n.calls.filter(c => c.method === 'POST').length, 1);
  assert.match(n.calls[1].url, /client_order_id=sm-7-entry/);
});

test('fills: only filled sm-<id>-<leg> orders reach the ledger, as broker-paper, once; the port cannot place an order', async () => {
  const layer = createTradingLayer({});
  const app = createStockman({ env: {}, dataDir: os.tmpdir(), dbFile: ':memory:', log: () => {}, provider: createMockProvider({}) });
  for (const f of layer.features) app.use(f);
  await app.start();
  const ledger = layer.api.ledger;
  const id = ledger.open({ source: 'broker-paper', scoringBuild: 'rev-v1.0/L5/vol', symbol: 'AAPL', weight: 0.05, signalDay: '2026-11-17', entryDay: '2026-11-18', exitDay: '2026-11-24', expectedEntryPrice: 100 });
  const port = createAlpacaFillPort();
  const errors = [];
  ledger.attachFillSource(port, { onError: e => errors.push(e.message) });   // would throw if the port could place orders
  for (const m of ['placeOrder', 'submitOrder', 'createOrder', 'buy', 'sell', 'order']) assert.equal(typeof port[m], 'undefined');
  const filled = ORDER({ client_order_id: `sm-${id}-entry`, status: 'filled' });
  const orders = [
    { ...filled, clientOrderId: `sm-${id}-entry`, id: 'o1', status: 'filled', filledAvgPrice: 100.25, filledQty: 2, filledAt: '2026-11-18T14:30:01Z' },
    { clientOrderId: `sm-${id}-exit`, id: 'o2', status: 'new', filledAvgPrice: null, filledAt: null },                       // not filled: ignored
    { clientOrderId: 'someone-elses-order', id: 'o3', status: 'filled', filledAvgPrice: 9, filledQty: 1, filledAt: '2026-11-18T14:30:01Z' },   // not ours: ignored
  ];
  assert.equal(port.deliverFilled(orders), 1);
  assert.equal(port.deliverFilled(orders), 1, 'delivered again: the ledger stores the same external id once');
  const fills = app.db.stmt('SELECT * FROM paper_fill WHERE position_id = ?').all(id);
  assert.equal(fills.length, 1);
  assert.deepEqual([fills[0].source, fills[0].leg, fills[0].price, fills[0].quantity, fills[0].day, fills[0].external_id], ['broker-paper', 'entry', 100.25, 2, '2026-11-18', 'o1']);
  assert.equal(ledger.getPosition(id).fill_entry_price, 100.25);
  assert.deepEqual(errors, []);
  // a fill for a position that does not exist is reported, not thrown into the port
  port.deliverFilled([{ clientOrderId: 'sm-999-entry', id: 'o9', status: 'filled', filledAvgPrice: 5, filledQty: 1, filledAt: '2026-11-18T15:00:00Z' }]);
  assert.match(errors[0], /no position 999/);
  await app.stop();
});

test('reconcile: lists the paper account orders and hands the filled ones to the port', async () => {
  const { a } = adapter({ routes: { 'GET paper-api.alpaca.markets/v2/orders': { body: [ORDER({ status: 'filled', filled_avg_price: '100.1', filled_qty: '1', filled_at: '2026-11-18T14:30:00Z' }), ORDER({ id: 'ord-2', client_order_id: 'sm-8-entry', status: 'new' })] } } });
  const port = createAlpacaFillPort(); const got = [];
  port.subscribe(f => got.push(f));
  const r = await reconcile({ alpaca: a, port });
  assert.deepEqual(r, { seen: 2, delivered: 1 });
  assert.deepEqual(got.map(f => [f.positionId, f.leg, f.price, f.externalId]), [[7, 'entry', 100.1, 'ord-1']]);
});

test('config: broker orders are off by default, an env switch and file keys are validated, a secret-looking key is refused', () => {
  const { loadConfig } = require('../src/core/stockman/config');
  assert.equal(loadConfig({ dataDir: os.tmpdir(), env: {}, readFile: () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; } }).broker.enabled, false);
  assert.equal(loadConfig({ dataDir: os.tmpdir(), env: { STOCKMAN_BROKER_ORDERS: 'on' }, readFile: () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; } }).broker.enabled, true);
  assert.throws(() => loadConfig({ dataDir: os.tmpdir(), env: {}, readFile: () => JSON.stringify({ broker: { apiKey: 'x' } }) }), /looks like a secret/);
  assert.throws(() => loadConfig({ dataDir: os.tmpdir(), env: {}, readFile: () => JSON.stringify({ broker: { maxNotionalUsd: -5 } }) }), /maxNotionalUsd/);
});
