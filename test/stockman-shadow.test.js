const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SCORING_BUILD } = require('../src/core/stockman/learning/scoring');
const { HOLDOUT_END } = require('../src/core/stockman/learning/shadow');
const { makeLearning, putBars, walk, clock, tradingDays, one, count } = require('./helpers/stockman-learning');

const D = '2026-11-16', ENTRY = '2026-11-17', EXIT = '2026-11-23';
const HISTORY = tradingDays('2026-08-03', '2026-11-30');
const upTo = day => HISTORY.filter(d => d <= day);
// A: a known entry open and exit close, with an adjustment factor that changes (a dividend) between them
const aPrice = (i, d) => (d === ENTRY ? 100 : d === EXIT ? 110 : walk('A')(i));
const aFactor = (i, d) => (d < '2026-11-20' ? 0.98 : 0.97);

async function setup(opts = {}) {
  const L = await makeLearning({ members: ['A', 'B', 'C', 'D'], ...opts });
  putBars(L.app, 'A', HISTORY, { price: aPrice, factor: aFactor });
  putBars(L.app, 'B', HISTORY, { price: walk('B') });
  putBars(L.app, 'D', HISTORY.slice(-20), { price: walk('D') });
  putBars(L.app, 'SPY', HISTORY, { price: (i, d) => (d === ENTRY ? 400 : d === EXIT ? 404 : 400 + (i % 5)), factor: () => 1 });
  return L;
}

test('shadow: every universe member is logged with its reasons, flags, features and the scoring build', async () => {
  const L = await setup({ flags: (s, entry, exit) => ({ earnings_in_window: s === 'B', earnings_possible: false, earnings_data: 'confirmed', ...(s === 'B' ? { report: { day: '2026-11-19' } } : {}) }) });
  const r = L.shadow.logDay(D);
  assert.equal(r.status, 'logged'); assert.equal(r.runId, `run-${D}`);
  assert.equal(r.members, 4); assert.equal(r.eligible, 1); assert.equal(r.flagged, 1); assert.equal(r.noBar, 1); assert.equal(r.scored, 2);
  const row = s => one(L.app, 'SELECT * FROM candidate WHERE symbol = ? AND day = ?', s, D);
  const a = row('A');
  assert.equal(a.candidate_id, `run-${D}/A/${SCORING_BUILD}`);
  assert.equal(a.scoring_build, SCORING_BUILD); assert.equal(a.run_id, `run-${D}`);
  assert.equal(a.eligible, 1); assert.equal(a.in_basket, 1); assert.equal(a.rank, 1);
  assert.equal(a.entry_day, ENTRY); assert.equal(a.exit_day, EXIT);
  assert.equal(a.indexes, 'sp500');
  assert.ok(JSON.parse(a.features).vol20 > 0); assert.deepEqual(Object.keys(JSON.parse(a.variants)).length, 6);
  const b = row('B');
  assert.equal(b.eligible, 0); assert.deepEqual(JSON.parse(b.reasons), ['earnings_in_window']); assert.ok(b.score !== null, 'earnings-excluded is still scored');
  assert.equal(JSON.parse(b.earnings).report.day, '2026-11-19', 'the flag is kept with the row');
  assert.equal(b.in_basket, 0); assert.equal(b.rank, null);
  assert.deepEqual(JSON.parse(row('C').reasons), ['no_bar_on_day']); assert.equal(row('C').score, null);
  assert.ok(JSON.parse(row('D').reasons).includes('insufficient_history'), 'a recently listed symbol is logged with the reason');
  const day = one(L.app, 'SELECT * FROM shadow_day WHERE day = ?', D);
  assert.equal(day.n_members, 4); assert.equal(day.late, 1, 'logged on 11-23, after the 11-17 entry session');
  assert.deepEqual(JSON.parse(day.universe), { sp500: '2026-10-01', ndx100: null });
  assert.deepEqual(L.state.memberCalls, [D], 'point-in-time membership is asked for the signal day');
  await L.app.stop();
});

