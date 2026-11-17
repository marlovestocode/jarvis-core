#!/usr/bin/env node
// StockMan framework CLI: run and inspect the backend without jarvis. Read-only: it fetches quotes, bars, index lists and earnings dates, nothing else.
//   node src/core/stockman/cli.js migrate                     open stockman.db and apply migrations
//   node src/core/stockman/cli.js status                      health as JSON
//   node src/core/stockman/cli.js events [n]                  the last n engine_event rows (default 20)
//   node src/core/stockman/cli.js quote AAPL [MSFT ...]       one or more quotes (LIVE network call to the Yahoo host)
//   node src/core/stockman/cli.js history AAPL [range] [interval]   bars (LIVE), default range 1mo, interval 1d
//   node src/core/stockman/cli.js data cycle                  one data cycle: universe, daily bars, then one history step (LIVE)
//   node src/core/stockman/cli.js data history [steps]        history steps until nothing is pending or `steps` ran (default 200) (LIVE, slow)
//   node src/core/stockman/cli.js data status                 the data_quality object as JSON (no network)
//   node src/core/stockman/cli.js data flags SYMBOL ENTRY EXIT    earnings flags for one paper trade window (no network)
// The data commands use the same fetcher setup as the worker (allowlist, switches, size cap) and never start the automatic cycles.
// Options via environment: STOCKMAN_DATA_DIR, STOCKMAN_PROVIDER (yahoo | mock), STOCKMAN_LOG_LEVEL. See README.md.
const { createStockman } = require('./app');

function buildDataApp() {
  const { loadConfig } = require('./config');
  const { createFetcher } = require('../net/fetcher');
  const { createPolicy } = require('../net/policy');
  const { createDataLayer } = require('./features');
  const config = loadConfig({});
  const getConfig = () => ({ online: { enabled: true, finance: true } });
  const fetcher = createFetcher({ policy: createPolicy(getConfig), cacheDir: config.cacheDir, timeoutMs: config.provider.timeoutMs });
  const app = createStockman({ config, getConfig, fetcher });
  const layer = createDataLayer({ fetcher, autoRun: false });
  for (const f of layer.features) app.use(f);
  return { app, layer };
}

async function data(args, out) {
  const [sub, ...rest] = args;
  const { app, layer } = buildDataApp();
  await app.start();
  const { runs, earnings } = layer.api;
  const brief = r => JSON.stringify(r, (k, v) => (k === 'coverage' || k === 'failures' ? undefined : v));
  try {
    switch (sub) {
      case 'cycle': out(JSON.stringify(await runs.runCycle({ reason: 'cli' }), null, 2)); break;
      case 'history': {
        const max = Number(rest[0]) || 200;
        for (let i = 1; i <= max; i++) {
          const r = await runs.runHistory();
          out(`step ${i}: ${brief(r)}`);
          if (r.status === 'error' || r.status === 'idle' || !runs.needsHistory()) break;
        }
        out(runs.health().summary);
        break;
      }
      case 'status': out(JSON.stringify(runs.health(), null, 2)); break;
      case 'flags': out(JSON.stringify(earnings.flags({ symbol: rest[0], entryDay: rest[1], exitDay: rest[2] }), null, 2)); break;
      default: out('usage: stockman data <cycle | history [steps] | status | flags SYMBOL ENTRY EXIT>'); return 2;
    }
    return 0;
  } finally { await app.stop(); }
}

async function main(argv, out = console.log) {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    out('usage: stockman <migrate | status | events [n] | quote SYMBOL... | history SYMBOL [range] [interval] | data ...>');
    return cmd ? 0 : 1;
  }
  if (cmd === 'data') {
    try { return await data(args, out); } catch (err) { out(`error [${err.code || 'UNKNOWN'}]: ${err.message}`); return 1; }
  }
  const app = createStockman({});
  await app.start();
  try {
    switch (cmd) {
      case 'migrate': out(JSON.stringify({ schema: app.db.version, file: app.db.file })); break;
      case 'status': out(JSON.stringify(app.health(), null, 2)); break;
      case 'events': out(JSON.stringify(app.events.recent({ limit: Number(args[0]) || 20 }), null, 2)); break;
      case 'quote': out(JSON.stringify(await app.stocks.getQuotes(args), null, 2)); break;
      case 'history': out(JSON.stringify(await app.stocks.getHistory({ symbol: args[0], range: args[1] || '1mo', interval: args[2] || '1d' }), null, 2)); break;
      default: out(`unknown command: ${cmd}`); return 2;
    }
    return 0;
  } catch (err) {
    out(`error [${err.code || 'UNKNOWN'}]: ${err.message}`);
    return 1;
  } finally {
    await app.stop();
  }
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => { console.error(err.message); process.exitCode = 1; });

module.exports = { main };
