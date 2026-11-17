// Feature "scoring" (vault Phases 3/4, note 06 "Scoring model v1 and trade mechanics", D21): the volatility-scaled short-term reversal.
// Deterministic and pure: no LLM (D7), no randomness, no clock, no network. The same inputs always give the same score; a test pins it.
// Reads only: `bar` (daily bars), `bar_history` (which symbols the provider does not know: the survivorship gap G24) and what the caller
// passes in (point-in-time members, earnings flags from the earnings feature). It writes nothing; the shadow feature stores the scores
// together with SCORING_BUILD, so every stored score says which code produced it (note 07 rule 5).
//
// Rule (note 06, fixed before any result was seen; do not tune it on the holdout):
//   r5     adjusted return from the close 5 sessions before D to the close of D
//   vol20  sample standard deviation of the daily adjusted returns over the 20 sessions to D
//   score  -r5 / (vol20 * sqrt(5))          higher = a bigger loser for its own volatility
//   eligible: point-in-time member on D; at least 60 clean bars; close above USD 5; no earnings_in_window and no earnings_possible flag;
//             no missing bar among the last 25 sessions. An ineligible candidate is still scored (when it can be) and carries its reasons.
//   basket: the 20 eligible candidates with the highest score (ties: symbol A to Z), equal weight, long only.
//   trade:  entry = open of the next session, exit = close of the 5th session held (the 5th session counting the entry session).
// Variants (note 06: at most 6, all logged): lookback 3, 5 or 10 sessions, with or without the volatility scaling. `rev5s` is the
// primary rule. The variant scores are derived from the same stored features, so logging them costs nothing and changes nothing.
const { tradingDays, nextTradingDay } = require('../features/calendar-rules');
const { addDays } = require('../features/ny-time');
const { StockmanError } = require('../errors');

// Bump on ANY change to a formula, a threshold, an eligibility rule or the variant list. Old and new scores are never mixed (note 06).
const SCORING_BUILD = 'rev-v1.0';
const PARAMS = Object.freeze({ lookback: 5, volWindow: 20, minBars: 60, minPrice: 5, gapWindow: 25, basketSize: 20, horizon: 5, priceBasis: 'adj_close' });
const MAX_VARIANTS = 6;   // note 06
const VARIANTS = Object.freeze([
  Object.freeze({ id: 'rev3s', lookback: 3, scaled: true }), Object.freeze({ id: 'rev3', lookback: 3, scaled: false }),
  Object.freeze({ id: 'rev5s', lookback: 5, scaled: true }), Object.freeze({ id: 'rev5', lookback: 5, scaled: false }),
  Object.freeze({ id: 'rev10s', lookback: 10, scaled: true }), Object.freeze({ id: 'rev10', lookback: 10, scaled: false }),
]);
const PRIMARY_VARIANT = 'rev5s';
if (VARIANTS.length > MAX_VARIANTS) throw new StockmanError(`scoring: ${VARIANTS.length} variants, note 06 allows at most ${MAX_VARIANTS}`);

const SESSIONS_NEEDED = Math.max(PARAMS.gapWindow, PARAMS.volWindow + 1, Math.max(...VARIANTS.map(v => v.lookback)) + 1);
const finitePos = x => typeof x === 'number' && Number.isFinite(x) && x > 0;
// a bar counts as clean when every price is a finite positive number, high is not below low, and volume is not negative
const CLEAN_SQL = 'adj_close > 0 AND close > 0 AND open > 0 AND low > 0 AND high >= low AND volume >= 0';
// the same rule in JavaScript, for callers that already hold the rows (the backtest engine). A test checks that it agrees with CLEAN_SQL.
const isCleanBar = b => finitePos(b.adj_close) && finitePos(b.close) && finitePos(b.open) && finitePos(b.low) && typeof b.high === 'number' && b.high >= b.low && typeof b.volume === 'number' && b.volume >= 0;
// the id of the variant with this lookback and scaling ('rev5s', 'rev3')
const variantId = ({ lookback, volScale }) => `rev${lookback}${volScale ? 's' : ''}`;

