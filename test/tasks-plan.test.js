'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_STEPS, validatePlan, resolveRefs, check } = require('../src/core/tasks/plan');

const ctx = (o = {}) => ({ resolves: () => true, riskOf: () => undefined, tainted: false, ...o });

test('MAX_STEPS is 12', () => assert.equal(MAX_STEPS, 12));

test('validatePlan accepts and assigns ids', () => {
  const r = validatePlan([{ tool: 'a', args: { x: 1 } }, { tool: 'b', args: { y: { $ref: 's1' } }, expect: { nonEmpty: true } }], ctx());
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map(s => s.id), ['s1', 's2']);
  assert.deepEqual(r.steps[0], { id: 's1', tool: 'a', args: { x: 1 }, expect: undefined, status: 'pending', attempts: 0, result: null });
  assert.deepEqual(r.steps[1].expect, { nonEmpty: true });
  assert.deepEqual(validatePlan([{ tool: 'a' }], ctx()).steps[0].args, {});
});

test('validatePlan rejections', () => {
  const bad = (steps, c, re) => {
    const r = validatePlan(steps, ctx(c));
    assert.equal(r.ok, false);
    assert.match(r.text, re);
  };
  bad([], {}, /at least one/i);
  bad('x', {}, /at least one/i);
  bad(Array.from({ length: 13 }, () => ({ tool: 'a' })), {}, /12/);
  bad([{ tool: 'a' }, { tool: 'zz' }], { resolves: n => n !== 'zz' }, /s2.*zz/);
  bad([{ tool: 'a', args: { v: { $ref: 's2' } } }, { tool: 'b' }], {}, /s1.*s2/);
  bad([{ tool: 'a', args: { v: { $ref: 's9' } } }], {}, /s1.*s9/);
  bad([{ tool: 'a', args: { v: [{ $ref: 's1' }] } }], {}, /s1/);
  bad([{ tool: 'a', expect: { nonEmpty: true, contains: 'x' } }], {}, /s1.*exactly one/i);
  bad([{ tool: 'a', expect: {} }], {}, /s1.*exactly one/i);
  bad([{ tool: 'a', expect: { foo: 1 } }], {}, /s1.*foo/);
  bad([{ tool: 'a', expect: { matches: '(' } }], {}, /s1.*regex/i);
  bad([{ tool: 'a' }, { tool: 'send' }], { riskOf: n => (n === 'send' ? 'confirm' : undefined), tainted: true }, /s2.*send/);
  assert.equal(validatePlan([{ tool: 'send' }], ctx({ riskOf: () => 'confirm', tainted: false })).ok, true);
});

test('validatePlan refuses task tools as steps', () => {
  for (const tool of ['task_run', 'task_control']) {
    const r = validatePlan([{ tool: 'a' }, { tool, args: {} }], ctx());
    assert.equal(r.ok, false, tool);
    assert.match(r.text, /s2/);
    assert.match(r.text, /cannot start or control another task/);
  }
});

test('resolveRefs whole text and nesting', () => {
  const m = new Map([['s1', 'hello']]);
  assert.deepEqual(resolveRefs({ a: { $ref: 's1' }, b: [{ $ref: 's1' }, 2], c: { d: { $ref: 's1' } }, e: 'lit' }, m),
    { ok: true, args: { a: 'hello', b: ['hello', 2], c: { d: 'hello' }, e: 'lit' } });
});

test('resolveRefs pick', () => {
  const m = new Map([['s1', '{"a":{"b":[{"id":7}]}}'], ['s2', 'item id=42 here'], ['s3', 'abc']]);
  assert.deepEqual(resolveRefs({ v: { $ref: 's1', pick: 'a.b[0].id' } }, m), { ok: true, args: { v: '7' } });
  assert.deepEqual(resolveRefs({ v: { $ref: 's1', pick: 'a.b[0]' } }, m).args.v, '{"id":7}');
  assert.deepEqual(resolveRefs({ v: { $ref: 's2', pick: String.raw`/id=(\d+)/` } }, m).args, { v: '42' });
  assert.deepEqual(resolveRefs({ v: { $ref: 's2', pick: String.raw`/id=\d+/` } }, m).args, { v: 'id=42' });
  assert.deepEqual(resolveRefs({ v: { $ref: 's3', pick: '/b/' } }, m).args, { v: 'b' });
});

test('resolveRefs failures name the step', () => {
  const m = new Map([['s1', '{"a":1}'], ['s2', 'plain']]);
  for (const [arg, re] of [
    [{ $ref: 's1', pick: 'z.y' }, /s1/],
    [{ $ref: 's2', pick: 'a.b' }, /s2.*JSON/i],
    [{ $ref: 's2', pick: '/zzz/' }, /s2/],
    [{ $ref: 's9' }, /s9/],
  ]) {
    const r = resolveRefs({ v: arg }, m);
    assert.equal(r.ok, false);
    assert.match(r.text, re);
  }
});

test('check', () => {
  const ok = text => ({ ok: true, text });
  assert.equal(check(undefined, ok('done')).ok, true);
  assert.equal(check(undefined, { ok: false, text: 'x' }).ok, false);
  const sf = check(undefined, ok('Could not find that window'));
  assert.equal(sf.ok, false);
  assert.ok(sf.why);
  assert.equal(check({ nonEmpty: true }, ok('  ')).ok, false);
  assert.equal(check({ nonEmpty: true }, ok('x')).ok, true);
  assert.equal(check({ contains: 'FOO' }, ok('a foo b')).ok, true);
  assert.equal(check({ contains: 'bar' }, ok('a foo b')).ok, false);
  assert.equal(check({ matches: '^ok' }, ok('ok then')).ok, true);
  assert.equal(check({ matches: '^ok' }, ok('no ok')).ok, false);
  const bad = check({ matches: '(' }, ok('x'));
  assert.equal(bad.ok, false);
  assert.ok(bad.why);
});
