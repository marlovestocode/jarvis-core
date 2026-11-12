'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isNo } = require('../src/core/brain/guard');
const { resolveFollowUp, FOLLOWUP_MS } = require('../src/core/livestate/followup');

const T = 1_000_000;
const snap = (o = {}) => ({ t: T, tools: [], groups: { list: [], at: T }, ...o });
const ran = (ago, extra = {}) => snap({ tools: [{ name: 'x', ok: true, soft: false, t: T - ago }], groups: { list: ['media'], at: T - ago }, ...extra });

test('FOLLOWUP_MS is 3 minutes', () => assert.equal(FOLLOWUP_MS, 180000));

test('confirm', () => {
  const c = { summary: 's', ageMs: 1 };
  assert.deepEqual(resolveFollowUp('yes', snap({ confirm: c })), { kind: 'confirm' });
  assert.equal(resolveFollowUp('yes', snap()), null);
  assert.equal(isNo('no'), true);
  assert.deepEqual(resolveFollowUp('no', snap({ confirm: c })), { kind: 'confirm' });
});

test('continue', () => {
  for (const t of ['do it again', 'play it again', 'undo that', 'another one', 'skip it'])
    assert.deepEqual(resolveFollowUp(t, ran(30000)), { kind: 'continue', groups: ['media'] });
  assert.equal(resolveFollowUp('play it again', snap()), null);
  assert.equal(resolveFollowUp('play it again', ran(5 * 60 * 1000)), null);
  assert.equal(resolveFollowUp('play it again', ran(1000, { groups: { list: [], at: T } })), null);
  for (const t of ["thanks, that's great", "that's it", 'is that right?', "that's all, thank you", 'no worries about it'])
    assert.equal(resolveFollowUp(t, ran(1000)), null, t);
  assert.deepEqual(resolveFollowUp('do it again one two three', ran(1000)), { kind: 'continue', groups: ['media'] }); // 6 words
  assert.equal(resolveFollowUp('do it again one two three four', ran(1000)), null); // 7 words
  assert.equal(resolveFollowUp('play it again', snap({ tools: [{ name: 'x', ok: true, soft: false, t: T - 1000 }], groups: { list: ['media'], at: T - FOLLOWUP_MS - 1 } })), null);
  assert.equal(resolveFollowUp('please tell me what it was that you did', ran(1000)), null);
});

test('media', () => {
  const m = p => snap({ media: { playing: p } });
  assert.deepEqual(resolveFollowUp('pause', m(true)), { kind: 'media', action: 'pause' });
  assert.deepEqual(resolveFollowUp('Skip!', m(true)), { kind: 'media', action: 'skip' });
  assert.equal(resolveFollowUp('pause', m(false)), null);
  assert.deepEqual(resolveFollowUp('resume', m(false)), { kind: 'media', action: 'resume' });
  assert.equal(resolveFollowUp('resume', m(true)), null);
  assert.deepEqual(resolveFollowUp('play', m(false)), { kind: 'media', action: 'play' });
  assert.deepEqual(resolveFollowUp('unmute', m(false)), { kind: 'media', action: 'unmute' });
  assert.equal(resolveFollowUp('play', m(true)), null);
  assert.equal(resolveFollowUp('skip', snap()), null);
  assert.equal(resolveFollowUp('play', snap()), null);
});

test('bad input', () => {
  for (const x of [null, undefined, 42, {}, ''])
    assert.equal(resolveFollowUp(x, ran(1000)), null);
  assert.equal(resolveFollowUp('yes', null), null);
  assert.equal(resolveFollowUp('yes', undefined), null);
});
