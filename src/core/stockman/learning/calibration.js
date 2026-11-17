// Feature "calibration" (vault G8, D9, note 06 learning settings, note 07 stage S9): a win probability per bucket with an uncertainty
// interval, fed from the shadow outcomes. Its own tables in stockman.db, NOT cortex edges: edge weights strengthen on recall and decay
// with time, neither of which tracks being right (D9).
//   win        the candidate's return beat the benchmark after costs: (excess - cost) > 0. The cost is a stated ASSUMPTION (10 bps round trip,
//              D20, still unmeasured) kept in every run row; the ledger session's cost model replaces it when it lands.
//   buckets    few and fixed before any result: score below 0, 0 to 1, 1 to 2, 2 and above, each split into earnings-clean and
//              earnings-flagged (D19: flagged candidates get their own buckets). 8 in all. Only candidates whose ONLY exclusions are earnings
//              flags are counted; candidates with no bar, a price under USD 5, too little history or a bar gap are not calibrated.
//   shrinkage  a bucket starts as if it had 50 outcomes at the overall base rate (note 06), so a thin bucket stays near the base rate.
//   rolling    each outcome is weighted by 0.5 ^ (trading days since its exit / 250): a half-life of about a year (note 06).
//   reporting  a bucket gives a probability only with at least 200 outcomes spanning at least 30 distinct non-overlapping 5-session windows
//              (note 06); otherwise status 'insufficient_data' and no probability. Interval: a 95% Beta interval whose size is the smaller of
//              the weighted effective sample size and the number of windows (candidates of one day are correlated: count windows, not rows), plus the prior.
//   Brier skill  walk-forward: each outcome is forecast by buckets fitted ONLY on outcomes that were already known at its signal close, and
//              compared with the base rate known then. BSS = 1 - BS / BS_base. Its 95% interval is a block bootstrap by window (seeded, so a
//              run is reproducible). It is a measure on shadow data, not a pass of the holdout test, and not a promise.
//   Versioned: every row carries the scoring build; a new build starts its own buckets and never mixes with an old one.
const { tradingDays, nextTradingDay } = require('../features/calendar-rules');
const { StockmanError } = require('../errors');

const MIGRATION_VERSION = 11;
const migration = {
  version: MIGRATION_VERSION, name: 'calibration',
  up(raw) {
    raw.exec(`
      -- the current buckets of each scoring build (replaced on every compute; the history of what was reported is calibration_run)
      CREATE TABLE calibration_bucket(
        scoring_build TEXT NOT NULL, bucket TEXT NOT NULL, as_of TEXT NOT NULL,
        n INTEGER NOT NULL, wins INTEGER NOT NULL,            -- raw outcome count and wins
        n_w REAL NOT NULL, wins_w REAL NOT NULL, n_eff REAL NOT NULL, windows INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ok','insufficient_data')), reason TEXT,
        p REAL, lo REAL, hi REAL,                              -- null unless status is 'ok'
        PRIMARY KEY(scoring_build, bucket)) WITHOUT ROWID;
      -- one row per compute: the settings used and the Brier skill. Append-only.
      CREATE TABLE calibration_run(
        id INTEGER PRIMARY KEY, scoring_build TEXT NOT NULL, as_of TEXT NOT NULL, created_at INTEGER NOT NULL,
        n_outcomes INTEGER NOT NULL, n_gaps INTEGER NOT NULL, windows INTEGER NOT NULL, base_rate REAL,
        buckets_ok INTEGER NOT NULL, buckets_total INTEGER NOT NULL,
        brier REAL, brier_base REAL, bss REAL, bss_lo REAL, bss_hi REAL, scored_n INTEGER NOT NULL DEFAULT 0, scored_windows INTEGER NOT NULL DEFAULT 0,
        params TEXT NOT NULL, note TEXT);
      CREATE INDEX calibration_run_build ON calibration_run(scoring_build, id);
    `);
  },
};

