// The trading side of StockMan: the paper ledger (migration 8), the cost model, and the backtest tool (migration 9).
// Paper only: nothing in this folder can place an order (vault D1, D14; the broker route in D23 is approved but NOT built).
// Registered by worker.js and cli.js AFTER the data layer, whose universe and earnings APIs the backtest reads (`data` = createDataLayer().api).
const { createLedger, createMemoryFillPort } = require('./ledger');
const { createBacktest } = require('./backtest');
const { createPaper } = require('./paper');
const costs = require('./costs');

function createTradingLayer({ data = {}, now = Date.now, options = {} } = {}) {
  const ledger = createLedger({ now });
  const backtest = createBacktest({ ledger: ledger.api, data, now, opts: options.backtest });
  // the paper-trade opener needs the learning layer's shadow candidates (data.shadow, data.scoring, data.bars); it is OFF unless options.paper.enabled
  const out = { features: [ledger.feature, backtest.feature], api: { ledger: ledger.api, backtest: backtest.api, costs } };
  if (data.shadow && data.scoring && data.bars) {
    const paper = createPaper({ ledger: ledger.api, shadow: data.shadow, scoring: data.scoring, bars: data.bars, now, opts: options.paper });
    out.features.push(paper.feature); out.api.paper = paper.api;
  }
  return out;
}

module.exports = { createTradingLayer, createMemoryFillPort, costs };
