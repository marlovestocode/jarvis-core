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
//   node src/core/stockman/cli.js backtest run [variant|all|all-momentum] [--holdout]   run the backtest (reversal or momentum variants) on the TUNING period (the holdout is locked: --holdout, once per variant)
//   node src/core/stockman/cli.js backtest status | show [variant]         what has run, the variant count; the last stored result
// The data commands use the same fetcher setup as the worker (allowlist, switches, size cap) and never start the automatic cycles.
// Options via environment: STOCKMAN_DATA_DIR, STOCKMAN_PROVIDER (yahoo | mock), STOCKMAN_LOG_LEVEL. See README.md.
const { createStockman } = require('./app');

function buildDataApp() {
  const { loadConfig } = require('./config');
  const { createFetcher } = require('../net/fetcher');
  const { createPolicy } = require('../net/policy');
  const { createDataLayer } = require('./features');
  const { createTradingLayer } = require('./trading');
  const config = loadConfig({});
  const getConfig = () => ({ online: { enabled: true, finance: true } });
  const fetcher = createFetcher({ policy: createPolicy(getConfig), cacheDir: config.cacheDir, timeoutMs: config.provider.timeoutMs });
  const app = createStockman({ config, getConfig, fetcher });
  const layer = createDataLayer({ fetcher, autoRun: false });
  for (const f of layer.features) app.use(f);
  const trading = createTradingLayer({ data: layer.api });
  for (const f of trading.features) app.use(f);
  return { app, layer, trading };
}

// backtest run [variant|all] [--holdout]   backtest status   backtest show [variant] [--holdout]   (no network; reads and writes stockman.db)
async function backtest(args, out) {
  const { formatResult } = require('./trading/report');
  const { ALL_VARIANTS, MOMENTUM_VARIANTS } = require('./trading/engine');
  const flags = args.filter(a => a.startsWith('--')), [sub, name] = args.filter(a => !a.startsWith('--'));
  const holdout = flags.includes('--holdout');
  for (const f of flags) if (f !== '--holdout') { out(`unknown option ${f}`); return 2; }
  const { app, trading } = buildDataApp();
  await app.start();
  const bt = trading.api.backtest;
  try {
    switch (sub) {
      case 'run': {
        if (holdout && (!name || name === 'all')) { out('the holdout runs one named variant at a time, once: backtest run <variant> --holdout'); return 2; }
        if (holdout && name && name.startsWith('all')) { out('the holdout runs one named variant at a time, once: backtest run <variant> --holdout'); return 2; }
        const group = name === 'all' || name === 'all-reversal' ? ALL_VARIANTS : name === 'all-momentum' ? MOMENTUM_VARIANTS : null;
        const keys = !name ? ['rev-L5-vol'] : group ? group.map(v => v.key) : [name];
        let failed = 0;
        for (const key of keys) {
          const t0 = Date.now();
          try {
            const r = bt.run({ variant: key, period: holdout ? 'holdout' : 'tuning', allowHoldout: holdout });
            out(formatResult(r));
            out(`(${((Date.now() - t0) / 1000).toFixed(1)} s)\n`);
          } catch (err) {
            // in a group run, a variant that cannot run (for example too little history) does not stop the others; it is reported, never shortened
            if (!group) throw err;
            failed++; out(`${key}: COULD NOT RUN: ${err.message}\n`);
          }
        }
        if (failed) return 1;
        break;
      }
      case 'status': out(JSON.stringify(bt.status(), null, 2)); break;
      case 'show': {
        const r = bt.lastResult(name || 'rev-L5-vol', holdout ? 'holdout' : 'tuning');
        out(r ? formatResult(r) : 'no finished run for that variant and period');
        break;
      }
      default: out('usage: stockman backtest <run [variant|all] [--holdout] | status | show [variant] [--holdout]>\nvariants: ' + [...ALL_VARIANTS, ...MOMENTUM_VARIANTS].map(v => v.key).join(', ') + '\n"all" or "all-reversal" runs the six reversal variants, "all-momentum" the six momentum variants.\nThe holdout is locked: it runs only with --holdout, once per variant.'); return 2;
    }
    return 0;
  } finally { await app.stop(); }
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
    out('usage: stockman <migrate | status | events [n] | quote SYMBOL... | history SYMBOL [range] [interval] | data ... | backtest ...>');
    return cmd ? 0 : 1;
  }
  if (cmd === 'data') {
    try { return await data(args, out); } catch (err) { out(`error [${err.code || 'UNKNOWN'}]: ${err.message}`); return 1; }
  }
  if (cmd === 'backtest') {
    try { return await backtest(args, out); } catch (err) { out(`error [${err.code || 'UNKNOWN'}]: ${err.message}`); return 1; }
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
