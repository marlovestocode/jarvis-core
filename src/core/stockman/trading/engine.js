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
// ONE SCORER (CL-0046): this file does not implement the rule. Features, eligibility, the score and the ranking are the functions of
// ../learning/scoring.js (computeFeatures, scoreCandidate, selectBasket), the same code the live shadow feature runs, so a backtest and a
// live day cannot drift apart. This file adds only what the backtest needs on top: the session grid, the entry and exit fills, the sleeves,
// the benchmark and the statistics. A change to the rule is a change to scoring.js and bumps its SCORING_BUILD.
//
// Not here, on purpose: the holdout lock and the variant log (backtest.js), and any storage.
const { mean, blockBootstrapMean } = require('./stats');
const { REPORT_BPS, BASE_BPS, roundTrip } = require('./costs');
const S = require('../learning/scoring');

const SCORING_BUILD = S.SCORING_BUILD;   // 'rev-v1.0': the rule's build id; the ledger label of a variant is buildId(v) below
const TOP_N = S.PARAMS.basketSize, MIN_BARS = S.PARAMS.minBars, MIN_PRICE = S.PARAMS.minPrice, GAP_WINDOW = S.PARAMS.gapWindow, VOL_WINDOW = S.PARAMS.volWindow, HOLD = S.PARAMS.horizon;
const SESSIONS_NEEDED = Math.max(GAP_WINDOW, VOL_WINDOW + 1, 11);
const LOOKBACKS = Object.freeze([3, 5, 10]);

// ---- variants: at most 6 (lookback 3, 5 or 10 sessions; with or without the volatility scaling) -------------------------------------
// Two rules (reversal, momentum), at most 6 variants each (D25). A variant carries its rule; a variant without one is a reversal variant.
const ruleOf = v => S.RULES[v.rule || 'reversal'];
const variantKey = ({ lookback, volScale, rule = 'reversal' }) => `${rule === 'momentum' ? 'mom' : 'rev'}-L${lookback}-${volScale ? 'vol' : 'raw'}`;
const ALL_VARIANTS = Object.freeze(LOOKBACKS.flatMap(lookback => [true, false].map(volScale => Object.freeze({ rule: 'reversal', lookback, volScale, key: variantKey({ lookback, volScale }) }))));
const MOMENTUM_VARIANTS = Object.freeze([...new Set(S.MOM_VARIANTS.map(v => v.lookback))].flatMap(lookback => [true, false].map(volScale => Object.freeze({ rule: 'momentum', lookback, volScale, key: variantKey({ rule: 'momentum', lookback, volScale }) }))));
const EVERY_VARIANT = Object.freeze([...ALL_VARIANTS, ...MOMENTUM_VARIANTS]);
function parseVariant(key) {
  const v = EVERY_VARIANT.find(x => x.key === key);
  if (!v) throw new RangeError(`unknown variant "${key}"; the six allowed per rule are reversal: ${ALL_VARIANTS.map(x => x.key).join(', ')}; momentum: ${MOMENTUM_VARIANTS.map(x => x.key).join(', ')}`);
  return v;
}
const ruleVariants = v => (v.rule === 'momentum' ? MOMENTUM_VARIANTS : ALL_VARIANTS);
const buildId = v => `${ruleOf(v).build}/L${v.lookback}/${v.volScale ? 'vol' : 'raw'}`;   // the rule's build id plus the variant, e.g. rev-v1.0/L5/vol, mom-v1.0/L63/raw
const variantIdOf = v => (v.rule === 'momentum' ? S.momVariantId(v) : S.variantId(v));
if (ALL_VARIANTS.length !== S.VARIANTS.length || MOMENTUM_VARIANTS.length !== S.MOM_VARIANTS.length) throw new Error('engine variants must match learning/scoring.js VARIANTS and MOM_VARIANTS');

// ---- series on the common session grid --------------------------------------------------------------------------------------------------
// rows: [{ day, open, high, low, close, adj_close, volume }] of one symbol, sorted by day. The cleanliness rules are scoring.js's (isCleanBar):
//   present[i]   a bar exists that session (a missing bar is a gap, whatever the bar looks like)
//   adj[i]       the adjusted close when adj_close and close are positive, else NaN (the features read this)
//   cum[i + 1]   clean bars in sessions 0..i (the 60-bar rule)
//   adjOpen[i]   the entry price: the open put on the adjusted basis, NaN when the open is unusable
//   close[i]     the raw close as stored (the price rule), NaN when absent
function alignSeries(sessions, index, rows) {
  const n = sessions.length;
  const present = new Uint8Array(n), clean = new Uint8Array(n);
  const adj = new Float64Array(n).fill(NaN), adjOpen = new Float64Array(n).fill(NaN), close = new Float64Array(n).fill(NaN);
  for (const r of rows) {
    const i = index.get(r.day);
    if (i === undefined) continue;
    present[i] = 1;
    if (typeof r.close === 'number') close[i] = r.close;
    if (r.adj_close > 0 && r.close > 0) adj[i] = r.adj_close;
    if (r.adj_close > 0 && r.close > 0 && r.open > 0) adjOpen[i] = r.open * (r.adj_close / r.close);
    if (S.isCleanBar(r)) clean[i] = 1;
  }
  const cum = new Int32Array(n + 1);   // cum[i + 1] = clean bars in sessions 0..i
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + clean[i];
  return { present, adj, adjOpen, close, cum, bars: cum[n], anyBar: present.some(Boolean) };
}