// the entry session and the exit session of a trade signalled at the close of `day`
function horizonDays(day) {
  const entryDay = nextTradingDay(day);
  let exitDay = entryDay;
  for (let i = 1; i < PARAMS.horizon; i++) exitDay = nextTradingDay(exitDay);
  return { entryDay, exitDay };
}

// the last `n` trading sessions up to and including `day` (`day` must be a session)
function sessionsEnding(day, n = SESSIONS_NEEDED) {
  const list = tradingDays(addDays(day, -Math.ceil(n * 1.7) - 14), day);
  if (list.at(-1) !== day) throw new TypeError(`scoring: ${day} is not a trading session`);
  return list.slice(-n);
}

// the close `i` sessions before the last session of `sessions`, or null when it is missing or unusable (never guessed)
const adjReader = (sessions, adjOn) => {
  const n = sessions.length;
  return i => { const v = n - 1 - i >= 0 ? adjOn(sessions[n - 1 - i]) : null; return finitePos(v) ? v : null; };
};
// sample standard deviation of the `window` daily returns to the last session; null when a close is missing. Shared by both rules.
function dailyVol(adj, window) {
  const rets = [];
  for (let i = 0; i < window; i++) {
    const a = adj(i), b = adj(i + 1);
    if (a === null || b === null) return null;
    rets.push(a / b - 1);
  }
  let sum = 0;
  for (const r of rets) sum += r;
  const mean = sum / rets.length;
  let ss = 0;
  for (const r of rets) ss += (r - mean) * (r - mean);
  return Math.sqrt(ss / (rets.length - 1));
}

// features from adjusted closes. sessions: ascending, ends at D. adjOn(day) → number or null (a missing or unusable bar).
// A feature is null (never guessed) when a close it needs is missing.
function computeFeatures({ sessions, adjOn }) {
  const adj = adjReader(sessions, adjOn);
  const f = { r3: null, r5: null, r10: null, vol20: null };
  for (const L of [3, 5, 10]) {
    const a = adj(0), b = adj(L);
    if (a !== null && b !== null) f[`r${L}`] = a / b - 1;
  }
  f.vol20 = dailyVol(adj, PARAMS.volWindow);
  return f;
}

function variantScores(f) {
  const out = {};
  for (const v of VARIANTS) {
    const r = f[`r${v.lookback}`];
    if (r === null || r === undefined) { out[v.id] = null; continue; }
    if (!v.scaled) { out[v.id] = -r; continue; }
    out[v.id] = f.vol20 === null || f.vol20 === undefined || f.vol20 <= 0 ? null : -r / (f.vol20 * Math.sqrt(v.lookback));
  }
  return out;
}

// one symbol on one day. input: { notFound, hasBarOnDay, nBars, close, features, gap25, flags }
//   flags: the earnings feature's flags() for this trade window, or null when there is no earnings data at all.
//   variant: which variant's score decides eligibility (default: the primary rule). The reasons for the primary rule are exactly as before.
function scoreCandidate({ notFound = false, hasBarOnDay, nBars = 0, close = null, features = null, gap25 = false, flags = null, variant = PRIMARY_VARIANT }) {
  const reasons = [];
  if (notFound) reasons.push('provider_has_no_bars');
  if (!hasBarOnDay) { reasons.push('no_bar_on_day'); return { eligible: false, reasons, score: null, variants: variantScores({}), features: null }; }
  if (nBars < PARAMS.minBars) reasons.push('insufficient_history');
  if (!(close > PARAMS.minPrice)) reasons.push('price_not_above_5');
  if (gap25) reasons.push('bar_gap_25');
  const f = features || { r3: null, r5: null, r10: null, vol20: null };
  const variants = variantScores(f);
  const v = VARIANTS.find(x => x.id === variant);
  if (!v) throw new StockmanError(`scoring: unknown variant ${variant}`);
  const score = variants[variant];
  const missing = f[`r${v.lookback}`] == null || (v.scaled && f.vol20 == null);
  if (missing) reasons.push('no_features');   // a close the features need is missing
  else if (score === null) reasons.push('zero_volatility');
  if (flags && flags.earnings_in_window) reasons.push('earnings_in_window');
  if (flags && flags.earnings_possible) reasons.push('earnings_possible');
  return { eligible: reasons.length === 0, reasons, score, variants, features: { ...f, close, nBars } };
}