const PARAMS = Object.freeze({ costBps: 10, halfLifeDays: 250, prior: 50, minOutcomes: 200, minWindows: 30, horizon: 5, bootstrap: 1000, seed: 20261117, level: 0.95, scoreEdges: [0, 1, 2] });
const SCORE_LABELS = ['lt0', '0to1', '1to2', 'ge2'];
const BUCKETS = Object.freeze(SCORE_LABELS.flatMap(s => [`${s}:clean`, `${s}:earnings`]));
const EARNINGS_REASONS = new Set(['earnings_in_window', 'earnings_possible']);
const HISTORY_FROM = '2019-10-01';

function bucketOf(score, earningsFlagged) {
  const e = PARAMS.scoreEdges;
  const label = score < e[0] ? SCORE_LABELS[0] : score < e[1] ? SCORE_LABELS[1] : score < e[2] ? SCORE_LABELS[2] : SCORE_LABELS[3];
  return `${label}:${earningsFlagged ? 'earnings' : 'clean'}`;
}

// ---- Beta distribution (for the interval): regularized incomplete beta by continued fraction, quantile by bisection ------------------
function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
function betacf(a, b, x) {
  const FPMIN = 1e-300;
  let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}
function betaCdf(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
function betaQuantile(q, a, b) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (betaCdf(mid, a, b) < q) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
// small seeded generator: a compute is reproducible
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// trading-day ordinals from HISTORY_FROM; the window of a signal day is floor(ordinal / horizon)
function makeOrdinals(lastDay) {
  const list = tradingDays(HISTORY_FROM, lastDay), map = new Map(list.map((d, i) => [d, i]));
  return d => { const v = map.get(d); if (v === undefined) throw new StockmanError(`calibration: ${d} is not a known trading session`); return v; };
}

// weighted statistics of one bucket from per-day aggregates { ord, n, wins }, using the days whose outcome was known at ordinal `asOfOrd`
function fitStats(days, asOfOrd, P) {
  let n = 0, wins = 0, nw = 0, ww = 0, sw2 = 0;
  const windows = new Set();
  for (const d of days) {
    const exitOrd = d.ord + P.horizon;
    if (exitOrd > asOfOrd) continue;
    const w = Math.pow(0.5, (asOfOrd - exitOrd) / P.halfLifeDays);
    n += d.n; wins += d.wins; nw += w * d.n; ww += w * d.wins; sw2 += w * w * d.n;
    windows.add(Math.floor(d.ord / P.horizon));
  }
  return { n, wins, nw, ww, sw2, windows: windows.size };
}
// the shrunk win probability and its interval; status says whether it may be reported
function estimate(st, base, P) {
  const enough = st.n >= P.minOutcomes && st.windows >= P.minWindows;
  const nEff = st.sw2 > 0 ? (st.nw * st.nw) / st.sw2 : 0;
  const out = { n: st.n, wins: st.wins, nW: st.nw, winsW: st.ww, nEff, windows: st.windows, status: enough ? 'ok' : 'insufficient_data', reason: null, p: null, lo: null, hi: null };
  if (!enough) { out.reason = `need at least ${P.minOutcomes} outcomes over ${P.minWindows} windows; have ${st.n} over ${st.windows}`; return out; }
  const p = Math.min(1 - 1e-6, Math.max(1e-6, (st.ww + P.prior * base) / (st.nw + P.prior)));
  const m = Math.max(1, Math.min(nEff, st.windows)) + P.prior;
  const tail = (1 - P.level) / 2;
  out.p = p; out.lo = betaQuantile(tail, p * m, (1 - p) * m); out.hi = betaQuantile(1 - tail, p * m, (1 - p) * m);
  return out;
}

function createCalibration({ scoring, shadow = null, now = Date.now, opts = {} } = {}) {
  if (!scoring) throw new TypeError('calibration needs the scoring api');
  const o = { tickMs: 30 * 60000, startDelayMs: 8000, healthCacheMs: 30000, autoRun: true, ...opts };
  const P = { ...PARAMS, ...(opts.params || {}) };
  let db = null, log = null, stopping = false, timer = null, startTimer = null, healthCache = null, busy = false;
  void shadow;

  // outcomes that may be calibrated: filled, scored, and excluded for nothing except earnings
  function loadRows(build, asOf) {
    const rows = db.stmt(`SELECT c.day AS day, c.score AS score, c.reasons AS reasons, o.excess AS excess FROM candidate c JOIN candidate_outcome o ON o.candidate_id = c.candidate_id
      WHERE c.scoring_build = ? AND o.status = 'ok' AND c.score IS NOT NULL AND o.exit_day <= ? ORDER BY c.day, c.symbol`).all(build, asOf);
    const gaps = Number(db.stmt("SELECT COUNT(*) AS n FROM candidate c JOIN candidate_outcome o ON o.candidate_id = c.candidate_id WHERE c.scoring_build = ? AND o.status = 'gap'").get(build).n);
    const parsed = new Map();
    const out = [];
    let skipped = 0;
    for (const r of rows) {
      let k = parsed.get(r.reasons);
      if (!k) { const list = JSON.parse(r.reasons); k = { ok: list.every(x => EARNINGS_REASONS.has(x)), earn: list.some(x => EARNINGS_REASONS.has(x)) }; parsed.set(r.reasons, k); }
      if (!k.ok) { skipped++; continue; }
      out.push({ day: r.day, bucket: bucketOf(r.score, k.earn), win: r.excess - P.costBps / 10000 > 0 ? 1 : 0 });
    }
    return { rows: out, gaps, skipped };
  }

  // compute({ build?, asOf? }) → result; stores buckets and one run row. asOf defaults to the newest exit day with an outcome.
  function compute({ build = scoring.build, asOf = null } = {}) {
    if (!db) throw new StockmanError('calibration: not started');
    const newest = db.stmt("SELECT MAX(o.exit_day) AS d FROM candidate_outcome o JOIN candidate c ON c.candidate_id = o.candidate_id WHERE c.scoring_build = ? AND o.status = 'ok'").get(build).d;
    const end = asOf || newest;
    const result = { build, asOf: end, params: { ...P }, nOutcomes: 0, gaps: 0, notCalibrated: 0, windows: 0, baseRate: null, buckets: [], brier: null, brierBase: null, bss: null, bssLo: null, bssHi: null, scoredN: 0, scoredWindows: 0, note: null };
    if (!end) { result.note = 'no filled outcomes yet'; persist(result); return result; }
    const { rows, gaps, skipped } = loadRows(build, end);
    result.gaps = gaps; result.notCalibrated = skipped; result.nOutcomes = rows.length;
    if (!rows.length) { result.note = 'no calibratable outcomes yet'; persist(result); return result; }
    const ord = makeOrdinals(addSessions(end, P.horizon + 2));
    // per bucket, per signal day: { ord, n, wins }
    const per = new Map(BUCKETS.map(b => [b, new Map()]));
    for (const r of rows) {
      const m = per.get(r.bucket), cur = m.get(r.day) || { ord: ord(r.day), n: 0, wins: 0 };
      cur.n++; cur.wins += r.win; m.set(r.day, cur);
    }
    const daysOf = new Map(BUCKETS.map(b => [b, [...per.get(b).values()].sort((a, c) => a.ord - c.ord)]));
    const asOfOrd = ord(end);
    const all = BUCKETS.map(b => fitStats(daysOf.get(b), asOfOrd, P));
    const totNw = all.reduce((s, x) => s + x.nw, 0), totWw = all.reduce((s, x) => s + x.ww, 0);
    result.baseRate = totNw > 0 ? totWw / totNw : null;
    result.windows = new Set(all.flatMap((_, i) => daysOf.get(BUCKETS[i]).map(d => Math.floor(d.ord / P.horizon)))).size;
    result.buckets = BUCKETS.map((b, i) => ({ bucket: b, ...estimate(all[i], result.baseRate ?? 0.5, P) }));

    // walk-forward Brier skill
    const signalDays = [...new Set(rows.map(r => r.day))].sort();
    const winSums = new Map();   // window → { sm, sr, n }
    let scoredN = 0;
    for (const day of signalDays) {
      const e = ord(day), known = e - 1;
      const stats = BUCKETS.map(b => fitStats(daysOf.get(b), known, P));
      const tn = stats.reduce((s, x) => s + x.nw, 0), tw = stats.reduce((s, x) => s + x.ww, 0);
      if (tn <= 0) continue;
      const base = tw / tn;
      BUCKETS.forEach((b, i) => {
        const d = per.get(b).get(day);
        if (!d) return;
        const est = estimate(stats[i], base, P);
        if (est.status !== 'ok') return;
        const p = est.p, ws = Math.floor(e / P.horizon);
        const cur = winSums.get(ws) || { sm: 0, sr: 0, n: 0 };
        cur.sm += d.wins * (1 - p) * (1 - p) + (d.n - d.wins) * p * p;
        cur.sr += d.wins * (1 - base) * (1 - base) + (d.n - d.wins) * base * base;
        cur.n += d.n; winSums.set(ws, cur); scoredN += d.n;
      });
    }
    result.scoredN = scoredN; result.scoredWindows = winSums.size;
    if (winSums.size >= P.minWindows && scoredN > 0) {
      const arr = [...winSums.keys()].sort((a, b) => a - b).map(k => winSums.get(k));
      const sm = arr.reduce((s, x) => s + x.sm, 0), sr = arr.reduce((s, x) => s + x.sr, 0);
      result.brier = sm / scoredN; result.brierBase = sr / scoredN;
      if (sr > 0) {
        result.bss = 1 - sm / sr;
        const rnd = mulberry32(P.seed), draws = [];
        for (let b = 0; b < P.bootstrap; b++) {
          let a = 0, c = 0;
          for (let k = 0; k < arr.length; k++) { const x = arr[Math.floor(rnd() * arr.length)]; a += x.sm; c += x.sr; }
          if (c > 0) draws.push(1 - a / c);
        }
        draws.sort((x, y) => x - y);
        if (draws.length) { const t = (1 - P.level) / 2; result.bssLo = draws[Math.floor(t * (draws.length - 1))]; result.bssHi = draws[Math.ceil((1 - t) * (draws.length - 1))]; }
      }
    } else result.note = `Brier skill needs forecasts over at least ${P.minWindows} windows; have ${winSums.size}`;
    persist(result);
    return result;
  }
  function addSessions(day, n) { let d = day; for (let i = 0; i < n; i++) d = nextTradingDay(d); return d; }

  function persist(r) {
    db.tx(() => {
      db.stmt('DELETE FROM calibration_bucket WHERE scoring_build = ?').run(r.build);
      const ins = db.stmt('INSERT INTO calibration_bucket(scoring_build, bucket, as_of, n, wins, n_w, wins_w, n_eff, windows, status, reason, p, lo, hi) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const b of r.buckets) ins.run(r.build, b.bucket, r.asOf || '', b.n, b.wins, b.nW, b.winsW, b.nEff, b.windows, b.status, b.reason, b.p, b.lo, b.hi);
      db.stmt(`INSERT INTO calibration_run(scoring_build, as_of, created_at, n_outcomes, n_gaps, windows, base_rate, buckets_ok, buckets_total, brier, brier_base, bss, bss_lo, bss_hi, scored_n, scored_windows, params, note)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(r.build, r.asOf || '', now(), r.nOutcomes, r.gaps, r.windows, r.baseRate, r.buckets.filter(b => b.status === 'ok').length, BUCKETS.length,
        r.brier, r.brierBase, r.bss, r.bssLo, r.bssHi, r.scoredN, r.scoredWindows, JSON.stringify({ ...r.params, skippedNotCalibrated: r.notCalibrated }), r.note);
    });
    healthCache = null;
  }

  // the stored calibrated probability for a score: { bucket, status, p, lo, hi, n, windows, asOf } or null when nothing is stored for the build
  function forecast({ score, earningsFlagged = false, build = scoring.build }) {
    const b = bucketOf(score, earningsFlagged);
    const r = db.stmt('SELECT bucket, status, reason, p, lo, hi, n, windows, as_of AS asOf FROM calibration_bucket WHERE scoring_build = ? AND bucket = ?').get(build, b);
    return r || null;
  }
  const latestRun = (build = scoring.build) => db.stmt('SELECT * FROM calibration_run WHERE scoring_build = ? ORDER BY id DESC LIMIT 1').get(build) || null;
  const buckets = (build = scoring.build) => db.stmt('SELECT * FROM calibration_bucket WHERE scoring_build = ? ORDER BY bucket').all(build);

  // recompute when the shadow feature has filled outcomes since the last run
  function stale(build = scoring.build) {
    const last = latestRun(build);
    const t = db.stmt("SELECT MAX(o.resolved_at) AS t FROM candidate_outcome o JOIN candidate c ON c.candidate_id = o.candidate_id WHERE c.scoring_build = ? AND o.status = 'ok'").get(build).t;
    return t !== null && t !== undefined && (!last || t > last.created_at);
  }
  async function step() {
    if (!db) throw new StockmanError('calibration: not started');
    if (busy) return { status: 'busy' };
    busy = true;
    try { return stale() ? { status: 'computed', result: compute() } : { status: 'up_to_date' }; } finally { busy = false; }
  }

  const pct = x => `${(x * 100).toFixed(1)}%`;
  function health() {
    if (!db) return { summary: '' };
    const t = now();
    if (healthCache && t - healthCache.at < o.healthCacheMs) return healthCache.value;
    let value;
    try {
      const r = latestRun();
      if (!r) value = { summary: 'calibration: nothing computed yet (needs shadow outcomes)', build: scoring.build };
      else {
        const bits = [`calibration (build ${r.scoring_build}${r.as_of ? `, outcomes to ${r.as_of}` : ''}): ${r.n_outcomes} outcomes over ${r.windows} windows`, `${r.buckets_ok} of ${r.buckets_total} buckets have enough data (200 outcomes over 30 windows), the rest report insufficient data`];
        if (r.base_rate !== null) bits.push(`base win rate ${pct(r.base_rate)} after an assumed ${PARAMS.costBps} bps cost`);
        bits.push(r.bss !== null ? `Brier skill ${r.bss.toFixed(3)}${r.bss_lo !== null ? ` (95% ${r.bss_lo.toFixed(3)} to ${r.bss_hi.toFixed(3)})` : ''} on ${r.scored_windows} windows` : 'Brier skill: insufficient data');
        value = { summary: `${bits.join('; ')}. Shadow data only, not a prediction.`, build: r.scoring_build, asOf: r.as_of, outcomes: r.n_outcomes, windows: r.windows, bucketsOk: r.buckets_ok, bucketsTotal: r.buckets_total, bss: r.bss, bssLo: r.bss_lo, bssHi: r.bss_hi };
      }
    } catch (err) { value = { summary: '', error: String(err.message).slice(0, 200) }; }
    healthCache = { at: t, value };
    return value;
  }

  const api = { compute, step, forecast, latestRun, buckets, stale, health, bucketOf, BUCKETS, params: P, options: o };
  const feature = {
    id: 'calibration', migrations: [migration],
    async start(ctx) {
      db = ctx.db; log = ctx.log; stopping = false; healthCache = null;
      if (o.autoRun) {
        startTimer = setTimeout(() => { startTimer = null; step().catch(err => log?.warn('calibration step failed', { message: err.message })); }, o.startDelayMs); startTimer.unref?.();
        timer = setInterval(() => { if (!busy && !stopping) step().catch(err => log?.warn('calibration step failed', { message: err.message })); }, o.tickMs); timer.unref?.();
      }
    },
    async stop() { stopping = true; clearTimeout(startTimer); clearInterval(timer); startTimer = timer = null; },
    health,
  };
  return { feature, api };
}

module.exports = { createCalibration, MIGRATION_VERSION, PARAMS, BUCKETS, bucketOf, betaCdf, betaQuantile, fitStats, estimate };
