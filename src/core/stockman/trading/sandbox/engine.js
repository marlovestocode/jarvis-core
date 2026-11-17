// The sandbox strategy engine (vault D28, CL-0071): from a strategy (strategy.js) and aligned daily series, build the target portfolio for a signal
// day. Pure and deterministic: no database, no network, no clock. The live scheduler (sandbox.js) and the tuner (tuner.js) both call it, so a
// plan and a simulation can never disagree about what the strategy means.
//   signals (each z-scored across the eligible universe, then the weighted sum is ranked, ties by symbol A to Z):
//     momentum  pastReturn(skip, L), optionally divided by the 60-day volatility and sqrt(L)   (the formula of learning/scoring.js, not a copy)
//     reversal  -pastReturn(0, L), optionally divided by the 20-day volatility and sqrt(L)
//     trend     adjusted close over its N-session mean, minus 1
//     lowVol    minus the N-session daily volatility (dailyVol of learning/scoring.js)
//   A symbol with any enabled signal missing (short history, a missing close) is left out and counted, never filled.
//   regime: SPY's adjusted close against its N-session mean; below it the book is cut to half size or to cash.
//   SANDBOX, USER-EDITED, NOT EVIDENCE OF AN EDGE.
const { dailyVol, pastReturn } = require('../../learning/scoring');

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
function zscores(values) {
  const m = mean(values), sd = Math.sqrt(values.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, values.length - 1));
  return values.map(x => (sd > 0 ? (x - m) / sd : 0));
}

// the adjusted closes of one aligned series as "i sessions before session d" (or null): the accessor learning/scoring.js's helpers expect
const adjBefore = (s, d) => i => { const j = d - i; if (j < 0) return null; const v = s.adj[j]; return v > 0 ? v : null; };

// raw signal values of one symbol at session d, or null for the whole symbol when any enabled signal cannot be computed
function signalsOf(strategy, s, d) {
  const adj = adjBefore(s, d), g = strategy.signals, out = {};
  if (g.momentum.enabled && g.momentum.weight > 0) {
    const m = pastReturn(adj, g.momentum.skip, g.momentum.lookback);
    if (m === null) return null;
    if (g.momentum.volScale) { const v = dailyVol(adj, 60); if (v === null || !(v > 0)) return null; out.momentum = m / (v * Math.sqrt(g.momentum.lookback)); } else out.momentum = m;
  }
  if (g.reversal.enabled && g.reversal.weight > 0) {
    const r = pastReturn(adj, 0, g.reversal.lookback);
    if (r === null) return null;
    if (g.reversal.volScale) { const v = dailyVol(adj, 20); if (v === null || !(v > 0)) return null; out.reversal = -r / (v * Math.sqrt(g.reversal.lookback)); } else out.reversal = -r;
  }
  if (g.trend.enabled && g.trend.weight > 0) {
    let sum = 0;
    for (let i = 0; i < g.trend.days; i++) { const v = adj(i); if (v === null) return null; sum += v; }
    out.trend = adj(0) / (sum / g.trend.days) - 1;
  }
  if (g.lowVol.enabled && g.lowVol.weight > 0) {
    const v = dailyVol(adj, g.lowVol.days);
    if (v === null || !(v > 0)) return null;
    out.lowVol = -v;
  }
  return out;
}

// regime factor at session d: 1 (on), 0.5 (halfSize) or 0 (cash)
function regimeAt(strategy, bench, d) {
  if (!strategy.regime.enabled) return { on: true, factor: 1, reason: 'regime filter off' };
  const adj = adjBefore(bench, d);
  let sum = 0;
  for (let i = 0; i < strategy.regime.days; i++) { const v = adj(i); if (v === null) return { on: true, factor: 1, reason: 'not enough SPY history: filter not applied' }; sum += v; }
  const avg = sum / strategy.regime.days, above = adj(0) >= avg;
  return { on: above, factor: above ? 1 : strategy.regime.below === 'cash' ? 0 : 0.5, spy: adj(0), average: avg, reason: above ? 'SPY above its average' : `SPY below its ${strategy.regime.days}-session average: ${strategy.regime.below}` };
}

