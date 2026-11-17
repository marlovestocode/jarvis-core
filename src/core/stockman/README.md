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

## The data layer (features/, vault CL-0030 to CL-0033)

Five features registered in `worker.js` through `app.use()`; `features/index.js` is the only file that wires them. Data plumbing only: no scoring, prediction features, strategies, ledger, reviewer or UI.

| Feature (migration) | Files | What it does |
|---|---|---|
| `universe` (2) | `universe.js`, `html-table.js` | S&P 500 (Wikipedia) plus Nasdaq-100 (Nasdaq API, cross-checked with Wikipedia), de-duplicated; `BRK.B` kept, `yahoo_symbol` `BRK-B`; dated Wikipedia revisions for point-in-time membership (quarterly from 2020, 6 s apart, a few per cycle, resumable). Tables `universe_snapshot`, `universe_member`. |
| `bars` (3) | `bars.js` | Paced sweep through `ctx.stocks` (the StockProvider): finished sessions only, gaps recorded and never filled, stale cache not stored, idempotent and resumable. Tables `bar`, `bar_gap`, `coverage`. |
| `calendar` (4) | `calendar.js`, `calendar-rules.js`, `ny-time.js` | NYSE/Nasdaq trading days, holidays, early closes in New York time; a check of the calendar against the bars received; what a catch-up could not fill. Tables `market_day`, `catchup_gap`. |
| `runs` (5) | `runs.js` | One run per trading day (`run-YYYY-MM-DD`), states `created → universe_ok → ingested`, stage rows with attempts and errors; catch-up on start and every 15 minutes; history steps; `data_quality`. Tables `run`, `run_stage`. |
| `bars` history (6) | `bars.js` | Deep history for the backtest: one full-series fetch (`10y`, trimmed to `2019-10-01`) per symbol ever in a stored list plus `SPY`. Each symbol's row in `bar_history` says `ok`, `not_found` (delisted or renamed: a survivorship gap, reported), `failed` (3 tries) or `readjust`. A daily sweep that sees stored closes change (split or dividend) marks `readjust`, and the series is fetched again so all its adjusted closes stay on one basis. |
| `earnings` (7) | `earnings.js` | Nasdaq earnings calendar, one request per weekday (`api.nasdaq.com`, already allowed), from `2019-10-01`, 1 s apart; the coming 28 days fetched again daily (dates move; a date's fetch replaces that date's rows); past dates fetched again once if first seen before they happened. `flags({ symbol, entryDay, exitDay })` gives `earnings_in_window`, `earnings_possible`, `earnings_data` by the vault note 06 rules. Tables `earnings_fetch`, `earnings_event`. |

- **History steps:** after each daily cycle, and on a 15-minute tick when no daily work is due, one bounded step of each: universe snapshots (8), deep bars (200 symbols), earnings dates (120). The daily data always comes first. `SPY` (the benchmark proxy, vault note 06) is also swept daily with the universe but never counts in coverage.
- **CLI:** `cli.js data cycle`, `data history [steps]` (runs the steps until nothing is pending; about 45 minutes from empty), `data status`, `data flags SYMBOL ENTRY EXIT`.

- **Catch-up:** on start the newest finished session is found (close plus 30 min), a run is made for every trading day since the last run or stored bar, and one sweep covers the gap with the smallest provider range that fits. A day with no bar from any symbol after a clean sweep, or below 90% coverage after 3 tries, is accepted but recorded in `catchup_gap` and shown in `data_quality`.
- **data_quality:** `app.health().dataQuality.runs` (coverage fresh/universe, data age, open gaps, calendar doubts, last run) with a `summary` string that jarvis's `stockman_status` prints. It says daily bars of finished sessions; quote delay is not measured.
- **Switches:** the worker runs the cycles only with the real provider (`yahoo`); `STOCKMAN_AUTORUN=off` stops them. All requests use the one fetcher, so `online.finance` and the allowlist apply. No host was added.
- **Tests:** `test/stockman-{calendar-rules,universe,bars,data-layer,history}.test.js`; fixtures are excerpts of real responses in `test/fixtures/stockman-data/` (see its README).

## Paper ledger, cost model and backtest (trading/, vault Phase 1 ledger part and Phase 5, CL-0037)

Paper only. Nothing here can place an order (vault D1, D14); the broker route (Alpaca paper, D23) is approved and NOT built. Registered by `worker.js` and `cli.js` after the data layer (`trading/index.js` → `createTradingLayer({ data })`).

| Part | File | What it does |
|---|---|---|
| `ledger` (8) | `trading/ledger.js` | Tables `paper_position` and `paper_fill`. One row per position: `source` (`backtest` / `paper-internal` / `broker-paper`), scoring build id, run id, basket, sleeve, entry and exit days, expected and fill prices, gross return, cost, net return, benchmark return. `attachFillSource(port)` is the one door for fills (a port with `subscribe(handler)`); a port with an order-placing method is refused. A fill's source must match its position's. |
| costs | `trading/costs.js` | 10 bps round trip is the base case (an assumption); every result at 5, 10 and 25 bps. Fill price with per-side cost, slippage in bps. |
| `backtest` (9) | `trading/backtest.js`, `engine.js`, `stats.js`, `report.js` | The rule from vault note 06 (D21). Tables `backtest_variant`, `backtest_run`, `backtest_day`. Writes every trade to the ledger as `backtest`. |

