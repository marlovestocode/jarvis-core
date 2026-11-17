// The StockMan engine as its own process (vault D16, decided 2026-11-17: a child process that jarvis starts and stops).
// Started by process.js with child_process.fork. It owns stockman.db; jarvis never opens the file, it asks through messages.
//
// Messages from jarvis:   { type: 'init', dataDir, online }   first message; builds and starts the framework
//                         { type: 'online', online }           jarvis's config.online (the finance switch), pushed when it changes
//                         { type: 'request', id, op, args }    op: health | quote | quotes | history | events
//                         { type: 'stop' }                     orderly shutdown (also on IPC disconnect: jarvis quit or crashed)
// Messages to jarvis:     { type: 'ready', health } | { type: 'fatal', error }  (fatal exits with code 2: do not restart)
//                         { type: 'reply', id, ok, result | error: { code, message, retryable } }
//                         { type: 'event', topic, payload }    what the framework publishes on its link
//                         { type: 'health', health }           every HEALTH_EVERY_MS
//                         { type: 'log', line }
// Exit codes: 0 stopped, 1 crashed (restart), 2 could not start: bad config or migration (restart would loop).
const { createStockman } = require('./app');
const { loadConfig } = require('./config');
const { createFetcher } = require('../net/fetcher');
const { createPolicy } = require('../net/policy');
const { createDataLayer } = require('./features');
const { createTradingLayer } = require('./trading');

const HEALTH_EVERY_MS = 5000;
const FATAL_EXIT = 2;

function run() {
  let app = null, online = { enabled: true, finance: true }, stopping = false;
  const send = m => { try { if (process.connected) process.send(m); } catch { /* the parent is gone */ } };
  const fail = err => ({ code: err?.code || 'UNKNOWN', message: String(err?.message || err).slice(0, 500), retryable: err?.retryable === true });

  const ops = {
    health: () => app.health(),
    quote: ({ symbol }) => app.stocks.getQuote(symbol),
    quotes: ({ symbols }) => app.stocks.getQuotes(symbols),
    history: req => app.stocks.getHistory(req),
    events: o => (app.events ? app.events.recent(o || {}) : []),
  };

  async function shutdown(code) {
    if (stopping) return;
    stopping = true;
    try { await app?.stop(); } catch { /* exiting anyway */ }
    process.exit(code);
  }

  async function init(msg) {
    if (msg.online && typeof msg.online === 'object') online = msg.online;
    try {
      const config = loadConfig({ dataDir: msg.dataDir });
      const getConfig = () => ({ online });   // the policy reads online.enabled and online.finance live
      // ONE fetcher for the provider and the data layer: same allowlist, switches, timeout and size cap (no second HTTP path)
      const fetcher = createFetcher({ policy: createPolicy(getConfig), cacheDir: config.cacheDir, timeoutMs: config.provider.timeoutMs });
      app = createStockman({
        config, getConfig, fetcher,
        log: line => send({ type: 'log', line }),
        link: { name: 'parent', publish: (topic, payload) => send({ type: 'event', topic, payload }), subscribe: () => () => {} },
      });
      // the data layer (universe, bars, calendar, runs). Runs by itself only with the real provider; STOCKMAN_AUTORUN=off stops the automatic cycles.
      const layer = createDataLayer({ fetcher, autoRun: config.provider.name === 'yahoo' && !/^(off|false|0|no)$/i.test(process.env.STOCKMAN_AUTORUN || '') });
      for (const f of layer.features) app.use(f);
      // the paper ledger and backtest tables (migrations 8 and 9). Registered here so this build can open a database they have touched.
      for (const f of createTradingLayer({ data: layer.api }).features) app.use(f);
      await app.start();
    } catch (err) {
      send({ type: 'fatal', error: String(err?.message || err) });
      setTimeout(() => process.exit(FATAL_EXIT), 50);   // let the message out
      return;
    }
    send({ type: 'ready', health: app.health() });
    setInterval(() => send({ type: 'health', health: app.health() }), HEALTH_EVERY_MS).unref();
  }

  process.on('message', async msg => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init') return init(msg);
    if (msg.type === 'online') { if (msg.online && typeof msg.online === 'object') online = msg.online; return; }
    if (msg.type === 'stop') return shutdown(0);
    if (msg.type === 'request') {
      try {
        if (!app) throw Object.assign(new Error('engine is not ready'), { code: 'NOT_READY', retryable: true });
        if (!Object.hasOwn(ops, msg.op)) throw Object.assign(new Error(`unknown op: ${String(msg.op).slice(0, 40)}`), { code: 'INVALID_REQUEST' });
        send({ type: 'reply', id: msg.id, ok: true, result: await ops[msg.op](msg.args || {}) });
      } catch (err) { send({ type: 'reply', id: msg.id, ok: false, error: fail(err) }); }
    }
  });
  process.on('disconnect', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('uncaughtException', err => { send({ type: 'log', line: `stockman worker crashed: ${err?.stack || err}` }); process.exit(1); });
  process.on('unhandledRejection', err => { send({ type: 'log', line: `stockman worker unhandled rejection: ${err?.stack || err}` }); process.exit(1); });
}

if (require.main === module) {
  if (!process.send) { console.error('stockman worker: started by jarvis with an IPC channel; use cli.js to run it by hand'); process.exit(1); }
  run();
}

module.exports = { run, FATAL_EXIT, HEALTH_EVERY_MS };
