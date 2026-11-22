const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../src/core/stockman/learning/scoring');
const { makeLearning, putBars, walk, tradingDays } = require('./helpers/stockman-learning');

// 26 sessions: adj 100 + (i%3)*0.5 for 21 sessions, then 103, 102, 101, 99, 97. Golden numbers computed independently (python) from the rule in note 06.
const ADJ = [...Array.from({ length: 21 }, (_, i) => 100 + (i % 3) * 0.5), 103, 102, 101, 99, 97];
const SESS = Array.from({ length: 26 }, (_, i) => `d${i}`);
const feats = () => S.computeFeatures({ sessions: SESS, adjOn: d => ADJ[SESS.indexOf(d)] });

test('scoring: features and the primary score match the note 06 formula (golden values)', () => {
  const f = feats();
  assert.ok(Math.abs(f.r5 - -0.03960396039603964) < 1e-12);
  assert.ok(Math.abs(f.vol20 - 0.010372648033171) < 1e-12);
  const v = S.variantScores(f);
  assert.ok(Math.abs(v.rev5s - 1.7075128229658343) < 1e-12, 'score = -r5 / (vol20 * sqrt(5))');
  assert.ok(Math.abs(v.rev3s - 2.7284723913603406) < 1e-12);
  assert.ok(Math.abs(v.rev10 - 0.030000000000000027) < 1e-12, 'unscaled variant = -r10');
  assert.ok(Math.abs(v.rev10s - 0.9146008762822107) < 1e-12);
});

test('scoring: the same inputs give the same score, byte for byte, in any input order, with the build id', () => {
  const a = feats(), b = feats();
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(S.variantScores(a)), JSON.stringify(S.variantScores(b)));
  const rows = Array.from({ length: 30 }, (_, i) => ({ symbol: `S${String(i).padStart(2, '0')}`, eligible: true, score: Math.floor(i / 2) }));
  const x = S.selectBasket(rows), y = S.selectBasket([...rows].reverse());
  assert.deepEqual([...x.entries()].sort(), [...y.entries()].sort(), 'basket does not depend on input order');
  assert.match(S.SCORING_BUILD, /^rev-v\d/);
});

test('scoring: no randomness, no clock, no network, no LLM in the scoring code; at most 6 variants', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/core/stockman/learning/scoring.js'), 'utf8').replace(/\/\/.*$/gm, '');
  for (const bad of ['Math.random', 'Date.now', 'new Date(', 'fetch', 'ollama', 'crypto']) assert.ok(!src.includes(bad), `scoring.js must not use ${bad}`);
  assert.ok(S.VARIANTS.length <= S.MAX_VARIANTS && S.MAX_VARIANTS === 6);
  assert.ok(S.VARIANTS.some(v => v.id === S.PRIMARY_VARIANT));
  assert.ok(Object.isFrozen(S.PARAMS) && S.PARAMS.basketSize === 20 && S.PARAMS.minBars === 60 && S.PARAMS.minPrice === 5 && S.PARAMS.gapWindow === 25);
});

test('scoring: a missing close makes a feature null instead of a guess', () => {
  const f = S.computeFeatures({ sessions: SESS, adjOn: d => (d === 'd21' ? null : ADJ[SESS.indexOf(d)]) });   // d21 is 4 sessions back from d25
  assert.notEqual(f.r5, null, 'r5 uses d20, not d21');
  assert.notEqual(f.r3, null, 'r3 does not use d21 (3 sessions back is d22)');
  assert.equal(f.vol20, null, 'one missing return makes the whole volatility null');
  const flat = S.computeFeatures({ sessions: SESS, adjOn: () => 100 });
  assert.equal(flat.vol20, 0);
  assert.equal(S.variantScores(flat).rev5s, null, 'zero volatility gives no scaled score');
  assert.equal(S.variantScores(flat).rev5, -0, 'the unscaled variant is still defined');
});

test('scoring: eligibility reasons, and ineligible candidates are still scored', () => {
  const f = feats();
  const ok = S.scoreCandidate({ hasBarOnDay: true, nBars: 200, close: 50, features: f, gap25: false, flags: { earnings_in_window: false, earnings_possible: false, earnings_data: 'confirmed' } });
  assert.equal(ok.eligible, true); assert.deepEqual(ok.reasons, []); assert.ok(ok.score > 1.7);
  const reasons = args => S.scoreCandidate({ hasBarOnDay: true, nBars: 200, close: 50, features: f, gap25: false, ...args });
  assert.deepEqual(reasons({ nBars: 59 }).reasons, ['insufficient_history']);
  assert.equal(reasons({ nBars: 60 }).eligible, true, '60 bars is enough');
  assert.deepEqual(reasons({ close: 5 }).reasons, ['price_not_above_5'], 'above USD 5 means strictly above');
  assert.equal(reasons({ close: 5.01 }).eligible, true);
  assert.deepEqual(reasons({ gap25: true }).reasons, ['bar_gap_25']);
  const inWin = reasons({ flags: { earnings_in_window: true, earnings_possible: false, earnings_data: 'confirmed' } });
  assert.deepEqual(inWin.reasons, ['earnings_in_window']); assert.ok(inWin.score !== null, 'excluded for earnings but still scored');
  assert.deepEqual(reasons({ flags: { earnings_in_window: false, earnings_possible: true, earnings_data: 'estimated' } }).reasons, ['earnings_possible']);
  assert.equal(reasons({ flags: { earnings_in_window: false, earnings_possible: false, earnings_data: 'unknown' } }).eligible, true, 'unknown earnings data is not an exclusion in note 06');
  const none = S.scoreCandidate({ hasBarOnDay: false, notFound: true });
  assert.deepEqual(none.reasons, ['provider_has_no_bars', 'no_bar_on_day']); assert.equal(none.score, null);
  assert.deepEqual(reasons({ features: S.computeFeatures({ sessions: SESS, adjOn: () => 100 }) }).reasons, ['zero_volatility']);
});

