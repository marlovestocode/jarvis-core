const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core/stockman/learning/calibration');
const { SCORING_BUILD } = require('../src/core/stockman/learning/scoring');
const { makeLearning, lcg, one, count, tradingDays } = require('./helpers/stockman-learning');

const LONG = tradingDays('2026-11-16', '2028-12-29');   // about 540 signal days = 108 windows: Brier skill needs 30 windows of forecasts after the buckets first qualify
const DAYS = tradingDays('2026-11-16', '2027-10-29');   // about 245 signal days = 49 windows
// insert shadow-like rows: per day, `perDay` candidates per score. winP(score) = win probability.
// The excess is +1% for a win and -1% for a loss (the assumed cost is 10 bps, so a win stays a win).
function fill(app, { days = DAYS, scores, winP, perDay = 2, seed = 7, build = SCORING_BUILD, reasons = '[]', status = 'ok' }) {
  const rnd = lcg(seed);
  const cand = app.db.stmt(`INSERT INTO candidate(candidate_id, run_id, day, symbol, scoring_build, indexes, eligible, reasons, score, rank, in_basket, features, variants, earnings, entry_day, exit_day, logged_at)
    VALUES (?,?,?,?,?,'sp500',1,?,?,NULL,0,NULL,NULL,NULL,?,?,1)`);
  const out = app.db.stmt('INSERT INTO candidate_outcome(candidate_id, status, reason, entry_day, exit_day, ret, bench_ret, excess, attempts, resolved_at) VALUES (?,?,?,?,?,?,?,?,1,5)');
  let n = 0;
  app.db.tx(() => {
    days.forEach((day, i) => {
      const exit = days[Math.min(days.length - 1, i + 5)];
      for (const sc of scores) for (let k = 0; k < perDay; k++) {
        const id = `run-${day}/S${sc}_${k}/${build}`, win = (rnd() + 1) / 2 < winP(sc);
        cand.run(id, `run-${day}`, day, `S${sc}_${k}`, build, reasons, sc, day, exit);
        if (i + 5 < days.length) { out.run(id, status, status === 'gap' ? 'no_exit_bar' : null, day, exit, win ? 0.01 : -0.01, 0, win ? 0.01 : -0.01); n++; }
      }
    });
  });
  return n;
}

test('calibration: buckets are few and fixed; the edges and the earnings split', () => {
  assert.equal(C.BUCKETS.length, 8);
  assert.equal(C.bucketOf(-0.5, false), 'lt0:clean'); assert.equal(C.bucketOf(0, false), '0to1:clean'); assert.equal(C.bucketOf(0.99, false), '0to1:clean');
  assert.equal(C.bucketOf(1, false), '1to2:clean'); assert.equal(C.bucketOf(2, true), 'ge2:earnings'); assert.equal(C.bucketOf(7, false), 'ge2:clean');
  assert.equal(C.PARAMS.prior, 50); assert.equal(C.PARAMS.halfLifeDays, 250); assert.equal(C.PARAMS.minOutcomes, 200); assert.equal(C.PARAMS.minWindows, 30);
});

test('calibration: the Beta helpers are right on known values', () => {
  assert.ok(Math.abs(C.betaCdf(0.5, 2, 2) - 0.5) < 1e-9);
  assert.ok(Math.abs(C.betaCdf(0.3, 1, 1) - 0.3) < 1e-9);
  assert.ok(Math.abs(C.betaQuantile(0.975, 1, 1) - 0.975) < 1e-9);
  assert.ok(Math.abs(C.betaCdf(0.25, 2, 5) - 0.466064453125) < 1e-9, "I_0.25(2,5) = 0.46606");
  const lo = C.betaQuantile(0.025, 50, 50), hi = C.betaQuantile(0.975, 50, 50);
  assert.ok(lo < 0.5 && hi > 0.5 && Math.abs((lo + hi) / 2 - 0.5) < 1e-9);
});

test('calibration: too few outcomes say "insufficient data" and give no probability', async () => {
  const L = await makeLearning();
  fill(L.app, { days: DAYS.slice(0, 40), scores: [2.5], winP: () => 0.9 });   // 70 outcomes over 8 windows
  const r = L.calibration.compute();
  const b = r.buckets.find(x => x.bucket === 'ge2:clean');
  assert.equal(b.status, 'insufficient_data'); assert.equal(b.p, null); assert.equal(b.lo, null);
  assert.match(b.reason, /need at least 200 outcomes over 30 windows; have 70 over 8/);
  assert.equal(r.bss, null); assert.match(r.note, /at least 30 windows/);
  assert.equal(L.calibration.forecast({ score: 2.5 }).status, 'insufficient_data');
  const h = L.app.health().dataQuality.calibration;
  assert.match(h.summary, /0 of 8 buckets have enough data/); assert.match(h.summary, /Brier skill: insufficient data/); assert.match(h.summary, /not a prediction\.$/);
  await L.app.stop();
});

