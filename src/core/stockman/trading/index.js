// The trading side of StockMan: the paper ledger (migration 8), the cost model, and the backtest tool (migration 9).
// Paper only: nothing in this folder can place an order (vault D1, D14; the broker route in D23 is approved but NOT built).
// Registered by worker.js and cli.js AFTER the data layer, whose universe and earnings APIs the backtest reads (`data` = createDataLayer().api).
const { createLedger, createMemoryFillPort } = require('./ledger');
const { createBacktest } = require('./backtest');
const costs = require('./costs');

function createTradingLayer({ data = {}, now = Date.now, options = {} } = {}) {
  const ledger = createLedger({ now });
  const backtest = createBacktest({ ledger: ledger.api, data, now, opts: options.backtest });
  return { features: [ledger.feature, backtest.feature], api: { ledger: ledger.api, backtest: backtest.api, costs } };
}

module.exports = { createTradingLayer, createMemoryFillPort, costs };
