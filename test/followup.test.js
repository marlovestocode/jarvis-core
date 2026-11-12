'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isNo } = require('../src/core/brain/guard');
const { resolveFollowUp, FOLLOWUP_MS } = require('../src/core/livestate/followup');

const T = 1_000_000;
const snap = (o = {}) => ({ t: T, tools: [], groups: { list: [] }, ...o });
const ran = (ago, extra = {}) => snap({ tools: [{ name: 'x', ok: true, soft: false, t: T - ago }], groups: { list: ['media'] }, ...extra });

test('FOLLOWUP_MS is 3 minutes', () => assert.equal(FOLLOWUP_MS, 180000));

test('confirm', () => {
  const c = { summary: 's', ageMs: 1 };
  assert.deepEqual(resolveFollowUp('yes', snap({ confirm: c })), { kind: 'confirm' });
  assert.equal(resolveFollowUp('yes', snap()), null);
  assert.deepEqual(resolveFollowUp('no thanks', snap({ confirm: c })), isNo('no thanks') ? { kind: 'confirm' } : null);
});

test('continue', () => {
  for (const t of ['do it again', 'undo that', 'another one'])
    assert.deepEqual(resolveFollowUp(t, ran(30000)), { kind: 'continue', groups: ['media'] });
  assert.equal(resolveFollowUp('play it again', snap()), null);
  assert.equal(resolveFollowUp('play it again', ran(5 * 60 * 1000)), null);
  assert.equal(resolveFollowUp('play it again', ran(1000, { groups: { list: [] } })), null);
  assert.equal(resolveFollowUp('please tell me what it was that you did', ran(1000)), null);
});

test('media', () => {
  const m = p => snap({ media: { playing: p } });
  assert.deepEqual(resolveFollowUp('pause', m(true)), { kind: 'media', action: 'pause' });
  assert.deepEqual(resolveFollowUp('Skip!', m(true)), { kind: 'media', action: 'skip' });
  assert.equal(resolveFollowUp('pause', m(false)), null);
  assert.deepEqual(resolveFollowUp('resume', m(false)), { kind: 'media', action: 'resume' });
  assert.equal(resolveFollowUp('resume', m(true)), null);
  assert.equal(resolveFollowUp('skip', snap()), null);
  assert.equal(resolveFollowUp('play', snap()), null);
});

test('bad input', () => {
  for (const x of [null, undefined, 42, {}, ''])
    assert.equal(resolveFollowUp(x, ran(1000)), null);
  assert.equal(resolveFollowUp('yes', null), null);
  assert.equal(resolveFollowUp('yes', undefined), null);
});
