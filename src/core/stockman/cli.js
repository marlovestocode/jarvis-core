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
  // the options sampler's table (migration 13) must be known to every command that opens the database, or it refuses a file the engine has upgraded;
  // here it is registered switched off with a stub adapter, so no CLI command samples anything on its own
  app.use(require('./features/options').createOptions({ alpaca: { optionSnapshots() { throw new Error('off'); }, stockMid() { throw new Error('off'); } }, opts: { enabled: false, autoRun: false } }).feature);
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

// broker status | quote SYMBOL | orders | reconcile: Alpaca PAPER, read-only here (no order command exists in the CLI on purpose).
// Needs online.broker on (this CLI turns it on for itself only when STOCKMAN_BROKER=on) and ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY in the environment.
async function broker(args, out) {
  const { createPolicy } = require('../net/policy');
  const { createAlpacaHttp, createAlpaca, createAlpacaFillPort, reconcile } = require('./trading/alpaca');
  const { loadConfig } = require('./config');
  const config = loadConfig({});
  const on = /^(1|true|yes|on)$/i.test(process.env.STOCKMAN_BROKER || '');
  const policy = createPolicy(() => ({ online: { enabled: true, finance: true, broker: on } }));
  const http = createAlpacaHttp({ policy });
  const alpaca = createAlpaca({ http, opts: { enabled: config.broker.enabled, maxNotionalUsd: config.broker.maxNotionalUsd } });
  const [sub, arg] = args;
  switch (sub) {
    case 'status': {
      out(`paper keys in the environment: ${http.configured() ? 'yes' : 'NO (set ALPACA_PAPER_KEY_ID and ALPACA_PAPER_SECRET_KEY)'}; broker switch for this CLI (STOCKMAN_BROKER=on): ${on ? 'on' : 'OFF'}; order methods (config.broker.enabled): ${config.broker.enabled ? 'on' : 'OFF'}`);
      if (http.configured() && on) { out(JSON.stringify(await alpaca.account(), null, 2)); out(JSON.stringify(await alpaca.clock(), null, 2)); }
      return 0;
    }
    case 'quote': out(JSON.stringify(await alpaca.latestQuote(arg), null, 2)); return 0;
    case 'orders': out(JSON.stringify(await alpaca.listOrders({ status: 'all', limit: 20 }), null, 2)); return 0;
    case 'options': {
      // broker options round [UNDERLYING...] [--force] | broker options report [from] [to]: the options market sampler (read-only)
      const { createOptions } = require('./features/options');
      const rest = args.slice(1), force = rest.includes('--force'), words = rest.filter(w => !w.startsWith('--'));
      const { app } = buildDataApp();
      const sampler = createOptions({ alpaca, opts: { autoRun: false } });
      app.use(sampler.feature);
      await app.start();
      try {
        if (words[0] === 'round') out(JSON.stringify(await sampler.api.round({ force, only: words.length > 1 ? words.slice(1) : ['SPY', 'AAPL'] }), null, 2));
        else out(JSON.stringify(sampler.api.summary({ from: words[1] || undefined, to: words[2] || undefined }), null, 2));
        out(sampler.api.health().summary);
      } finally { await app.stop(); }
      return 0;
    }
    case 'reconcile': {
      const { app, trading } = buildDataApp();
      await app.start();
      try {
        const port = createAlpacaFillPort();
        trading.api.ledger.attachFillSource(port, { onError: (e, f) => out(`fill not stored: ${e.message} ${JSON.stringify(f)}`) });
        out(JSON.stringify(await reconcile({ alpaca, port }), null, 2));
      } finally { await app.stop(); }
      return 0;
    }
    default: out('usage: stockman broker <status | quote SYMBOL | orders | reconcile | options round [SYMBOL...] [--force] | options report>   (Alpaca PAPER only; needs STOCKMAN_BROKER=on and the paper keys in the environment)'); return 2;
  }
}