test('shadow: logging the same day again changes nothing (idempotent); the first scoring of a day is kept', async () => {
  const L = await setup();
  L.shadow.logDay(D);
  const snap = () => JSON.stringify(L.app.db.stmt('SELECT * FROM candidate ORDER BY candidate_id').all());
  const first = snap();
  assert.equal(L.shadow.logDay(D).status, 'already');
  assert.equal(snap(), first);
  assert.equal(count(L.app, 'SELECT COUNT(*) AS n FROM candidate WHERE day = ?', D), 4);
  const before = L.app.db.stmt('SELECT * FROM candidate WHERE day = ? ORDER BY candidate_id').all(D);
  await L.shadow.step();   // catches up the later sessions; day D is left as it was
  assert.deepEqual(L.app.db.stmt('SELECT * FROM candidate WHERE day = ? ORDER BY candidate_id').all(D), before);
  const n = count(L.app, 'SELECT COUNT(*) AS n FROM candidate');
  await L.shadow.step();
  assert.equal(count(L.app, 'SELECT COUNT(*) AS n FROM candidate'), n, 'a second step adds nothing');
  assert.equal(count(L.app, 'SELECT COUNT(DISTINCT candidate_id) AS n FROM candidate'), n);
  await L.app.stop();
});

test('shadow: the outcome uses the next open, the 5th session close, adjusted prices, and SPY over the same dates', async () => {
  const L = await setup();
  L.shadow.logDay(D);
  const r = L.shadow.resolveOutcomes();
  assert.ok(r.filled >= 2);
  const o = one(L.app, "SELECT * FROM candidate_outcome WHERE candidate_id = ?", `run-${D}/A/${SCORING_BUILD}`);
  assert.equal(o.status, 'ok'); assert.equal(o.entry_day, ENTRY); assert.equal(o.exit_day, EXIT);
  assert.ok(Math.abs(o.entry_open - 99.9) < 1e-9, 'raw open of the entry session (0.999 x close 100)');
  const ret = (110 * 0.97) / (99.9 * 0.98) - 1, bench = 404 / (400 * 0.999) - 1;
  assert.ok(Math.abs(o.ret - ret) < 1e-12, `ret ${o.ret} vs ${ret}`);
  assert.ok(Math.abs(o.bench_ret - bench) < 1e-12);
  assert.ok(Math.abs(o.excess - (ret - bench)) < 1e-12);
  // a second resolve changes nothing
  const before = JSON.stringify(L.app.db.stmt('SELECT * FROM candidate_outcome ORDER BY candidate_id').all());
  const again = L.shadow.resolveOutcomes();
  assert.equal(again.filled, 0);
  assert.equal(JSON.stringify(L.app.db.stmt('SELECT * FROM candidate_outcome ORDER BY candidate_id').all()), before);
  await L.app.stop();
});

test('shadow: no outcome before the 5th session has been stored', async () => {
  const L = await makeLearning({ members: ['A'] });
  putBars(L.app, 'A', upTo('2026-11-20'), { price: walk('A') });   // bars stop on 11-20: the exit session 11-23 is not there
  putBars(L.app, 'SPY', upTo('2026-11-20'), { price: walk('SPY', 400) });
  L.shadow.logDay(D);
  const r = L.shadow.resolveOutcomes();
  assert.equal(r.due, 0);
  assert.equal(count(L.app, 'SELECT COUNT(*) AS n FROM candidate_outcome'), 0, 'pending means no row');
  assert.equal(L.shadow.status().outcomesDue, 0);
  await L.app.stop();
});

