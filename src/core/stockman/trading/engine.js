// The backtest engine (vault note 06 "Scoring model v1 and trade mechanics", decision D21). Deterministic code, no LLM, no network, no database:
// everything it needs comes in as arguments, so tests feed it synthetic series.
//
// Rule (pre-registered), signal at the close of session D:
//   r_L   = adjusted close D / adjusted close D-L - 1          (L = lookback: 3, 5 or 10 sessions)
//   vol20 = sample standard deviation of the 20 daily adjusted-close returns up to D
//   score = -r_L / (vol20 * sqrt(L))     with volatility scaling;     score = -r_L     without
// Eligible on D: point-in-time member of the S&P 500 or Nasdaq-100 on D; at least 60 clean bars up to D; close above USD 5 (raw close);
// no bar missing in the last 25 sessions; no earnings_in_window and no earnings_possible flag for entry D+1 and exit D+5.
// Basket: the 20 best scores, equal weight, long only. Entry at the OPEN of D+1, exit at the CLOSE of D+5. A basket starts every session, so five
// overlap: each is one sleeve of 1/5 of capital (sleeve = position on the 5-session grid). No stop, no target.
// Open prices are put on the adjusted basis with the same day's close ratio (adjusted open = open * adj close / close).
// Benchmark: SPY, the same open-to-close dates and the same adjusted basis (a proxy for the S&P 500 total return, vault D22).
//
// Not here, on purpose: the holdout lock and the variant log (backtest.js), and any storage.
const { stdev, mean, blockBootstrapMean } = require('./stats');
const { REPORT_BPS, BASE_BPS, roundTrip } = require('./costs');

const SCORING_BUILD = 'reversal-v1';
const TOP_N = 20, MIN_BARS = 60, MIN_PRICE = 5, GAP_WINDOW = 25, VOL_WINDOW = 20, HOLD = 5;
const LOOKBACKS = Object.freeze([3, 5, 10]);

// ---- variants: at most 6 (lookback 3, 5 or 10 sessions; with or without the volatility scaling) -------------------------------------
const variantKey = ({ lookback, volScale }) => `rev-L${lookback}-${volScale ? 'vol' : 'raw'}`;
const ALL_VARIANTS = Object.freeze(LOOKBACKS.flatMap(lookback => [true, false].map(volScale => Object.freeze({ lookback, volScale, key: variantKey({ lookback, volScale }) }))));
function parseVariant(key) {
  const v = ALL_VARIANTS.find(x => x.key === key);
  if (!v) throw new RangeError(`unknown variant "${key}"; the six allowed are ${ALL_VARIANTS.map(x => x.key).join(', ')}`);
  return v;
}
const buildId = v => `${SCORING_BUILD}/L${v.lookback}/${v.volScale ? 'vol' : 'raw'}`;

// ---- series on the common session grid --------------------------------------------------------------------------------------------------
// rows: [{ day, open, close, adj_close }] of one symbol, sorted by day. A bar is clean when open, close and adj_close are all finite and positive.
function alignSeries(sessions, index, rows) {
  const S = sessions.length;
  const adj = new Float64Array(S).fill(NaN), adjOpen = new Float64Array(S).fill(NaN), close = new Float64Array(S).fill(NaN);
  for (const r of rows) {
    const i = index.get(r.day);
    if (i === undefined) continue;
    if (!(r.open > 0 && r.close > 0 && r.adj_close > 0)) continue;
    adj[i] = r.adj_close; close[i] = r.close; adjOpen[i] = r.open * (r.adj_close / r.close);
  }
  const cum = new Int32Array(S + 1);   // cum[i + 1] = clean bars in sessions 0..i
  for (let i = 0; i < S; i++) cum[i + 1] = cum[i] + (adj[i] > 0 ? 1 : 0);
  return { adj, adjOpen, close, cum, bars: cum[S] };
}

// ---- the scoring function (also used alone by tests) ----------------------------------------------------------------------------------
function scoreAt(s, d, { lookback, volScale }) {
  const r = s.adj[d] / s.adj[d - lookback] - 1;
  if (!volScale) return Number.isFinite(r) ? -r : null;
  const rets = [];
  for (let i = d - VOL_WINDOW + 1; i <= d; i++) rets.push(s.adj[i] / s.adj[i - 1] - 1);
  const vol = stdev(rets);
  if (!(vol > 0) || !Number.isFinite(r)) return null;
  return -r / (vol * Math.sqrt(lookback));
}

