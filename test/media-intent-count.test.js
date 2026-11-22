const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/core/media/intent');
const { unbackedClaim } = require('../src/core/brain/guard');

test('queue count questions parse to up_next with a count', () => {
  assert.deepEqual(parse('what 12 songs are next'), { kind: 'query', what: 'next', count: 12 });
  assert.equal(parse('what are the next 5 songs in the queue').count, 5);
  assert.equal(parse('how long are the next 5 songs').count, 5);
  assert.equal(parse("what's up next").count, undefined);
});

test('a promise to look with no tool call is an unbacked claim; "let me know" is not', () => {
  assert.equal(unbackedClaim('Let me check YouTube Music for the next songs.', 0), true);
  assert.equal(unbackedClaim('Let me know if you need more.', 0), false);
  assert.equal(unbackedClaim('Let me check that.', 1), false);
});

test('an open goal is shown to the model only when the user continues it', () => {
  const { createWorkMem } = require('../src/core/context/workmem');
  const wm = createWorkMem();
  wm.record('s', { tool: 'media_control', args: {}, text: 'Volume 10%.', ok: true });
  wm.setGoal('s', { text: 'check youtube music', open: true });
  assert.doesNotMatch(wm.block('s'), /Last goal/);
  assert.match(wm.block('s', { cont: true }), /Last goal \(open\): check youtube music/);
});

test('queue questions are understood by meaning, not by exact phrases', () => {
  for (const t of ['What are the next 12 songs in queue?', 'what is in my queue', 'what is my queue', 'tell me the next 5 tracks in the queue']) assert.equal(parse(t)?.what, 'next', t);
  assert.equal(parse('What are the next 12 songs in queue?').count, 12);
  for (const t of ["what's next on my calendar", 'clear the queue', 'queue up some drake', 'play the next song']) assert.notEqual(parse(t)?.what, 'next', t);
});
