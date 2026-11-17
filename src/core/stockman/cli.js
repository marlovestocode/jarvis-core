#!/usr/bin/env node
// StockMan framework CLI: run and inspect the backend without jarvis. Read-only: it fetches quotes and bars, nothing else.
//   node src/core/stockman/cli.js migrate                     open stockman.db and apply migrations
//   node src/core/stockman/cli.js status                      health as JSON
//   node src/core/stockman/cli.js events [n]                  the last n engine_event rows (default 20)
//   node src/core/stockman/cli.js quote AAPL [MSFT ...]       one or more quotes (LIVE network call to the Yahoo host)
//   node src/core/stockman/cli.js history AAPL [range] [interval]   bars (LIVE), default range 1mo, interval 1d
// Options via environment: STOCKMAN_DATA_DIR, STOCKMAN_PROVIDER (yahoo | mock), STOCKMAN_LOG_LEVEL. See README.md.
const { createStockman } = require('./app');

async function main(argv, out = console.log) {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    out('usage: stockman <migrate | status | events [n] | quote SYMBOL... | history SYMBOL [range] [interval]>');
    return cmd ? 0 : 1;
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
