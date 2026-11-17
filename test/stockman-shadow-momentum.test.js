// Forward (shadow) logging of the momentum rule (vault D25, CL-0061): every universe symbol is scored with all six momentum variants under
// build mom-v1.0 beside the reversal rule's own log, with no schema change (every shadow table is keyed by scoring build). The reversal rows
// and numbers must not move; calibration and the paper opener must not see momentum rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SCORING_BUILD, MOM_BUILD, MOM_VARIANTS } = require('../src/core/stockman/learning/scoring');
const { makeLearning, putBars, walk, tradingDays, one, count } = require('./helpers/stockman-learning');

const D = '2026-11-16', ENTRY = '2026-11-17', EXIT = '2026-11-23';
const HISTORY = tradingDays('2025-04-01', '2026-11-30');   // more than 330 sessions to D: L = 252 can score
const SYMS = ['A', 'B', 'C', 'D', 'E', 'F'];

async function setup(opts = {}) {
  const L = await makeLearning({ members: [...SYMS, 'SHORT', 'NOBAR'], shadowOpts: { momentum: true }, ...opts });
  SYMS.forEach((s, k) => putBars(L.app, s, HISTORY, { price: (i, d) => (d === ENTRY ? 100 : d === EXIT ? 110 : walk(s, 40 + k * 7, 0.012)(i)) }));
  putBars(L.app, 'SHORT', HISTORY.slice(-120), { price: walk('SHORT') });   // 120 bars: enough for L = 63 only
  putBars(L.app, 'SPY', HISTORY, { price: (i, d) => (d === ENTRY ? 400 : d === EXIT ? 404 : 400 + (i % 5)), factor: () => 1 });
  return L;
}
const row = (L, s, build) => one(L.app, 'SELECT * FROM candidate WHERE symbol = ? AND day = ? AND scoring_build = ?', s, D, build);

test('momentum shadow: every member is logged under mom-v1.0 with all six variants, each with its own score, rank and basket flag', async () => {
  const L = await setup();
  assert.equal(L.shadow.logDay(D).status, 'logged');
  const r = L.shadow.logDay(D, { rule: 'momentum' });
  assert.equal(r.status, 'logged'); assert.equal(r.members, 8);
  const a = row(L, 'A', MOM_BUILD);
  assert.equal(a.candidate_id, `run-${D}/A/${MOM_BUILD}`);
  assert.equal(a.score, null); assert.equal(a.rank, null); assert.equal(a.in_basket, 0, 'no single basket: each variant has its own');
  const v = JSON.parse(a.variants);
  assert.deepEqual(Object.keys(v).sort(), MOM_VARIANTS.map(x => x.id).sort());
  for (const id of Object.keys(v)) {
    assert.equal(typeof v[id].score, 'number'); assert.equal(v[id].eligible, true);
    assert.ok(v[id].rank >= 1 && v[id].inBasket === true, `${id}: 6 eligible names, all inside the top 20`);
  }
  assert.ok(JSON.parse(a.features).vol60 > 0); assert.equal(a.entry_day, ENTRY); assert.equal(a.exit_day, EXIT);
  // ranks of one variant run 1..7 without a repeat (the six names and SHORT, which is eligible for L = 63)
  const ranks = [...SYMS, 'SHORT'].map(s => JSON.parse(row(L, s, MOM_BUILD).variants).mom63.rank).sort();
  assert.deepEqual(ranks, [1, 2, 3, 4, 5, 6, 7]);
  // a short history is eligible only where it has L + 22 bars: 120 bars cover L = 63 (85) but not L = 126 (148) or 252 (274)
  const s = JSON.parse(row(L, 'SHORT', MOM_BUILD).variants);
  assert.equal(s.mom63.eligible, true); assert.equal(s.mom126.eligible, false); assert.equal(s.mom126s.eligible, false); assert.equal(s.mom252.eligible, false);
  assert.ok(s.mom126.reasons.includes('insufficient_history'));
  assert.deepEqual(JSON.parse(row(L, 'NOBAR', MOM_BUILD).reasons), ['no_bar_on_day']);
  assert.equal(one(L.app, 'SELECT scoring_build FROM shadow_day WHERE day = ? AND scoring_build = ?', D, MOM_BUILD).scoring_build, MOM_BUILD);
  await L.app.stop();
});