test('scoring: the basket is the 20 highest eligible scores, ties broken by symbol, ineligible never ranked', () => {
  const rows = [];
  for (let i = 0; i < 25; i++) rows.push({ symbol: `A${String(i).padStart(2, '0')}`, eligible: true, score: 1 + (i % 5) });
  rows.push({ symbol: 'ZBIG', eligible: false, score: 99 }, { symbol: 'NOSC', eligible: true, score: null });
  const k = S.selectBasket(rows);
  assert.equal(k.has('ZBIG'), false); assert.equal(k.has('NOSC'), false);
  assert.equal([...k.values()].filter(x => x.inBasket).length, 20);
  assert.equal(k.size, 25);
  assert.deepEqual([...k.entries()].filter(([, v]) => v.rank <= 5).map(([s]) => s).sort(), ['A04', 'A09', 'A14', 'A19', 'A24'].map(s => s), 'score 5 first, then symbol order');
});

test('scoring: horizon is entry = next session, exit = the 5th session held', () => {
  assert.deepEqual(S.horizonDays('2026-11-16'), { entryDay: '2026-11-17', exitDay: '2026-11-23' });
  assert.deepEqual(S.horizonDays('2026-11-20'), { entryDay: '2026-11-23', exitDay: '2026-11-30' }, 'Thanksgiving 11-26 is closed');
});

test('scoring: scoreDay reads bars from the database, counts clean bars, sees gaps and the provider not-found list', async () => {
  const days = tradingDays('2026-08-03', '2026-11-16');   
  const L = await makeLearning({ members: [] });
  putBars(L.app, 'OLD', days, { price: walk('OLD') });
  putBars(L.app, 'NEW', days.slice(-30), { price: walk('NEW') });              // listed recently: too few bars
  putBars(L.app, 'HOLE', days, { price: walk('HOLE'), skip: [days.at(-10)] }); // one missing session in the last 25
  putBars(L.app, 'PENNY', days, { price: () => 4.5 });
  L.app.db.stmt("INSERT INTO bar_history(symbol, status, attempts) VALUES ('GONE', 'not_found', 1)").run();
  const r = L.scoring.scoreDay({ day: '2026-11-16', symbols: ['GONE', 'PENNY', 'HOLE', 'NEW', 'OLD', 'OLD'] });
  const by = Object.fromEntries(r.rows.map(x => [x.symbol, x]));
  assert.equal(r.rows.length, 5, 'duplicates collapse');
  assert.equal(r.build, S.SCORING_BUILD);
  assert.deepEqual(by.OLD.reasons, []); assert.equal(by.OLD.eligible, true); assert.equal(by.OLD.rank, 1);
  assert.equal(by.OLD.features.nBars, days.length);
  assert.deepEqual(by.NEW.reasons, ['insufficient_history']);
  assert.deepEqual(by.HOLE.reasons, ['bar_gap_25', 'no_features']); assert.equal(by.HOLE.score, null, 'a missing close inside the volatility window gives no score, never a guess');
  assert.deepEqual(by.PENNY.reasons, ['price_not_above_5', 'zero_volatility']);
  assert.deepEqual(by.GONE.reasons, ['provider_has_no_bars', 'no_bar_on_day']);
  assert.equal(by.GONE.score, null);
  const again = L.scoring.scoreDay({ day: '2026-11-16', symbols: ['OLD', 'HOLE', 'GONE', 'NEW', 'PENNY'] });
  assert.deepEqual(again.rows, r.rows, 'same data, same scores, any symbol order');
  await L.app.stop();
});

test('scoring: only bars up to the signal day are used (a later crash does not change the score)', async () => {
  const days = tradingDays('2026-08-03', '2026-11-27');
  const L = await makeLearning();
  const p = walk('LAGG');
  putBars(L.app, 'LAGG', days, { price: p });
  const before = L.scoring.scoreDay({ day: '2026-11-16', symbols: ['LAGG'] }).rows[0];
  putBars(L.app, 'LAGG', days.filter(d => d > '2026-11-16'), { price: () => 1 });   // the future collapses
  const after = L.scoring.scoreDay({ day: '2026-11-16', symbols: ['LAGG'] }).rows[0];
  assert.deepEqual(after, before);
  await L.app.stop();
});