// ---- the run -----------------------------------------------------------------------------------------------------------------------------
// args:
//   sessions      sorted trading days (the benchmark's days)
//   series        Map symbol -> aligned series (alignSeries)
//   benchmark     the benchmark's symbol key in `series`
//   membersAsOf   (day) -> string[]  point-in-time members (both indexes together, de-duplicated)
//   flags         ({symbol, entryDay, exitDay}) -> earnings flags
//   variant       { lookback, volScale }
//   signalRange   { first, last }  session indexes of the first and last signal day to run (inclusive); the caller fixed them from the period
//   gridEnd       session index of the last exit day of the 5-session window grid (windows end at gridEnd, gridEnd-5, ...)
function runBacktest({ sessions, series, benchmark, membersAsOf, flags, variant, signalRange, gridEnd, topN = TOP_N, onDay = null }) {
  const bench = series.get(benchmark);
  if (!bench) throw new Error(`no bars for the benchmark ${benchmark}`);
  const baskets = [], days = [];
  const totals = { excludedBy: { no_bar_on_day: 0, short_history: 0, gap_25: 0, price_at_or_below_5: 0, bad_volatility: 0, bad_return: 0, earnings_in_window: 0, earnings_possible: 0 }, earningsUnknown: 0, lostNames: 0, skippedDays: 0 };
  for (let d = signalRange.first; d <= signalRange.last; d++) {
    if (d < GAP_WINDOW || d + HOLD >= sessions.length) throw new RangeError(`signal day index ${d} is outside the data`);
    const day = sessions[d], e = d + 1, x = d + HOLD, entryDay = sessions[e], exitDay = sessions[x];
    const members = membersAsOf(day);
    const dayRow = { day, members: members.length, noBars: 0, noBarOnDay: 0, eligible: 0, selected: 0, skip: null };
    const scored = [];
    for (const sym of members) {
      const s = series.get(sym);
      if (!s || s.bars === 0) { dayRow.noBars++; continue; }
      if (!(s.adj[d] > 0)) { dayRow.noBarOnDay++; totals.excludedBy.no_bar_on_day++; continue; }
      if (s.cum[d + 1] < MIN_BARS) { totals.excludedBy.short_history++; continue; }
      if (s.cum[d + 1] - s.cum[d + 1 - GAP_WINDOW] < GAP_WINDOW) { totals.excludedBy.gap_25++; continue; }
      if (!(s.close[d] > MIN_PRICE)) { totals.excludedBy.price_at_or_below_5++; continue; }
      const score = scoreAt(s, d, variant);
      if (score === null) { totals.excludedBy[variant.volScale ? 'bad_volatility' : 'bad_return']++; continue; }
      scored.push({ symbol: sym, score, s });
    }
    scored.sort((a, b) => b.score - a.score || (a.symbol < b.symbol ? -1 : 1));
    const picked = [];
    for (const c of scored) {
      if (picked.length >= topN) break;
      const f = flags({ symbol: c.symbol, entryDay, exitDay });
      if (f.earnings_in_window) { totals.excludedBy.earnings_in_window++; continue; }
      if (f.earnings_possible) { totals.excludedBy.earnings_possible++; continue; }
      if (f.earnings_data === 'unknown') totals.earningsUnknown++;
      picked.push(c);
    }
    dayRow.eligible = scored.length;   // passed the data rules (before the earnings rule)
    // names we cannot fill (no open on D+1 or no close on D+5) are dropped and counted, never replaced silently
    const names = [];
    for (const c of picked) {
      const entry = c.s.adjOpen[e], exit = c.s.adj[x];
      if (!(entry > 0) || !(exit > 0)) { totals.lostNames++; continue; }
      names.push({ symbol: c.symbol, score: c.score, expectedEntry: c.s.adj[d], entry, exit, ret: exit / entry - 1 });
    }
    const benchEntry = bench.adjOpen[e], benchExit = bench.adj[x];
    if (picked.length < topN || !names.length || !(benchEntry > 0) || !(benchExit > 0)) {
      dayRow.skip = !(benchEntry > 0 && benchExit > 0) ? 'no_benchmark_price' : picked.length < topN ? `fewer_than_${topN}_candidates` : 'no_fillable_names';
      totals.skippedDays++;
      days.push(dayRow);
      if (onDay) onDay(dayRow);
      continue;
    }
    dayRow.selected = names.length;
    const gross = mean(names.map(n => n.ret)), benchRet = benchExit / benchEntry - 1;
    const sinceEnd = gridEnd - x;   // 0 when this basket exits on a window-grid end
    baskets.push({
      signalDay: day, entryDay, exitDay, signalIdx: d, sleeve: ((sinceEnd % HOLD) + HOLD) % HOLD, grid: sinceEnd % HOLD === 0,
      names, gross, bench: benchRet, benchEntry, benchExit,
    });
    days.push(dayRow);
    if (onDay) onDay(dayRow);
  }
  return { baskets, days, totals };
}

