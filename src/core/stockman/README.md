# StockMan backend framework (phase one)

Plumbing only: configuration, logging, a database, a stock data provider and the link to jarvis. No strategies, scoring, portfolio, UI, trading or advice. The plan, decisions and history live in the vault (`C:\Users\gdani\Projects\Finance\StockMan\StockMan\`); read its `00 Agent Rules.md` and `09 Changelog.md` before changing anything here.

## Setup

Needs Node 22 or newer (uses `node:sqlite`, `fetch`, `node --test`). **No new packages**; the repo's `node_modules` are enough.

```bash
npm test                                  # whole jarvis suite, includes test/stockman-*.test.js
node --test test/stockman-*.test.js       # StockMan tests only; the network is mocked, no keys needed
```

## Run it (without jarvis)

```bash
node src/core/stockman/cli.js migrate           # create or upgrade stockman.db
node src/core/stockman/cli.js status            # health as JSON
node src/core/stockman/cli.js events 20         # last engine_event rows
node src/core/stockman/cli.js quote AAPL MSFT   # LIVE read-only call to the Yahoo chart host
node src/core/stockman/cli.js history AAPL 5d 1d
```

Inside jarvis the engine is **its own child process** (vault D16, CL-0025). `src/main/main.js` builds `createStockmanProcess({ bus, log, getConfig, dataDir })` (`process.js`): a `stockman` boot stage starts it, the skill group gets it as a dependency, and a quit hook stops it. A failure to build it only logs `stockman unavailable`.

- **`worker.js`** is the child. It owns `stockman.db` and runs the whole framework (`createStockman`) with its own fetcher and the same host policy. jarvis never opens the database file.
- **`process.js`** is jarvis's side. It forks the worker, restarts it after a crash (1 s, doubling, up to 30 s; gives up after 5 quick crashes, or at once on exit code 2 = bad config or migration), forwards the worker's events to jarvis's bus (`stockman` events: `ready`, `circuit`, `engine-down`, `engine-up`, `engine-failed`, `stopped`) and its log lines to jarvis's log. `health()` is synchronous, from the worker's last push (every 5 s, so counts can lag a few seconds).
- **Asking the engine for data:** `engine.request(op, args)` with `op` one of `health`, `quote` `{symbol}`, `quotes` `{symbols}`, `history` `{symbol,range,interval}`, `events` `{limit,level,source}`. Errors keep their `code` across the process boundary.
- **Online switches:** jarvis's `online.enabled` and `online.finance` are sent to the worker before a request whenever they changed, so turning finance off in jarvis stops the worker's lookups.
- The worker runs under Electron's own binary with `ELECTRON_RUN_AS_NODE=1`. **Not yet verified inside the real Electron app or a packaged build.**

To run the framework in one process without jarvis (tests, the CLI), use `createStockman` from `app.js` directly.

## Configuration

Order: defaults < `<data dir>/stockman.config.json` (optional) < `STOCKMAN_*` environment variables. A wrong value stops startup with a clear message. Defaults are in `config.js`.

| What | How |
|---|---|
| Data folder | `STOCKMAN_DATA_DIR`, else `JARVIS_DATA_DIR`, else `%APPDATA%\jarvis-core`. Database: `<data>/stockman.db` |
| Switch off | `STOCKMAN_ENABLED=false` or `"enabled": false` |
| Provider | `STOCKMAN_PROVIDER=yahoo` (default) or `mock` |
| Log level | `STOCKMAN_LOG_LEVEL=debug|info|warn|error` |
| Timeouts, retries, rate limit, breaker | the `provider` block in the JSON file |
| **Secrets** | environment only, as `STOCKMAN_<NAME>`, read through `secrets.js`. A secret-looking key in the JSON file is refused. Phase one needs none (Yahoo chart is keyless). |

Network access goes through jarvis's own `fetcher` and `policy` (exact allowlisted https host, timeout, size cap). The `finance` switch (`online.finance`) is honoured when jarvis passes `getConfig`. This phase adds **no** host to the allowlist.

## Layout and boundaries

```
src/core/stockman/
  worker.js         the engine child process (owns stockman.db); process.js: jarvis's supervisor and message client
  app.js            composition root: createStockman(deps), app.use(feature), start/stop/health/tools
  config.js secrets.js log.js errors.js resilience.js
  db/               openStockmanDb, migrations/ (001-framework), events.js (engine_event)
  stocks/           provider.js (the port), yahoo.js, mock.js, service.js
  jarvis/           link.js (the port, bus + memory), tools.js (stockman_status)
  cli.js            run and inspect without jarvis
src/core/skills/stockman/   the jarvis skill group (read-only status tool)
```

Each layer talks to the next only through a small port, so each can be replaced or mocked:

- **Jarvis link** (`jarvis/link.js`): `publish(topic, payload)` / `subscribe`. Real: jarvis's bus (one event type `stockman`). Test double: `createMemoryLink()`. Jarvis reads StockMan through tools; nothing lets jarvis write to the database.
- **Stock data** (`stocks/provider.js`): `getQuote(symbol)` and `getHistory({ symbol, range, interval })`. Real: Yahoo chart. Test double: `createMockProvider()`. Callers use `stocks/service.js`, which adds input checks, rate limit, circuit breaker, retry with backoff, an overall deadline, output checks and logging.
- **Database** (`db/`): `openStockmanDb({ file })` returns the same handle shape as the cortex's. `':memory:'` is the test double.

Errors are typed (`errors.js`): the resilience layer retries only `retryable` ones and only provider-health failures trip the breaker (a missing symbol never does).

## Database choices

- **Own file `stockman.db`**, not `cortex.db` (vault D16 and note 07). Reuses the cortex opener so there is one place that loads the SQLite driver; WAL, foreign keys and a busy timeout come with it.
- **Migrations:** numbered files, tracked by `PRAGMA user_version`, each applied once in its own transaction. A failed migration **throws** (the cortex opener alone would leave a silent read-only handle). A file from a newer build is refused. Never edit a shipped migration; add the next number.
- **Initial schema (`001-framework`):** `meta` (key/value facts) and `engine_event` (append-only log of what the framework did and what failed; copies of warn/error log lines, pruned after 30 days). Nothing feature-specific, so there is nothing to un-pick later.

## How a later feature plugs in

```js
app.use({
  id: 'bars',
  migrations: [{ version: 2, name: 'bars', up: raw => raw.exec('CREATE TABLE bar(...)') }],  // next free number
  start: async ({ db, stocks, link, log, config, secrets }) => { /* schedule work */ },
  stop: async () => {},
  tools: ({ db }) => [/* jarvis tools, names start with stockman_ */],
});
```

Features get the services through `ctx` and never import each other or the framework's internals. Do this before `app.start()`.

## What is verified and what is not

Verified: the Yahoo response shape for quote and history, the unknown-symbol HTTP 404, and that this phase passes the full jarvis suite. **Not verified:** quote delay and behaviour during US market hours, the rate-limit threshold (HTTP 429 did occur under a burst of probes), the error JSON body for an unknown symbol, and intervals other than `1d` and `1m` (so only those are offered). The Yahoo endpoint is unofficial and may change.