// strategy show | validate [file] | diff [file] | dry-run [day] | status | tune [--apply] | enable | disable   (vault D28: the sandbox strategy track)
// The strategy lives in <data folder>/stockman.strategy.json. No command here sends an order (the scheduler does, when all three switches are on).
// enable and disable edit stockman.config.json's sandbox.enabled; the running engine re-reads it within 30 seconds.
async function strategy(args, out) {
  const fs = require('node:fs'), path = require('node:path');
  const { loadConfig } = require('./config');
  const { normalize, diff, PRESET, createStrategyStore } = require('./trading/sandbox/strategy');
  const config = loadConfig({});
  const file = path.join(config.dataDir, 'stockman.strategy.json');
  const [sub, ...rest] = args;
  const flags = rest.filter(a => a.startsWith('--')), words = rest.filter(a => !a.startsWith('--'));
  const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
  if (sub === 'validate') {
    const target = words[0] || file;
    const n = normalize(readJson(target));
    out(n.ok ? `OK: ${target} is a valid strategy` : `REFUSED: ${n.errors.length} problem(s) in ${target}:\n- ${n.errors.join('\n- ')}`);
    return n.ok ? 0 : 1;
  }
  if (sub === 'diff') {
    const a = normalize(readJson(file)), b = words[0] ? normalize(readJson(words[0])) : { ok: true, value: PRESET };
    if (!a.ok || !b.ok) { out(`cannot diff: ${(a.ok ? b : a).errors.join('; ')}`); return 1; }
    const d = diff(b.value, a.value);
    out(d.length ? d.map(([p, x, y]) => `${p}: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`).join('\n') : 'no differences');
    out(`(${file} against ${words[0] || 'the built-in preset'})`);
    return 0;
  }
  if (sub === 'enable' || sub === 'disable') {
    const cfgFile = path.join(config.dataDir, 'stockman.config.json');
    let c = {}; try { c = readJson(cfgFile); } catch { /* none yet */ }
    c.sandbox = { ...(c.sandbox || {}), enabled: sub === 'enable' };
    fs.writeFileSync(cfgFile, `${JSON.stringify(c, null, 2)}\n`);
    if (sub === 'enable') { try { const sf = path.join(config.dataDir, 'stockman.sandbox-state.json'); const st = JSON.parse(fs.readFileSync(sf, 'utf8')); if (st.killed) { st.killed = null; fs.writeFileSync(sf, JSON.stringify(st)); out('the kill switch was cleared'); } } catch { /* no state yet */ } }
    out(`sandbox.enabled is now ${sub === 'enable'} in ${cfgFile} (orders also need broker.enabled and online.broker)`);
    return 0;
  }
  // the rest need the database and the adapter (reads only)
  const { createPolicy } = require('../net/policy');
  const { createAlpacaHttp, createAlpaca } = require('./trading/alpaca');
  const { createSandbox } = require('./trading/sandbox/sandbox');
  const { createTuner } = require('./trading/sandbox/tuner');
  const policy = createPolicy(() => ({ online: { enabled: true, finance: true, broker: /^(1|true|yes|on)$/i.test(process.env.STOCKMAN_BROKER || '') } }));
  const alpaca = createAlpaca({ http: createAlpacaHttp({ policy }), opts: { enabled: false, maxNotionalUsd: config.broker.maxNotionalUsd } });   // reads only: orders stay off in the CLI
  const store = createStrategyStore({ file, log: l => out(l) });
  const { app, layer, trading } = buildDataApp();
  await app.start();
  try {
    const sb = createSandbox({ ledger: trading.api.ledger, alpaca, data: layer.api, store, stateFile: path.join(config.dataDir, 'stockman.sandbox-state.json'), opts: { enabled: false, autoRun: false } });
    await sb.feature.start({ db: app.db });
    const tuner = createTuner({ store, data: layer.api, getDb: () => app.db, sandbox: sb.api, dataDir: config.dataDir });
    if (sub === 'show') { const s = store.load(); out(JSON.stringify({ hash: s.hash, buildId: s.buildId, error: s.error, file, strategy: s.strategy }, null, 2)); return s.error ? 1 : 0; }
    if (sub === 'status') { store.load(); out(JSON.stringify(sb.api.status(), null, 2)); return 0; }
    if (sub === 'dry-run') {
      store.load();
      const day = words[0] || layer.api.bars.lastBarDay();
      const p = await sb.api.runPlan({ day, scheduled: false });
      out(`DRY RUN for the close of ${p.day} (orders would go out in the session of ${p.entryDay}); ${p.label}; strategy ${p.strategyHash}; NOTHING WAS SENT`);
      out(`regime: ${p.regime.reason}; rebalance day: ${p.rebalance} (${p.rule}); members ${p.counts.members}, scored ${p.counts.scored}; left out: ${['noBars', 'price', 'dollarVolume', 'pinned', 'earnings', 'history'].map(k => `${k} ${p.counts[k]}`).join(', ')}`);
      out('targets:'); for (const t of p.targets) out(`  ${t.symbol.padEnd(6)} score ${t.score.toFixed(3).padStart(7)}  weight ${(t.weight * 100).toFixed(1).padStart(5)}%  USD ${String(t.notionalUsd).padStart(8)}  price ${t.price.toFixed(2)}${t.clipped ? '  (clipped to maxPositionPct)' : ''}`);
      out(`orders (${p.orders.length}):`); for (const x of p.orders) out(`  ${x.leg.toUpperCase().padEnd(5)} ${x.symbol.padEnd(6)} ${x.notionalUsd ? `USD ${x.notionalUsd}` : `qty ${x.qty}`}  ${x.reason}  [${x.cid}]`);
      if (p.refused.length) { out(`refused (${p.refused.length}):`); for (const r of p.refused) out(`  ${r.leg} ${r.symbol}: ${r.reason}`); }
      return 0;
    }
    if (sub === 'tune') {
      store.load();
      const r = await tuner.run({ force: true, apply: flags.includes('--apply') });
      out(`TUNER (${r.label}): ${r.status}; ${r.note || ''}`);
      if (r.current) out(`current: ${r.current.periods} periods, later-part mean excess ${(r.current.testMean * 100).toFixed(3)}% per period (lower bound ${(r.current.testLower95 * 100).toFixed(3)}%), earlier ${(r.current.fitMean * 100).toFixed(3)}%`);
      for (const c of r.candidates.filter(x => Object.keys(x.changes).length)) out(`  ${JSON.stringify(c.changes).padEnd(70)} later ${(c.testMean * 100).toFixed(3)}%  earlier ${(c.fitMean * 100).toFixed(3)}%`);
      if (r.data) out(`data: ${r.data.tuningFirst} to ${r.data.tuningEnd}; the holdout (to ${r.data.holdoutEndNeverRead}) was never read`);
      return r.status === 'failed' ? 1 : 0;
    }
    out('usage: stockman strategy <show | validate [file] | diff [file] | dry-run [day] | status | tune [--apply] | enable | disable>');
    return 2;
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
      case 'spreads': {
        // data spreads [round [n] [--force] | report [from] [to]]: the cost sampler (one round now, or the measured figures)
        const { spreads } = layer.api;
        const force = rest.includes('--force'), args2 = rest.filter(a => !a.startsWith('--'));
        if (args2[0] === 'round') out(JSON.stringify(await spreads.round({ force, limit: Number(args2[1]) || spreads.options.perRound }), null, 2));
        else out(JSON.stringify(spreads.summary({ from: args2[1] || undefined, to: args2[2] || undefined }), null, 2));
        out(spreads.health().summary);
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
    out('usage: stockman <migrate | status | events [n] | quote SYMBOL... | history SYMBOL [range] [interval] | data ... | backtest ... | broker ... | strategy ...>');
    return cmd ? 0 : 1;
  }
  if (cmd === 'data') {
    try { return await data(args, out); } catch (err) { out(`error [${err.code || 'UNKNOWN'}]: ${err.message}`); return 1; }
  }
  if (cmd === 'strategy') {
    try { return await strategy(args, out); } catch (err) { out(`error [${err.code || 'UNKNOWN'}]: ${err.message}`); return 1; }
  }
  if (cmd === 'broker') {
    try { return await broker(args, out); } catch (err) { out(`error [${err.code || 'UNKNOWN'}]: ${err.message}`); return 1; }
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