// ---- results ---------------------------------------------------------------------------------------------------------------------------
// Per cost level: mean excess return per trade after cost over the NON-OVERLAPPING windows (the baskets on the window grid), with a 95%
// block-bootstrap interval, plus the mean over all five sleeves (overlapping: a mean only, not independent). excess = gross - cost - benchmark.
function summarize(baskets, { levels = REPORT_BPS, boot = {} } = {}) {
  const grid = baskets.filter(b => b.grid), out = { windows: grid.length, baskets: baskets.length, levels: {}, benchmarkMean: mean(grid.map(b => b.bench)), grossMean: mean(grid.map(b => b.gross)) };
  out.grossExcessMean = mean(grid.map(b => b.gross - b.bench));
  for (const bps of levels) {
    const c = roundTrip(bps);
    const ex = grid.map(b => b.gross - c - b.bench);
    const bs = blockBootstrapMean(ex, boot);
    out.levels[bps] = {
      meanExcess: bs.mean, lower95: bs.lower95, upper95: bs.upper95, winRate: ex.length ? ex.filter(v => v > 0).length / ex.length : NaN,
      meanNet: mean(grid.map(b => b.gross - c)), allSleevesMeanExcess: mean(baskets.map(b => b.gross - c - b.bench)),
      lowerBoundAboveZero: bs.lower95 > 0,
    };
  }
  out.baseBps = BASE_BPS;
  return out;
}

// survivorship gap (vault G24): per day how many point-in-time members had no bars at all, plus a roll-up by year
function gapReport(days) {
  const rows = days.map(d => ({ day: d.day, members: d.members, noBars: d.noBars, noBarOnDay: d.noBarOnDay }));
  const byYear = {};
  for (const r of rows) {
    const y = r.day.slice(0, 4);
    const t = byYear[y] || (byYear[y] = { days: 0, membersSum: 0, noBarsSum: 0, maxNoBars: 0 });
    t.days++; t.membersSum += r.members; t.noBarsSum += r.noBars; t.maxNoBars = Math.max(t.maxNoBars, r.noBars);
  }
  const years = Object.fromEntries(Object.entries(byYear).map(([y, t]) => [y, { days: t.days, avgMembers: t.membersSum / t.days, avgNoBars: t.noBarsSum / t.days, shareNoBars: t.noBarsSum / t.membersSum, maxNoBars: t.maxNoBars }]));
  const mSum = rows.reduce((s, r) => s + r.members, 0), nSum = rows.reduce((s, r) => s + r.noBars, 0), oSum = rows.reduce((s, r) => s + r.noBarOnDay, 0);
  return { days: rows.length, avgNoBars: rows.length ? nSum / rows.length : 0, avgNoBarOnDay: rows.length ? oSum / rows.length : 0, shareNoBars: mSum ? nSum / mSum : 0, maxNoBars: rows.reduce((m, r) => Math.max(m, r.noBars), 0), years };
}

module.exports = { SCORING_BUILD, TOP_N, MIN_BARS, MIN_PRICE, GAP_WINDOW, VOL_WINDOW, HOLD, LOOKBACKS, ALL_VARIANTS, variantKey, parseVariant, buildId, alignSeries, scoreAt, runBacktest, summarize, gapReport };