- **Rule:** score = -r_L / (vol20 * sqrt(L)); eligible = point-in-time member, 60+ bars, close above USD 5, no bar gap in 25 sessions, no earnings flag; top 20 equal weight; entry next open, exit 5th close; five overlapping sleeves; SPY benchmark over the same dates. Open prices are put on the adjusted basis with the same day's adjusted/raw close ratio.
- **Periods:** backtest 2020-03 to 2026-11-13; holdout = last 100 non-overlapping 5-session windows ending 2026-11-13; tuning = before. A tuning run never reads a bar after the first holdout window; a basket spanning the border is in neither.
- **Holdout lock:** `run({ period: 'holdout' })` throws `HOLDOUT_LOCKED` unless `allowHoldout: true`; the run is recorded before it computes, and a unique index refuses a second holdout row for the same variant (even if the first failed).
- **Variants:** six exist (lookback 3, 5, 10; with or without volatility scaling), keyed `rev-L5-vol` and so on. Each one run is logged; the count of variants tried is stored with every run and printed beside every result.
- **Statistics:** mean excess return per trade after cost over the non-overlapping windows (the baskets on the window grid), 95% interval by moving-block bootstrap over windows (block 4, 5000 resamples, fixed seed). Brier skill is not computed: the rule makes a ranking, not probabilities.
- **Survivorship gap (G24):** per signal day, point-in-time members with no bars at all, stored in `backtest_day` and summarised by year. The result is biased in the rule's favour by the missing delisted names, by an unknown amount.
- **CLI:** `node src/core/stockman/cli.js backtest run [variant|all]` (tuning only), `backtest run <variant> --holdout` (locked; once), `backtest status`, `backtest show [variant]`. It reads and writes `stockman.db` in `STOCKMAN_DATA_DIR`; point it at a copy when the live worker owns the real file.
- **Tests:** `test/stockman-ledger.test.js`, `test/stockman-backtest.test.js` (synthetic data, no network).
- **One scorer (CL-0046):** the backtest engine calls `learning/scoring.js` (features, eligibility, score, ranking) and adds only the session grid, fills, sleeves, benchmark and statistics. `test/stockman-one-scorer.test.js` pins identical scores, ranks and baskets in both paths. A change to the rule bumps `SCORING_BUILD` there, which also moves the backtest label (`rev-v1.0/L5/vol`).
- **Paper-trade opener (`paper`, `trading/paper.js`, CL-0049): OFF by default.** Turn it on only with `STOCKMAN_PAPER_TRADING=on` or `paperTrading.enabled` in `stockman.config.json`; vault note 06 says paper trading starts only after the rule passes the tuning period (CL-0047: it has not). Each step opens a `paper-internal` ledger position for every shadow candidate with `in_basket = 1`, enters at the next open, closes at the 5th session's close with the 10 bps base cost and SPY's return, records a missing bar as a gap (never filled), never trades a day logged after its entry session or any day up to 2026-11-13, and is a no-op on rerun. The candidate id is kept in the position's note (`candidate=<id>`). Paper only: no order, no broker, no network. `stockman_status` shows its one-line health. Tests: `test/stockman-paper.test.js`.

## Learning layer (`learning/`, vault Phases 3 to 5, CL-0039 to CL-0041)

| Feature (migration) | File | What it does |
|---|---|---|
| `scoring` (none) | `scoring.js` | The note 06 rule: score = -r5 / (vol20 x sqrt 5) on adjusted closes, eligibility filters, top-20 basket, six logged variants. Pure code: no LLM, randomness, clock or network. Build id `rev-v1.0`, bumped on any change. |
| `shadow` (10) | `shadow.js` | Per ingested session, scores every point-in-time member and logs it (`candidate`, with reasons, flags, features, build id); after the 5th session fills `candidate_outcome` (adjusted entry open to exit close, excess vs SPY, gross of costs). Gaps are recorded, never filled. Catch-up after a closed app. Refuses days up to 2026-11-13 (the backtest holdout). |
| `calibration` (11) | `calibration.js` | Win probability per bucket with a 95% interval, shrunk toward the base rate, "insufficient data" under 200 outcomes or 30 windows, walk-forward Brier skill with a window bootstrap, versioned by scoring build. |

Wired in `features/index.js` after `runs`. Each feature's `health()` adds a one-line summary to `stockman_status`. Tests: `test/stockman-{scoring,shadow,calibration}.test.js`. Simulated and shadow numbers are not predictions or guarantees.

## What is verified and what is not

Verified: the Yahoo response shape for quote and history, the unknown-symbol HTTP 404, and that this phase passes the full jarvis suite. **Not verified:** quote delay and behaviour during US market hours, the rate-limit threshold (HTTP 429 did occur under a burst of probes), the error JSON body for an unknown symbol, and intervals other than `1d` and `1m` (so only those are offered). The Yahoo endpoint is unofficial and may change.