// ---- the scoring function (also used alone by tests) ----------------------------------------------------------------------------------
// The shared features and variant score at session index d (needs d >= 24). null when a close it needs is missing.
const sessionWindow = (d, n = SESSIONS_NEEDED) => Array.from({ length: n }, (_, k) => d - n + 1 + k);
const adjAt = s => i => (s.adj[i] > 0 ? s.adj[i] : null);
function scoreAt(s, d, variant) {
  const R = ruleOf(variant);
  return R.variantScores(R.computeFeatures({ sessions: sessionWindow(d, R.sessionsNeeded), adjOn: adjAt(s) }))[variantIdOf(variant)];
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
  const R = ruleOf(variant), variantId = variantIdOf(variant);
  const bench = series.get(benchmark);
  if (!bench) throw new Error(`no bars for the benchmark ${benchmark}`);
  const baskets = [], days = [];
  const totals = { excludedBy: { no_bar_on_day: 0, short_history: 0, gap_25: 0, price_at_or_below_5: 0, bad_volatility: 0, bad_return: 0, earnings_in_window: 0, earnings_possible: 0 }, earningsUnknown: 0, lostNames: 0, skippedDays: 0 };
  for (let d = signalRange.first; d <= signalRange.last; d++) {
    if (d < GAP_WINDOW || d + HOLD >= sessions.length) throw new RangeError(`signal day index ${d} is outside the data`);
    // a rule that needs a long history is never run on a shortened one (momentum L=252 needs 274 sessions up to the signal day)
    const need = R.historyNeeded(variant);
    if (d + 1 < need) throw new RangeError(`${variant.key || variantId} needs ${need} sessions up to the signal day; only ${d + 1} exist up to ${sessions[d]}`);
    const day = sessions[d], e = d + 1, x = d + HOLD, entryDay = sessions[e], exitDay = sessions[x];
    const members = membersAsOf(day);
    const dayRow = { day, members: members.length, noBars: 0, noBarOnDay: 0, eligible: 0, selected: 0, skip: null };
    const window = sessionWindow(d, Math.min(R.sessionsNeeded, d + 1)), gapFrom = d - GAP_WINDOW + 1;
    const cands = [];
    for (const sym of members) {
      const s = series.get(sym);
      if (!s || !s.anyBar) { dayRow.noBars++; continue; }
      let gap25 = false;
      for (let i = gapFrom; i <= d; i++) if (!s.present[i]) { gap25 = true; break; }
      const input = {
        hasBarOnDay: Boolean(s.present[d]), nBars: s.cum[d + 1], close: Number.isNaN(s.close[d]) ? null : s.close[d], gap25, variant: variantId,
        features: s.present[d] ? R.computeFeatures({ sessions: window, adjOn: adjAt(s) }) : null,
      };
      const r = R.scoreCandidate(input);
      if (!r.eligible || r.score === null) {
        const why = r.reasons;
        if (why.includes('no_bar_on_day')) { dayRow.noBarOnDay++; totals.excludedBy.no_bar_on_day++; }
        else if (why.includes('insufficient_history')) totals.excludedBy.short_history++;
        else if (why.includes('bar_gap_25')) totals.excludedBy.gap_25++;
        else if (why.includes('price_not_above_5')) totals.excludedBy.price_at_or_below_5++;
        else totals.excludedBy[variant.volScale ? 'bad_volatility' : 'bad_return']++;
        continue;
      }
      cands.push({ symbol: sym, eligible: true, score: r.score, s, input });
    }
    // rank with the shared ranking, then walk down it applying the earnings rule (the shared scoreCandidate, given the flags); a flagged name is
    // skipped and the next one is taken, which is the same basket as ranking only the earnings-clean names (a test pins it)
    const rank = S.selectBasket(cands, Infinity);
    cands.sort((a, b) => rank.get(a.symbol).rank - rank.get(b.symbol).rank);
    const picked = [];
    for (const c of cands) {
      if (picked.length >= topN) break;
      const f = flags({ symbol: c.symbol, entryDay, exitDay });
      const r = R.scoreCandidate({ ...c.input, flags: f });
      if (!r.eligible) {
        if (r.reasons.includes('earnings_in_window')) totals.excludedBy.earnings_in_window++;
        else if (r.reasons.includes('earnings_possible')) totals.excludedBy.earnings_possible++;
        continue;
      }
      if (f.earnings_data === 'unknown') totals.earningsUnknown++;
      picked.push(c);
    }
    dayRow.eligible = cands.length;   // passed the data rules (before the earnings rule)
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

module.exports = { SCORING_BUILD, TOP_N, MIN_BARS, MIN_PRICE, GAP_WINDOW, VOL_WINDOW, HOLD, LOOKBACKS, ALL_VARIANTS, MOMENTUM_VARIANTS, EVERY_VARIANT, ruleOf, ruleVariants, variantKey, parseVariant, buildId, alignSeries, scoreAt, sessionWindow, runBacktest, summarize, gapReport };
