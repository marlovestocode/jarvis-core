const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/core/cortex/db');
const { createEvents } = require('../src/core/cortex/events');

function setup() {
  const db = openDb({ file: ':memory:' });
  return { db, events: createEvents(db, { now: () => 5000 }) };
}

test('cortex-events: append and range (since inclusive, until exclusive)', () => {
  const { events } = setup();
  for (const at of [1000, 2000, 3000, 4000]) events.add({ kind: 'play', payload: { at }, at });
  assert.deepEqual(events.query({ kind: 'play', since: 2000, until: 4000 }).map(e => e.at), [2000, 3000]);
  assert.equal(events.add({ kind: 'tool', payload: { name: 'x' } }) > 0, true);
  assert.equal(events.query({ kind: 'tool' })[0].at, 5000);   // default at = now()
});

test('cortex-events: order and limit', () => {
  const { events } = setup();
  for (const at of [1, 2, 3]) events.add({ kind: 'action', payload: { at }, at });
  assert.deepEqual(events.query({ kind: 'action', order: 'desc', limit: 2 }).map(e => e.at), [3, 2]);
  assert.deepEqual(events.query({ kind: 'action' }).map(e => e.at), [1, 2, 3]);
});

test('cortex-events: payload round-trips and nodeId filter', () => {
  const { db, events } = setup();
  const n = Number(db.stmt('INSERT INTO node(kind, text, created, updated) VALUES (?, ?, 1, 1)').run('track', 'Song — Artist').lastInsertRowid);
  const p = { videoId: 'abc', heard: 120, ratio: 0.9, tags: ['x'] };
  events.add({ kind: 'play', nodeId: n, payload: p, at: 10 });
  events.add({ kind: 'play', payload: { videoId: 'zzz' }, at: 11 });
  const got = events.query({ kind: 'play', nodeId: n });
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].payload, p);
  assert.equal(got[0].nodeId, n);
});

test('cortex-events: refusals', () => {
  const { events } = setup();
  assert.throws(() => events.add({ kind: 'party', payload: {} }), e => e.code === 'event_kind');
  assert.throws(() => events.add({ kind: 'tool', payload: { args: 'my password is x' } }), e => e.code === 'secret');
  assert.throws(() => events.add({ kind: 'tool', payload: { s: 'x'.repeat(5000) } }), e => e.code === 'data_too_big');
});

test('cortex-events: node delete keeps the event with node_id NULL', () => {
  const { db, events } = setup();
  const n = Number(db.stmt('INSERT INTO node(kind, text, created, updated) VALUES (?, ?, 1, 1)').run('track', 'Song — Artist').lastInsertRowid);
  events.add({ kind: 'play', nodeId: n, payload: {}, at: 1 });
  db.stmt('DELETE FROM node WHERE id = ?').run(n);
  const [e] = events.query({ kind: 'play' });
  assert.equal(e.nodeId, null);
});

test('cortex-events: count and deleteWhere keepNewest', () => {
  const { events } = setup();
  for (let at = 1; at <= 10; at++) events.add({ kind: 'action', payload: { at }, at });
  events.add({ kind: 'tool', payload: {}, at: 1 });
  assert.equal(events.count({ kind: 'action' }), 10);
  assert.equal(events.count(), 11);
  assert.equal(events.deleteWhere({ kind: 'action', keepNewest: 3 }), 7);
  assert.deepEqual(events.query({ kind: 'action' }).map(e => e.at), [8, 9, 10]);
  assert.equal(events.deleteWhere({ kind: 'action', before: 9 }), 1);
  assert.equal(events.count({ kind: 'tool' }), 1);
});
