// Cost model for paper trades (vault G11, D20). Pure functions, no database, no network.
//   Base case: 10 bps ROUND TRIP (5 per side) for large-cap index stocks. This is an ASSUMPTION, not a measurement (vault note 06).
//   Every result is reported at 5, 10 and 25 bps; 25 is a stress test, not a pass condition.
// One bps is 0.01%. A cost is a fraction of traded value: 10 bps round trip = 0.001 off the trade's return.
const BASE_BPS = 10;
const REPORT_BPS = Object.freeze([5, 10, 25]);
const MODEL_VERSION = 'costs-v1';

function checkBps(bps) {
  if (typeof bps !== 'number' || !Number.isFinite(bps) || bps < 0 || bps > 1000) throw new RangeError(`cost must be 0 to 1000 bps (got ${bps})`);
  return bps;
}
// round-trip cost as a fraction of the traded value
const roundTrip = (bps = BASE_BPS) => checkBps(bps) / 10000;
// one side (entry or exit) is half the round trip
const perSide = (bps = BASE_BPS) => checkBps(bps) / 20000;

// net return of a trade after the round-trip cost (simple subtraction: costs are tiny next to the position, and one rule for every row)
const netReturn = (grossReturn, bps = BASE_BPS) => grossReturn - roundTrip(bps);

// results for each reporting level: { 5: net, 10: net, 25: net }
function netAtLevels(grossReturn, levels = REPORT_BPS) {
  const out = {};
  for (const b of levels) out[b] = netReturn(grossReturn, b);
  return out;
}

// a paper fill price with the per-side cost built in: a buy fills a little higher, a sell a little lower than the expected price
function fillWithCost(expectedPrice, side, bps = BASE_BPS) {
  if (!(expectedPrice > 0)) throw new RangeError('expected price must be positive');
  if (side !== 'buy' && side !== 'sell') throw new RangeError('side is buy or sell');
  return expectedPrice * (1 + (side === 'buy' ? 1 : -1) * perSide(bps));
}

// slippage of a real or simulated fill against the expected price, in bps, signed so that positive = worse for the trader
function slippageBps(expectedPrice, fillPrice, side) {
  if (!(expectedPrice > 0) || !(fillPrice > 0)) throw new RangeError('prices must be positive');
  const d = (fillPrice - expectedPrice) / expectedPrice * 10000;
  return side === 'buy' ? d : -d;
}

module.exports = { BASE_BPS, REPORT_BPS, MODEL_VERSION, roundTrip, perSide, netReturn, netAtLevels, fillWithCost, slippageBps };