test('calibration: a bucket with enough data gets a shrunk probability inside its interval, near but not at the raw rate', async () => {
  const L = await makeLearning();
  fill(L.app, { scores: [-1, 2.5], winP: s => (s > 0 ? 0.6 : 0.4), perDay: 2 });   // ge2: 60% wins; lt0: 40% wins
  const r = L.calibration.compute();
  const hi = r.buckets.find(x => x.bucket === 'ge2:clean'), lo = r.buckets.find(x => x.bucket === 'lt0:clean');
  assert.equal(hi.status, 'ok'); assert.equal(lo.status, 'ok');
  assert.ok(hi.n >= 200 && hi.windows >= 30);
  const raw = hi.wins / hi.n;
  assert.ok(hi.p < raw + 1e-9 && hi.p > r.baseRate - 1e-9, `shrunk: base ${r.baseRate} <= p ${hi.p} <= raw ${raw}`);
  assert.ok(hi.lo < hi.p && hi.p < hi.hi, 'p inside its interval');
  assert.ok(hi.hi - hi.lo < 0.4 && hi.hi - hi.lo > 0.02);
  assert.ok(hi.p > lo.p, 'the informative bucket ranks above the other');
  assert.equal(r.buckets.find(x => x.bucket === '1to2:clean').status, 'insufficient_data', 'empty buckets stay insufficient');
  const f = L.calibration.forecast({ score: 3 });
  assert.equal(f.bucket, 'ge2:clean'); assert.equal(f.status, 'ok'); assert.ok(Math.abs(f.p - hi.p) < 1e-12);
  await L.app.stop();
});

test('calibration: small buckets are pulled toward the base rate (prior of 50 outcomes)', () => {
  const st = { n: 260, wins: 260, nw: 260, ww: 260, sw2: 260, windows: 40 };   // 100% wins in the bucket
  const e = C.estimate(st, 0.5, C.PARAMS);
  assert.ok(Math.abs(e.p - (260 + 25) / 310) < 1e-12, 'p = (wins + 50 x base) / (n + 50)');
  assert.ok(e.p < 0.93);
});

test('calibration: old outcomes weigh less (half-life 250 sessions); effective n is below the row count', () => {
  const days = [{ ord: 0, n: 100, wins: 100 }, { ord: 245, n: 100, wins: 0 }];
  const st = C.fitStats(days, 255, C.PARAMS);   // exits at 5 and 250: ages 250 and 5
  assert.equal(st.n, 200);
  assert.ok(Math.abs(st.nw - (100 * 0.5 + 100 * Math.pow(0.5, 5 / 250))) < 1e-9);
  assert.ok(st.ww < st.nw / 2.5, 'the old wins count for about half of the recent losses');
  const e = C.estimate({ ...st, windows: 40 }, 0.5, C.PARAMS);
  assert.ok(e.nEff < 200);
  assert.equal(C.fitStats(days, 249, C.PARAMS).n, 100, 'an outcome not yet known at the as-of date is left out');
});

test('calibration: Brier skill is above 0 with a real signal, and its interval excludes 0; with no signal it does not', async () => {
  const A = await makeLearning();
  fill(A.app, { scores: [-1, 0.5, 1.5, 2.5], winP: s => ({ '-1': 0.25, '0.5': 0.4, '1.5': 0.6, '2.5': 0.75 })[s], perDay: 2, seed: 11, days: LONG });
  const a = A.calibration.compute();
  assert.ok(a.bss > 0.05, `bss ${a.bss}`);
  assert.ok(a.bssLo > 0, `lower bound ${a.bssLo} should exclude 0`);
  assert.ok(a.bssLo < a.bss && a.bss < a.bssHi);
  assert.ok(a.scoredWindows >= 30 && a.scoredN > 0);
  await A.app.stop();
  const B = await makeLearning();
  fill(B.app, { scores: [-1, 0.5, 1.5, 2.5], winP: () => 0.5, perDay: 2, seed: 5, days: LONG });
  const b = B.calibration.compute();
  assert.ok(b.bss < 0.02, `no signal: bss ${b.bss}`);
  assert.ok(b.bssLo <= 0, `no signal: the interval ${b.bssLo} to ${b.bssHi} must reach 0`);
  await B.app.stop();
});