test('shadow: a missing exit bar waits out the grace sessions, is then recorded as a gap and never filled, and a late bar fixes it', async () => {
  const L = await makeLearning({ members: ['A'] });
  const skip = [EXIT];
  putBars(L.app, 'A', upTo('2026-11-24'), { price: walk('A'), skip });
  putBars(L.app, 'SPY', upTo('2026-11-24'), { price: walk('SPY', 400) });
  L.shadow.logDay(D);
  let r = L.shadow.resolveOutcomes();   // latest bar 11-24: only 1 session after the exit day, grace is 3
  assert.equal(r.waiting, 1); assert.equal(count(L.app, 'SELECT COUNT(*) AS n FROM candidate_outcome'), 0);
  putBars(L.app, 'A', tradingDays('2026-11-25', '2026-11-30'), { price: walk('A', 100) });
  putBars(L.app, 'SPY', tradingDays('2026-11-25', '2026-11-30'), { price: walk('SPY', 400) });
  r = L.shadow.resolveOutcomes();
  assert.equal(r.gaps, 1);
  const o = one(L.app, 'SELECT * FROM candidate_outcome');
  assert.equal(o.status, 'gap'); assert.equal(o.reason, 'no_exit_bar'); assert.equal(o.ret, null, 'no invented return');
  assert.equal(count(L.app, 'SELECT COUNT(*) AS n FROM bar WHERE symbol = ? AND day = ?', 'A', EXIT), 0, 'the missing bar was not filled');
  assert.equal(L.shadow.status().outcomesGap, 1);
  // the provider delivers the bar later: the next step fills it
  putBars(L.app, 'A', [EXIT], { price: () => 105 });
  r = L.shadow.resolveOutcomes();
  assert.equal(r.retried, 1);
  const f = one(L.app, 'SELECT * FROM candidate_outcome');
  assert.equal(f.status, 'ok'); assert.ok(f.attempts >= 2, 'the retry is counted'); assert.ok(f.ret !== null);
  await L.app.stop();
});

test('shadow: a missing benchmark bar is a gap too, with its own reason', async () => {
  const L = await makeLearning({ members: ['A'] });
  putBars(L.app, 'A', HISTORY, { price: walk('A') });
  putBars(L.app, 'SPY', HISTORY, { price: walk('SPY', 400), skip: [ENTRY] });
  L.shadow.logDay(D);
  L.shadow.resolveOutcomes();
  const o = one(L.app, 'SELECT * FROM candidate_outcome');
  assert.equal(o.status, 'gap'); assert.equal(o.reason, 'benchmark_no_entry_bar');
  await L.app.stop();
});

test('shadow: catch-up logs every missed session oldest first, waits for runs that are not ingested, and resumes', async () => {
  const states = {};
  const now = clock('2026-11-18T01:00:00Z');   // evening of 11-17: target is 11-17
  const L = await makeLearning({ members: ['A'], now, runState: d => states[d] ?? 'ingested', shadowOpts: { startDay: '2026-11-16' } });
  putBars(L.app, 'A', HISTORY, { price: walk('A') });
  putBars(L.app, 'SPY', HISTORY, { price: walk('SPY', 400) });
  let r = await L.shadow.step();
  assert.deepEqual(r.logged.map(x => x.day), ['2026-11-16', '2026-11-17']);
  // jarvis is closed for three sessions; 11-19's data run is only half done when it comes back
  now.set('2026-11-21T01:00:00Z');   // evening of 11-20
  states['2026-11-19'] = 'universe_ok';
  r = await L.shadow.step();
  assert.deepEqual(r.logged.map(x => x.day), ['2026-11-18', '2026-11-20'], 'oldest first; 11-19 is not ingested yet');
  assert.equal(r.waiting.length, 1); assert.equal(r.waiting[0].day, '2026-11-19');
  assert.ok(r.logged.every(x => x.late === true || x.day === '2026-11-20'));
  states['2026-11-19'] = 'ingested';
  r = await L.shadow.step();
  assert.deepEqual(r.logged.map(x => x.day), ['2026-11-19']);
  assert.equal((await L.shadow.step()).logged.length, 0, 'nothing left to do');
  assert.equal(count(L.app, 'SELECT COUNT(*) AS n FROM shadow_day'), 5);
  assert.equal(L.shadow.pendingDays().days.length, 0);
  await L.app.stop();
});