test('momentum shadow: the reversal rows are exactly what they were, and the momentum log never mixes into them', async () => {
  const Off = await setup({ shadowOpts: { momentum: false } });
  Off.shadow.logDay(D);
  const before = JSON.stringify(Off.app.db.stmt('SELECT * FROM candidate WHERE scoring_build = ? ORDER BY candidate_id').all(SCORING_BUILD).map(r => ({ ...r, logged_at: 0 })));
  await Off.app.stop();
  const On = await setup();
  On.shadow.logDay(D); On.shadow.logDay(D, { rule: 'momentum' });
  const after = JSON.stringify(On.app.db.stmt('SELECT * FROM candidate WHERE scoring_build = ? ORDER BY candidate_id').all(SCORING_BUILD).map(r => ({ ...r, logged_at: 0 })));
  assert.equal(after, before, 'the reversal candidates are identical with the momentum log on');
  assert.equal(count(On.app, 'SELECT COUNT(*) AS n FROM candidate WHERE scoring_build = ?', SCORING_BUILD), 8);
  assert.equal(count(On.app, 'SELECT COUNT(*) AS n FROM candidate WHERE scoring_build = ?', MOM_BUILD), 8);
  // calibration reads by build, so it never sees momentum rows
  assert.equal(count(On.app, "SELECT COUNT(*) AS n FROM candidate WHERE scoring_build = ? AND in_basket = 1", MOM_BUILD), 0, 'the paper opener reads in_basket by build: nothing to open for momentum');
  await On.app.stop();
});

test('momentum shadow: outcomes are filled per candidate (entry open to the 5th close versus SPY), once, and logging again is a no-op', async () => {
  const L = await setup();
  L.shadow.logDay(D, { rule: 'momentum' });
  assert.equal(L.shadow.logDay(D, { rule: 'momentum' }).status, 'already');
  const res = L.shadow.resolveOutcomes();
  assert.ok(res.momentum.filled >= 7, 'six full names and the short one have scores');
  const o = one(L.app, 'SELECT * FROM candidate_outcome WHERE candidate_id = ?', `run-${D}/A/${MOM_BUILD}`);
  assert.equal(o.status, 'ok');
  // entry open 100 * 0.999, factor 0.98 on both days: return = exit adj / (entry open * factor) - 1 = 110 / 99.9 - 1; SPY 404 / (400 * 0.999) - 1
  assert.ok(Math.abs(o.ret - (110 / 99.9 - 1)) < 1e-9);
  assert.ok(Math.abs(o.bench_ret - (404 / (400 * 0.999) - 1)) < 1e-9, 'SPY: the same open-to-close dates');
  assert.ok(Math.abs(o.excess - (o.ret - o.bench_ret)) < 1e-12);
  // NOBAR has no score on any variant: no outcome row
  assert.equal(count(L.app, 'SELECT COUNT(*) AS n FROM candidate_outcome WHERE candidate_id = ?', `run-${D}/NOBAR/${MOM_BUILD}`), 0);
  const again = L.shadow.resolveOutcomes();
  assert.equal(again.momentum.filled, 0);
  await L.app.stop();
});

test('momentum shadow: a step logs both rules, one failing day does not stop the other rule, health names both, and it can be switched off', async () => {
  const L = await setup({ shadowOpts: { momentum: true, startDay: D } });
  const s = await L.shadow.step();
  assert.equal(s.logged.length >= 1, true);
  assert.equal(s.momentum.logged.length >= 1, true);
  assert.equal(count(L.app, 'SELECT COUNT(*) AS n FROM shadow_day WHERE scoring_build = ?', MOM_BUILD) >= 1, true);
  const line = L.shadow.health().summary;
  assert.match(line, new RegExp(`shadow candidates \\(build ${SCORING_BUILD}\\)`));
  assert.match(line, new RegExp(`momentum \\(build ${MOM_BUILD}, six variants\\)`));
  assert.match(line, /not a prediction/);
  await L.app.stop();
  const Off = await setup({ shadowOpts: { momentum: false, startDay: D } });
  const o = await Off.shadow.step();
  assert.equal(o.momentum, undefined);
  assert.equal(count(Off.app, 'SELECT COUNT(*) AS n FROM shadow_day WHERE scoring_build = ?', MOM_BUILD), 0);
  assert.doesNotMatch(Off.shadow.health().summary, /momentum/);
  await Off.app.stop();
});

test('momentum shadow: days inside the backtest holdout are refused for momentum too', async () => {
  const L = await setup();
  assert.throws(() => L.shadow.logDay('2026-11-13', { rule: 'momentum' }), /inside the backtest holdout/);
  await L.app.stop();
});