// rank the eligible candidates of one day. Ties break by symbol so the basket never depends on input order.
function selectBasket(rows, size = PARAMS.basketSize) {
  const eligible = rows.filter(r => r.eligible && r.score !== null).sort((a, b) => (b.score - a.score) || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  const out = new Map();
  eligible.forEach((r, i) => out.set(r.symbol, { rank: i + 1, inBasket: i < size }));
  return out;
}

// ===== Rule 2: momentum, "mom-v1" (note 06 "Rule 2: momentum", decision D25; pre-registered before any result) =====
//   m      adjusted return over L sessions that ends 21 sessions before D:  adjclose(D-21) / adjclose(D-21-L) - 1,  L = 63, 126 or 252
//   vol60  sample standard deviation of the 60 daily adjusted returns to D
//   score  raw: m        vol: m / (vol60 * sqrt(L))        higher = stronger
//   eligible: as the reversal rule (member, close above USD 5, no earnings flag, no missing bar in the last 25 sessions), except history:
//             at least L + 22 clean bars.   basket and trade: as the reversal rule (top 20, entry next open, exit 5th close).
// Variants (at most 6, counted per rule; 12 across both rules once all are run): L in {63, 126, 252}, each raw or vol. There is NO primary variant:
// nothing is picked before the tuning result. The reversal rule above is untouched by this block.
const MOM_BUILD = 'mom-v1.0';
const MOM_PARAMS = Object.freeze({ skip: 21, volWindow: 60, minPrice: 5, gapWindow: 25, basketSize: 20, horizon: 5, extraHistory: 22, priceBasis: 'adj_close' });
const MOM_VARIANTS = Object.freeze([63, 126, 252].flatMap(L => [
  Object.freeze({ id: `mom${L}s`, lookback: L, scaled: true }), Object.freeze({ id: `mom${L}`, lookback: L, scaled: false }),
]));
if (MOM_VARIANTS.length > MAX_VARIANTS) throw new StockmanError(`scoring: ${MOM_VARIANTS.length} momentum variants, note 06 allows at most ${MAX_VARIANTS}`);
const MOM_SESSIONS_NEEDED = MOM_PARAMS.skip + Math.max(...MOM_VARIANTS.map(v => v.lookback)) + 1;   // 274
const momVariantId = ({ lookback, volScale }) => `mom${lookback}${volScale ? 's' : ''}`;

function computeMomentumFeatures({ sessions, adjOn }) {
  const adj = adjReader(sessions, adjOn);
  const f = { m63: null, m126: null, m252: null, vol60: null };
  for (const L of [63, 126, 252]) {
    const a = adj(MOM_PARAMS.skip), b = adj(MOM_PARAMS.skip + L);
    if (a !== null && b !== null) f[`m${L}`] = a / b - 1;
  }
  f.vol60 = dailyVol(adj, MOM_PARAMS.volWindow);
  return f;
}

function momentumVariantScores(f) {
  const out = {};
  for (const v of MOM_VARIANTS) {
    const m = f[`m${v.lookback}`];
    if (m === null || m === undefined) { out[v.id] = null; continue; }
    if (!v.scaled) { out[v.id] = m; continue; }
    out[v.id] = f.vol60 === null || f.vol60 === undefined || f.vol60 <= 0 ? null : m / (f.vol60 * Math.sqrt(v.lookback));
  }
  return out;
}

// same input and output shape as scoreCandidate; `variant` is required (there is no primary momentum variant)
function scoreMomentumCandidate({ notFound = false, hasBarOnDay, nBars = 0, close = null, features = null, gap25 = false, flags = null, variant }) {
  const v = MOM_VARIANTS.find(x => x.id === variant);
  if (!v) throw new StockmanError(`scoring: unknown momentum variant ${variant}`);
  const reasons = [];
  if (notFound) reasons.push('provider_has_no_bars');
  if (!hasBarOnDay) { reasons.push('no_bar_on_day'); return { eligible: false, reasons, score: null, variants: momentumVariantScores({}), features: null }; }
  if (nBars < v.lookback + MOM_PARAMS.extraHistory) reasons.push('insufficient_history');
  if (!(close > MOM_PARAMS.minPrice)) reasons.push('price_not_above_5');
  if (gap25) reasons.push('bar_gap_25');
  const f = features || { m63: null, m126: null, m252: null, vol60: null };
  const variants = momentumVariantScores(f);
  const score = variants[variant];
  const missing = f[`m${v.lookback}`] == null || (v.scaled && f.vol60 == null);
  if (missing) reasons.push('no_features');
  else if (score === null) reasons.push('zero_volatility');
  if (flags && flags.earnings_in_window) reasons.push('earnings_in_window');
  if (flags && flags.earnings_possible) reasons.push('earnings_possible');
  return { eligible: reasons.length === 0, reasons, score, variants, features: { ...f, close, nBars } };
}

// one entry per rule: the single place that says which functions and settings score that rule
const RULES = Object.freeze({
  reversal: Object.freeze({ id: 'reversal', build: SCORING_BUILD, params: PARAMS, variants: VARIANTS, primary: PRIMARY_VARIANT, sessionsNeeded: SESSIONS_NEEDED, historyNeeded: () => SESSIONS_NEEDED, computeFeatures, variantScores, scoreCandidate }),
  momentum: Object.freeze({ id: 'momentum', build: MOM_BUILD, params: MOM_PARAMS, variants: MOM_VARIANTS, primary: null, sessionsNeeded: MOM_SESSIONS_NEEDED, historyNeeded: v => MOM_PARAMS.skip + v.lookback + 1, computeFeatures: computeMomentumFeatures, variantScores: momentumVariantScores, scoreCandidate: scoreMomentumCandidate }),
});

function createScoring() {
  let db = null;

  // the bars scoring needs for these symbols on `day`: the last `n` sessions, the count of clean bars, the provider's not-found list
  function loadDayInputs(day, symbols, n = SESSIONS_NEEDED) {
    const sessions = sessionsEnding(day, n);
    const list = JSON.stringify(symbols);
    const bars = new Map();   // symbol → { adj: Map(day → adj), closeOn: close of `day`|null, present: Set(days) }
    for (const r of db.stmt('SELECT symbol, day, close, adj_close AS adj FROM bar WHERE day >= ? AND day <= ? AND symbol IN (SELECT value FROM json_each(?))').all(sessions[0], day, list)) {
      let b = bars.get(r.symbol);
      if (!b) bars.set(r.symbol, b = { adj: new Map(), closeOn: null, present: new Set() });
      b.present.add(r.day);
      if (finitePos(r.adj) && finitePos(r.close)) b.adj.set(r.day, r.adj);
      if (r.day === day) b.closeOn = r.close;
    }
    const counts = new Map(db.stmt(`SELECT symbol, COUNT(*) AS n FROM bar WHERE day <= ? AND ${CLEAN_SQL} AND symbol IN (SELECT value FROM json_each(?)) GROUP BY symbol`).all(day, list).map(r => [r.symbol, Number(r.n)]));
    const notFound = new Set(db.stmt("SELECT symbol FROM bar_history WHERE status = 'not_found' AND symbol IN (SELECT value FROM json_each(?))").all(list).map(r => r.symbol));
    return { sessions, bars, counts, notFound };
  }

  // score every symbol for the signal day `day`. flagsOf(symbol, entryDay, exitDay) → earnings flags or null (optional).
  // Returns { day, build, entryDay, exitDay, rows } with rows sorted by symbol; each row has symbol, eligible, reasons, score, rank, inBasket,
  // features, variants, earnings.
  //   rule: 'reversal' (default, unchanged) or 'momentum' (then `variant` is required)
  function scoreDay({ day, symbols, flagsOf = null, rule = 'reversal', variant = null }) {
    if (!db) throw new StockmanError('scoring: not started');
    const R = RULES[rule];
    if (!R) throw new StockmanError(`scoring: unknown rule ${rule}`);
    // variant 'all' (momentum only): score every variant of the rule from the same features, for the shadow log
    const all = rule === 'momentum' && variant === 'all';
    const which = all ? null : (variant || R.primary);
    if (!all && !which) throw new StockmanError(`scoring: rule ${rule} has no primary variant; name one`);
    const uniq = [...new Set(symbols)].sort();
    const { entryDay, exitDay } = horizonDays(day);
    const { sessions, bars, counts, notFound } = loadDayInputs(day, uniq, R.sessionsNeeded);
    const gapSessions = sessions.slice(-R.params.gapWindow);
    const rows = uniq.map(symbol => {
      const b = bars.get(symbol);
      const hasBarOnDay = Boolean(b && b.present.has(day));
      const features = hasBarOnDay ? R.computeFeatures({ sessions, adjOn: d => b.adj.get(d) ?? null }) : null;
      const gap25 = !b || gapSessions.some(d => !b.present.has(d));
      let flags = null;
      if (hasBarOnDay && flagsOf) { try { flags = flagsOf(symbol, entryDay, exitDay) || null; } catch { flags = { earnings_data: 'unknown', error: true }; } }
      const input = { notFound: notFound.has(symbol), hasBarOnDay, nBars: counts.get(symbol) || 0, close: b ? b.closeOn : null, features, gap25, flags };
      if (!all) return { symbol, ...R.scoreCandidate({ ...input, variant: which }), earnings: flags };
      const perVariant = {};
      for (const v of R.variants) perVariant[v.id] = R.scoreCandidate({ ...input, variant: v.id });
      const list = Object.values(perVariant), first = list[0];
      // the row itself carries what every variant agrees on; each variant's own verdict is in perVariant
      return { symbol, eligible: list.some(s => s.eligible), reasons: first.reasons.filter(q => list.every(s => s.reasons.includes(q))), score: null, variants: first.variants, features: first.features, earnings: flags, perVariant };
    });
    if (all) {
      for (const v of R.variants) {
        const basket = selectBasket(rows.map(r => ({ symbol: r.symbol, eligible: r.perVariant[v.id].eligible, score: r.perVariant[v.id].score })), R.params.basketSize);
        for (const r of rows) {
          const k = basket.get(r.symbol), s = r.perVariant[v.id];
          r.perVariant[v.id] = { eligible: s.eligible, reasons: s.reasons, score: s.score, rank: k ? k.rank : null, inBasket: Boolean(k && k.inBasket) };
        }
      }
      for (const r of rows) { r.rank = null; r.inBasket = false; }
      return { day, build: R.build, entryDay, exitDay, rows };
    }
    const basket = selectBasket(rows, R.params.basketSize);
    for (const r of rows) { const k = basket.get(r.symbol); r.rank = k ? k.rank : null; r.inBasket = Boolean(k && k.inBasket); }
    return { day, build: R.build, entryDay, exitDay, rows };
  }

  const api = { build: SCORING_BUILD, rules: RULES, params: PARAMS, variants: VARIANTS, primaryVariant: PRIMARY_VARIANT, scoreDay, loadDayInputs, computeFeatures, scoreCandidate, selectBasket, variantScores, horizonDays, sessionsEnding };
  const feature = { id: 'scoring', async start(ctx) { db = ctx.db; }, async stop() {} };
  return { feature, api };
}

module.exports = { MOM_BUILD, MOM_PARAMS, MOM_VARIANTS, MOM_SESSIONS_NEEDED, momVariantId, computeMomentumFeatures, momentumVariantScores, scoreMomentumCandidate, RULES, isCleanBar, variantId, createScoring, SCORING_BUILD, PARAMS, VARIANTS, PRIMARY_VARIANT, MAX_VARIANTS, computeFeatures, variantScores, scoreCandidate, selectBasket, horizonDays, sessionsEnding, CLEAN_SQL };
