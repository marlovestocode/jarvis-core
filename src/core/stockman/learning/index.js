// The learning layer: scoring (no tables), shadow candidates (migration 10) and calibration (migration 11), vault Phases 3 to 5 (G8, G14).
// Like the data layer, the features do not import each other; this file wires them. Data it reads comes through the data layer's APIs
// (universe.membersAsOf, runs.getRun, bars.lastBarDay, earnings.flags) and the database (bar, bar_history).
// Migrations 8 and 9 belong to the paper ledger and backtest (trading layer, another session); 10 and 11 are free of them on purpose.
// MERGE NOTE: the database applies migrations by number and skips any number at or below its stored version. A stockman.db opened by a
// build that has 10 and 11 but not 8 and 9 would later skip the ledger's tables. Merge the trading layer before running both on real data.
const { createScoring } = require('./scoring');
const { createShadow } = require('./shadow');
const { createCalibration } = require('./calibration');

// data: the data layer's api ({ universe, bars, calendar, runs, earnings }); deps: { now, autoRun, options: { shadow, calibration } }
function createLearningLayer({ data, now = Date.now, autoRun = true, options = {} } = {}) {
  if (!data) throw new TypeError('createLearningLayer needs the data layer api');
  const scoring = createScoring();
  const shadow = createShadow({ scoring: scoring.api, universe: data.universe, runs: data.runs, bars: data.bars, earnings: data.earnings, now, opts: { autoRun, ...options.shadow } });
  const calibration = createCalibration({ scoring: scoring.api, now, opts: { autoRun, ...options.calibration } });
  return { features: [scoring.feature, shadow.feature, calibration.feature], api: { scoring: scoring.api, shadow: shadow.api, calibration: calibration.api } };
}

module.exports = { createLearningLayer };