test('shadow: a bounded step leaves the rest for the next one', async () => {
  const now = clock('2026-11-25T01:00:00Z');
  const L = await makeLearning({ members: ['A'], now, shadowOpts: { startDay: '2026-11-16', maxDaysPerStep: 2 } });
  putBars(L.app, 'A', HISTORY, { price: walk('A') });
  putBars(L.app, 'SPY', HISTORY, { price: walk('SPY', 400) });
  const r1 = await L.shadow.step();
  assert.equal(r1.logged.length, 2); assert.equal(r1.remainingDays, 5);
  const r2 = await L.shadow.step(), r3 = await L.shadow.step(), r4 = await L.shadow.step();
  assert.equal(r2.logged.length + r3.logged.length + r4.logged.length, 5);
  assert.equal(count(L.app, 'SELECT COUNT(*) AS n FROM shadow_day'), 7);
  await L.app.stop();
});

test('shadow: resumes after a restart with the same database file and logs each day once', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-')), 'stockman.db');
  const now = clock('2026-11-18T01:00:00Z');
  let L = await makeLearning({ members: ['A'], now, dbFile: file, shadowOpts: { startDay: '2026-11-16' } });
  putBars(L.app, 'A', HISTORY, { price: walk('A') });
  putBars(L.app, 'SPY', HISTORY, { price: walk('SPY', 400) });
  await L.shadow.step();
  await L.app.stop();
  now.set('2026-11-19T01:00:00Z');
  L = await makeLearning({ members: ['A'], now, dbFile: file, shadowOpts: { startDay: '2026-11-16' } });
  const r = await L.shadow.step();
  assert.deepEqual(r.logged.map(x => x.day), ['2026-11-18']);
  assert.equal(count(L.app, 'SELECT COUNT(*) AS n FROM candidate'), 3);
  await L.app.stop();
});

test('shadow: the backtest holdout is refused; live logging starts after it', async () => {
  const L = await setup();
  assert.equal(HOLDOUT_END, '2026-11-13');
  assert.throws(() => L.shadow.logDay('2026-11-13'), /holdout/);
  assert.throws(() => L.shadow.logDay('2026-10-01'), /holdout/);
  assert.throws(() => L.shadow.logDay('2026-11-14'), /not a trading session/);
  assert.equal(L.shadow.logDay(D).status, 'logged');
  // a first step with a start day inside the holdout still starts after it
  const M = await makeLearning({ members: ['A'], now: clock('2026-11-18T01:00:00Z'), shadowOpts: { startDay: '2026-01-05' } });
  assert.equal(M.shadow.pendingDays().days[0], '2026-11-16');
  await L.app.stop(); await M.app.stop();
});

test('shadow: a day with no run, or no universe, waits instead of logging half a day', async () => {
  const L = await makeLearning({ members: ['A'], runState: d => (d === D ? null : 'ingested') });
  putBars(L.app, 'A', HISTORY, { price: walk('A') });
  assert.deepEqual(L.shadow.logDay(D), { day: D, status: 'waiting', reason: 'no data run for this day yet' });
  L.state.runState = () => 'created';
  assert.match(L.shadow.logDay(D).reason, /created, not ingested/);
  L.state.runState = () => 'ingested'; L.state.members = [];
  assert.match(L.shadow.logDay(D).reason, /no point-in-time universe/);
  assert.equal(count(L.app, 'SELECT COUNT(*) AS n FROM shadow_day'), 0);
  await L.app.stop();
});

test('shadow: health is one short summary line and says it is not a prediction', async () => {
  const L = await setup();
  L.shadow.logDay(D); L.shadow.resolveOutcomes();
  const h = L.app.health().dataQuality.shadow;
  assert.match(h.summary, /^shadow candidates \(build rev-v1\.0\): 1 day logged, newest 2026-11-16, 4 candidates; 2 of 4 eligible that day, 1 with no bar; \d+ outcomes filled/);
  assert.match(h.summary, /not a prediction\.$/);
  assert.ok(h.summary.length < 400);
  assert.equal(JSON.stringify(h).includes('"last":'), false, 'the health object stays small');
  await L.app.stop();
});