// ctx: { d (session index of the signal day), members [symbols], series Map(symbol → aligned), bench (aligned SPY), dollarVolume?(symbol) → avg daily USD volume,
//        excluded?(symbol) → reason|null  (earnings), sessions? }
// → { regime, targets: [{ symbol, score, weight, notionalUsd, price, vol }], counts: { members, eligible, ... } }
function buildTargets(strategy, ctx) {
  const { d, members, series, bench } = ctx;
  const counts = { members: members.length, noBars: 0, price: 0, dollarVolume: 0, pinned: 0, earnings: 0, history: 0, scored: 0 };
  const cand = [];
  for (const symbol of members) {
    const s = series.get(symbol);
    if (!s || !s.anyBar || !(s.close[d] > 0)) { counts.noBars++; continue; }
    if (s.close[d] < strategy.universe.minPrice) { counts.price++; continue; }
    if (ctx.dollarVolume && strategy.universe.minAvgDollarVolume > 0) { const dv = ctx.dollarVolume(symbol); if (!(dv >= strategy.universe.minAvgDollarVolume)) { counts.dollarVolume++; continue; } }
    if (ctx.excluded && strategy.universe.excludeEarningsDays > 0 && ctx.excluded(symbol)) { counts.earnings++; continue; }
    const sig = signalsOf(strategy, s, d);
    if (!sig) { counts.history++; continue; }
    const vol = dailyVol(adjBefore(s, d), 60);
    // a name that barely moves (a pending takeover, a halted stock) would top a low-volatility ranking and dominate inverse-volatility weights: left out, counted
    if (vol !== null && vol * 100 < strategy.universe.minVolPct) { counts.pinned++; continue; }
    cand.push({ symbol, sig, price: s.close[d], vol });
  }
  counts.scored = cand.length;
  const names = Object.keys(strategy.signals).filter(n => strategy.signals[n].enabled && strategy.signals[n].weight > 0);
  const z = {};
  for (const n of names) z[n] = zscores(cand.map(c => c.sig[n]));
  cand.forEach((c, i) => { c.score = names.reduce((sum, n) => sum + strategy.signals[n].weight * z[n][i], 0); });
  cand.sort((a, b) => (b.score - a.score) || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  const top = cand.slice(0, strategy.portfolio.topN);
  const regime = regimeAt(strategy, bench, d);
  const floor = strategy.portfolio.volFloorPct / 100;
  const inv = top.map(c => (c.vol > 0 ? 1 / Math.max(c.vol, floor) : 0)), invSum = inv.reduce((a, b) => a + b, 0);
  const R = strategy.risk, capital = R.capitalUsd, gross = capital * Math.min(R.maxGrossPct, 100) / 100 * regime.factor, cap = capital * R.maxPositionPct / 100;
  // weights, then the per-name cap by water-filling: a name above the cap is held at the cap and its excess goes to the others in proportion, until
  // none is above it (a few ultra-low-volatility names must not take the whole book). If the caps cannot hold the target gross, the rest stays cash.
  const w0 = top.map((c, i) => (strategy.portfolio.weighting === 'invVol' && invSum > 0 ? inv[i] / invSum : 1 / top.length));
  const alloc = new Array(top.length).fill(0), capped = new Array(top.length).fill(false);
  let remaining = gross;
  for (let round = 0; round < top.length + 1; round++) {
    const free = top.map((_, i) => i).filter(i => !capped[i]), wSum = free.reduce((a, i) => a + w0[i], 0);
    if (!free.length || !(wSum > 0) || !(remaining > 0)) break;
    const over = free.filter(i => remaining * w0[i] / wSum > cap);
    if (!over.length) { for (const i of free) alloc[i] = remaining * w0[i] / wSum; break; }
    for (const i of over) { alloc[i] = cap; capped[i] = true; remaining -= cap; }
  }
  const targets = top.map((c, i) => ({ symbol: c.symbol, score: c.score, weight: gross > 0 ? alloc[i] / gross : 0, notionalUsd: Math.round(alloc[i] * 100) / 100, clipped: capped[i], price: c.price, vol: c.vol })).filter(t => t.notionalUsd >= 1);
  return { regime, targets, counts };
}

// does session index d fall on the strategy's rebalance calendar? `days` are the 'YYYY-MM-DD' strings of the sessions; d must have a next session in range
function isRebalanceDay(rule, days, d, nextDay = null) {
  if (rule === 'daily') return true;
  const day = days[d], dow = new Date(`${day}T00:00:00Z`).getUTCDay();   // 0 Sunday
  const wk = /^weekly:(mon|tue|wed|thu|fri)$/.exec(rule);
  if (wk) return dow === ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(wk[1]);
  const mo = /^monthly:(first|last)$/.exec(rule);
  if (!mo) return false;
  const month = x => x.slice(0, 7);
  if (mo[1] === 'first') return d === 0 || month(days[d - 1]) !== month(day);
  const next = d + 1 < days.length ? days[d + 1] : nextDay;           // live: the calendar's next session, because the data ends today
  return next ? month(next) !== month(day) : true;
}

// ---- simulation (tuner) ---------------------------------------------------------------------------------------------------------------
// Hold each rebalance's portfolio from its signal-day close to the NEXT rebalance's signal-day close, equal to the strategy's own calendar:
// excess = factor * sum(w_i * ret_i) - benchmark return - cost, with cost = costBps per side on the share of names that changed. Past data only.
// rebalances: ascending session indexes; the last one only closes the previous period. `members(d)` → symbols; `excluded(symbol, d)` optional.
function simulate(strategy, { rebalances, series, bench, members, excluded = null, costBps = 10 }) {
  const periods = [];
  let prev = null;
  for (let k = 0; k + 1 < rebalances.length; k++) {
    const d = rebalances[k], e = rebalances[k + 1];
    const plan = buildTargets(strategy, { d, members: members(d), series, bench, excluded: excluded ? sym => excluded(sym, d) : null });
    const t = plan.targets;
    if (!t.length && plan.regime.factor > 0) { prev = null; continue; }
    let ret = 0;
    for (const x of t) {
      const s = series.get(x.symbol), a = s.adj[d], b = s.adj[e];
      ret += x.notionalUsd / strategy.risk.capitalUsd * (b > 0 && a > 0 ? b / a - 1 : 0);
    }
    const spy = bench.adj[e] / bench.adj[d] - 1;
    const names = new Set(t.map(x => x.symbol));
    const changed = prev ? [...names].filter(n => !prev.has(n)).length + [...prev].filter(n => !names.has(n)).length : names.size;
    const gross = t.reduce((s, x) => s + x.notionalUsd, 0) / strategy.risk.capitalUsd;
    const turnover = names.size || prev?.size ? changed / Math.max(1, (names.size + (prev ? prev.size : 0))) : 0;
    const cost = gross * turnover * 2 * (costBps / 1e4);
    periods.push({ d, e, ret, spy, cost, excess: ret - spy - cost, factor: plan.regime.factor, n: t.length });
    prev = names;
  }
  return periods;
}

module.exports = { buildTargets, signalsOf, regimeAt, isRebalanceDay, simulate, zscores, adjBefore };
