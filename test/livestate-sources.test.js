const test = require('node:test');
const assert = require('node:assert/strict');
const { timersSource } = require('../src/core/livestate/sources');

const NOW = 1_000_000;
const mk = (n, dueOff, extra = {}) => ({ id: `t${n}`, label: `l${n}`, kind: 'timer', due: NOW + dueOff, ...extra });
const src = (list) => timersSource({ list: () => list, now: () => NOW });

test('timersSource: empty list yields null', () => {
  assert.equal(src([])(), null);
});

test('timersSource: 7 timers -> count 7, upcoming capped at 5 and soonest first', () => {
  const list = [1, 2, 3, 4, 5, 6, 7].map((n) => mk(n, n * 1000));
  const r = src(list)();
  assert.equal(r.count, 7);
  assert.equal(r.upcoming.length, 5);
  assert.deepEqual(r.upcoming.map((u) => u.id), ['t1', 't2', 't3', 't4', 't5']);
});

test('timersSource: overdue timer is counted but not upcoming; nextInMs clamps to 0', () => {
  const r = src([mk(1, -500), mk(2, 3000)])();
  assert.equal(r.count, 2);
  assert.deepEqual(r.upcoming.map((u) => u.id), ['t2']);
  assert.equal(r.nextInMs, 0);
});

test('timersSource: nextInMs is min due minus now', () => {
  assert.equal(src([mk(1, 4000), mk(2, 2500)])().nextInMs, 2500);
});

test('timersSource: a timer due exactly now is not upcoming', () => {
  const r = src([mk(1, 0)])();
  assert.equal(r.count, 1);
  assert.deepEqual(r.upcoming, []);
});

test('timersSource: entries hold only id, label, kind, due', () => {
  const r = src([mk(1, 1000, { secret: 'x', extra: 1 })])();
  assert.deepEqual(r.upcoming, [{ id: 't1', label: 'l1', kind: 'timer', due: NOW + 1000 }]);
});

test('timersSource: a throwing list propagates', () => {
  const s = timersSource({ list: () => { throw new Error('boom'); }, now: () => NOW });
  assert.throws(s, /boom/);
});
