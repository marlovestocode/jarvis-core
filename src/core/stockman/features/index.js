// The StockMan data layer: five features registered with app.use() in worker.js, in this order (migrations 2 to 7, framework is 1):
//   universe (v2)     S&P 500 + Nasdaq-100, point-in-time membership                                universe.js
//   bars (v3, v6)     daily bars, coverage, gaps; deep history back to historyFrom, re-adjustment      bars.js
//   calendar (v4)     trading calendar, calendar-vs-bars check, catch-up gaps                         calendar.js, calendar-rules.js
//   earnings (v7)     Nasdaq earnings calendar by date, per-trade earnings flags (vault G23)           earnings.js
//   runs (v5)         run state machine (data stages), catch-up on start, history steps, data_quality runs.js
//   spreads (v12)     the cost sampler: quoted bid and ask during market hours (vault G11, CL-0060)      spreads.js
//   scoring, shadow (v10), calibration (v11)   the learning layer, in ../learning (vault Phases 3 to 5); starts after runs
// The features do not import each other; this file is the only place that wires them together (runs gets the others' APIs).
// The data features are plumbing only; the learning layer adds the deterministic scoring, shadow candidates and calibration. No ledger or reviewer here.
const { createUniverse } = require('./universe');
const { createBars } = require('./bars');
const { createCalendar } = require('./calendar');
const { createRuns } = require('./runs');
const { createEarnings } = require('./earnings');
const { createSpreads } = require('./spreads');
const { createLearningLayer } = require('../learning');

// The backtest needs bars and earnings dates from here (vault note 06: backtest 2020-03 to 2026-11-13 with 60 sessions of warm-up).
// Daily bars start 2019-01-01: the momentum rule with L = 252 needs 274 sessions before the first signal on 2020-03-02 (note 06, D25).
// The earnings calendar does not need to go back that far and keeps its own, later start, so its fetched days are not fetched again.
const HISTORY_FROM = '2019-01-01';
const EARNINGS_FROM = '2019-10-01';
// The benchmark proxy (note 06: S&P 500 total return, proxied by SPY adjusted closes; an assumption). Swept daily with the universe.
const BENCHMARKS = Object.freeze(['SPY']);

// deps: { fetcher (jarvis's fetcher: policy, size cap, switches), now, sleep, autoRun, historyFrom, options: { universe, bars, calendar, runs, earnings } }
function createDataLayer({ fetcher, now = Date.now, sleep, autoRun = true, historyFrom = HISTORY_FROM, earningsFrom = historyFrom > EARNINGS_FROM ? historyFrom : EARNINGS_FROM, options = {} } = {}) {
  const universe = createUniverse({ fetcher, now, sleep, opts: options.universe });
  const bars = createBars({ now, sleep, opts: options.bars });
  const calendar = createCalendar({ now, opts: options.calendar });
  const earnings = createEarnings({ fetcher, now, sleep, opts: { historyFrom: earningsFrom, ...options.earnings } });
  const runs = createRuns({
    universe: universe.api, bars: bars.api, calendar: calendar.api, earnings: earnings.api,
    halt: () => Promise.all([bars.feature.stop(), universe.feature.stop(), earnings.feature.stop()]),
    now, opts: { autoRun, historyFrom, benchmarks: [...BENCHMARKS], ...options.runs },
  });
  const spreads = createSpreads({ fetcher, universe: universe.api, now, sleep, opts: { autoRun, ...options.spreads } });
  const api = { universe: universe.api, bars: bars.api, calendar: calendar.api, runs: runs.api, earnings: earnings.api, spreads: spreads.api };
  const learning = createLearningLayer({ data: api, now, autoRun, options: options.learning });
  return {
    // runs after the data features it reads at start (its first data_quality reads earnings); the learning layer reads their data, so it starts last
    features: [universe.feature, bars.feature, calendar.feature, earnings.feature, spreads.feature, runs.feature, ...learning.features],
    api: { ...api, ...learning.api },
  };
}

module.exports = { createDataLayer, HISTORY_FROM, EARNINGS_FROM, BENCHMARKS };