test('calibration: a compute is reproducible, stores one run row each time, and is versioned by scoring build', async () => {
  const L = await makeLearning();
  fill(L.app, { scores: [-1, 2.5], winP: s => (s > 0 ? 0.6 : 0.4) });
  fill(L.app, { scores: [-1, 2.5], winP: s => (s > 0 ? 0.1 : 0.9), build: 'rev-v0.9', seed: 3 });   // an old build with the opposite pattern
  const a = L.calibration.compute(), b = L.calibration.compute();
  assert.deepEqual(a, b, 'same data, same numbers, same bootstrap interval');
  assert.equal(count(L.app, 'SELECT COUNT(*) AS n FROM calibration_run WHERE scoring_build = ?', SCORING_BUILD), 2);
  const old = L.calibration.compute({ build: 'rev-v0.9' });
  const hiNew = a.buckets.find(x => x.bucket === 'ge2:clean'), hiOld = old.buckets.find(x => x.bucket === 'ge2:clean');
  assert.ok(hiNew.p > 0.5 && hiOld.p < 0.5, 'builds never mix');
  assert.equal(count(L.app, 'SELECT COUNT(*) AS n FROM calibration_bucket WHERE scoring_build = ?', 'rev-v0.9'), 8);
  assert.equal(L.calibration.forecast({ score: 3 }).p, hiNew.p, 'forecast reads the current build');
  assert.equal(L.calibration.latestRun().scoring_build, SCORING_BUILD);
  await L.app.stop();
});

test('calibration: gaps and candidates excluded for non-earnings reasons are not calibrated, and are counted', async () => {
  const L = await makeLearning();
  fill(L.app, { scores: [2.5], winP: () => 0.6 });
  const n = count(L.app, 'SELECT COUNT(*) AS n FROM candidate_outcome');
  fill(L.app, { scores: [2.7], winP: () => 0.99, reasons: '["price_not_above_5"]', seed: 9 });   // must not enter a bucket
  fill(L.app, { scores: [2.9], winP: () => 0.99, status: 'gap', seed: 4 });                       // gaps are not calibrated either
  const r = L.calibration.compute();
  assert.equal(r.nOutcomes, n, 'only the clean candidates count');
  assert.ok(r.notCalibrated > 0); assert.ok(r.gaps > 0);
  assert.ok(r.buckets.find(x => x.bucket === 'ge2:clean').p < 0.7);
  await L.app.stop();
});

test('calibration: earnings-flagged candidates have their own buckets (D19)', async () => {
  const L = await makeLearning();
  fill(L.app, { scores: [2.5], winP: () => 0.7, seed: 1 });
  fill(L.app, { scores: [2.6], winP: () => 0.3, reasons: '["earnings_in_window"]', seed: 2 });
  const r = L.calibration.compute();
  const clean = r.buckets.find(x => x.bucket === 'ge2:clean'), earn = r.buckets.find(x => x.bucket === 'ge2:earnings');
  assert.equal(clean.status, 'ok'); assert.equal(earn.status, 'ok');
  assert.ok(clean.p > earn.p + 0.05);
  assert.equal(L.calibration.forecast({ score: 2.6, earningsFlagged: true }).bucket, 'ge2:earnings');
  await L.app.stop();
});

test('calibration: step recomputes only when new outcomes arrived; health is small and honest', async () => {
  const L = await makeLearning();
  assert.equal((await L.calibration.step()).status, 'up_to_date', 'nothing to calibrate');
  fill(L.app, { scores: [-1, 2.5], winP: s => (s > 0 ? 0.6 : 0.4) });
  assert.equal(L.calibration.stale(), true);
  assert.equal((await L.calibration.step()).status, 'computed');
  assert.equal((await L.calibration.step()).status, 'up_to_date');
  const h = L.app.health().dataQuality.calibration;
  assert.match(h.summary, /^calibration \(build rev-v1\.0, outcomes to \d{4}-\d{2}-\d{2}\): \d+ outcomes over \d+ windows; 2 of 8 buckets have enough data/);
  assert.match(h.summary, /assumed 10 bps cost/); assert.ok(h.summary.length < 500);
  await L.app.stop();
});

test('calibration: its tables are its own (no cortex edges)', async () => {
  const L = await makeLearning();
  const tables = L.app.db.stmt("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'calibration%' ORDER BY name").all().map(r => r.name);
  assert.deepEqual(tables, ['calibration_bucket', 'calibration_run']);
  assert.equal(one(L.app, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'edge'").n, 0);
  await L.app.stop();
});
