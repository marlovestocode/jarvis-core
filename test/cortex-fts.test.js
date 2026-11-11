const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/core/cortex/db');
const guard = require('../src/core/cortex/guard');

test('cortex-fts: operators become quoted words', () => {
  assert.equal(guard.ftsQuery('"hello" AND world*'), '"hello" OR "and" OR "world"');
});

test('cortex-fts: empty and punctuation-only give null', () => {
  assert.equal(guard.ftsQuery(''), null);
  assert.equal(guard.ftsQuery('!!! ""'), null);
  assert.equal(guard.ftsQuery(null), null);
  assert.equal(guard.ftsQuery('🙂 🐶'), null);
});

test('cortex-fts: unicode kept, one-letter tokens dropped, NEAR quoted', () => {
  assert.equal(guard.ftsQuery('Café über NEAR(x)'), '"café" OR "über" OR "near"');
});

test('cortex-fts: at most 12 tokens, duplicates once', () => {
  const q = guard.ftsQuery('dog dog ' + Array.from({ length: 20 }, (_, i) => 'w' + i).join(' '));
  assert.equal(q.split(' OR ').length, 12);
  assert.equal(q.split(' OR ')[0], '"dog"');
  assert.equal(q.match(/"dog"/g).length, 1);
});

test('cortex-fts: every sanitized query runs in MATCH', () => {
  const db = openDb({ file: ':memory:' });
  db.stmt('INSERT INTO node(kind, text, created, updated) VALUES (?, ?, 1, 1)').run('fact', 'Café near the river');
  for (const raw of ['"hello" AND world*', 'Café über NEAR(x)', '" OR * NEAR(', 'a-b c:d {e} ^f', "it's", 'cafe']) {
    const q = guard.ftsQuery(raw);
    if (q) assert.doesNotThrow(() => db.raw.prepare('SELECT rowid FROM node_fts WHERE node_fts MATCH ?').all(q), raw);
  }
  assert.equal(db.raw.prepare('SELECT count(*) n FROM node_fts WHERE node_fts MATCH ?').get(guard.ftsQuery('cafe')).n, 1); // diacritics folded
  db.close();
});

test('cortex-fts: isCorrection', () => {
  assert.equal(guard.isCorrection('no, that is wrong'), true);
  assert.equal(guard.isCorrection("That's not right"), true);
  assert.equal(guard.isCorrection('stop saying that'), true);
  assert.equal(guard.isCorrection('wrong one'), true);
  assert.equal(guard.isCorrection('now play music'), false);
  assert.equal(guard.isCorrection('nothing new'), false);
});

test('cortex-fts: checkText refuses secrets, bad length and unknown kinds', () => {
  const code = fn => { try { fn(); return null; } catch (e) { assert.ok(e instanceof guard.CortexError); return e.code; } };
  assert.equal(code(() => guard.checkText('fact', 'my password is x')), 'secret');
  assert.equal(code(() => guard.checkText('fact', 'card 4111 1111 1111 1111')), 'secret');
  assert.equal(code(() => guard.checkText('fact', 'hi')), 'too_short');
  assert.equal(code(() => guard.checkText('fact', 'x'.repeat(301))), 'too_long');
  assert.equal(code(() => guard.checkText('nope', 'valid text')), 'kind');
  assert.equal(guard.checkText('fact', '  Rex   is my dog '), 'Rex is my dog');
  assert.equal(guard.checkText('knowledge', 'k'.repeat(2000)).length, 2000);
});

test('cortex-fts: checkData', () => {
  assert.equal(guard.checkData(undefined), null);
  assert.equal(guard.checkData({ tier: 'profile' }), '{"tier":"profile"}');
  assert.throws(() => guard.checkData({ s: 'x'.repeat(4100) }), e => e.code === 'data_too_big');
  assert.throws(() => guard.checkData('str'), e => e.code === 'data');
  assert.throws(() => guard.checkData({ k: 'my api key is abc' }), e => e.code === 'secret');
});
