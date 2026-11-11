const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/core/cortex/db');
const { createEdges, effective, TYPES } = require('../src/core/cortex/edges');

const DAY = 864e5;
function setup(n = 3) {
  let t = 1_700_000_000_000;
  const db = openDb({ file: ':memory:' });
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(Number(db.stmt('INSERT INTO node(kind, text, created, updated) VALUES (?, ?, 1, 1)').run('fact', 'node ' + i).lastInsertRowid));
  const edges = createEdges(db, { now: () => t });
  return { db, edges, ids, advance: ms => { t += ms; }, stored: (a, b, type) => db.raw.prepare('SELECT weight FROM edge WHERE src = ? AND dst = ? AND type = ?').get(a, b, type)?.weight };
}

test('cortex-edges: type table from the plan', () => {
  assert.deepEqual(TYPES.mentions, { halfLife: 60, fanOut: 20 });
  assert.deepEqual(TYPES.next, { halfLife: 90, fanOut: 10 });
  assert.deepEqual(Object.keys(TYPES).sort(), ['about', 'by', 'contains', 'contradicts', 'from', 'mentions', 'next', 'part_of', 'same_as', 'similar', 'supersedes', 'touched']);
});

test('cortex-edges: decay by half-life', () => {
  assert.ok(Math.abs(effective(0.8, 0, 'mentions', 60 * DAY) - 0.4) < 1e-9);
  assert.ok(Math.abs(effective(0.8, 0, 'next', 90 * DAY) - 0.4) < 1e-9);
});

test('cortex-edges: negative age clamps to the stored weight', () => {
  assert.equal(effective(0.5, 10 * DAY, 'mentions', 0), 0.5);
});

test('cortex-edges: link defaults, explicit weight and explicit-link strengthening', () => {
  const { edges, ids: [a, b], stored } = setup();
  edges.link(a, b, 'mentions');
  assert.equal(stored(a, b, 'mentions'), 0.3);
  edges.link(a, b, 'mentions');
  assert.ok(Math.abs(stored(a, b, 'mentions') - (0.3 + 0.3 * 0.7)) < 1e-9);
  edges.link(a, b, 'similar', { weight: 0.9 });
  assert.equal(stored(a, b, 'similar'), 0.9);
  edges.link(a, b, 'similar', { weight: 0.5 });
  assert.equal(stored(a, b, 'similar'), 0.9);
});

test('cortex-edges: unknown type, self link and missing node refused', () => {
  const { edges, ids: [a, b] } = setup();
  assert.throws(() => edges.link(a, b, 'loves'), e => e.code === 'edge_type');
  assert.throws(() => edges.link(a, a, 'mentions'), e => e.code === 'self_link');
  assert.throws(() => edges.link(a, 9999, 'mentions'));
});

test('cortex-edges: strengthen saturates below 1 and is monotonic', () => {
  const { edges, ids: [a, b], stored } = setup();
  edges.link(a, b, 'mentions');
  let prev = stored(a, b, 'mentions');
  for (let i = 0; i < 100; i++) {
    edges.strengthen([[b, a]], 0.15);   // either direction
    const w = stored(a, b, 'mentions');
    assert.ok(w > prev || w === prev);
    assert.ok(w < 1);
    prev = w;
  }
});

test('cortex-edges: strengthen creates no edges', () => {
  const { db, edges, ids: [a, , c] } = setup();
  edges.strengthen([[a, c]]);
  assert.equal(db.raw.prepare('SELECT count(*) n FROM edge').get().n, 0);
});

test('cortex-edges: weaken multiplies the effective weight by 0.6', () => {
  const { edges, ids: [a, b, c], stored, advance } = setup();
  edges.link(a, b, 'mentions', { weight: 0.8 });
  edges.link(c, b, 'mentions', { weight: 0.5 });
  edges.link(a, c, 'supersedes', { weight: 1 });
  advance(60 * DAY);
  edges.weaken([b]);
  assert.ok(Math.abs(stored(a, b, 'mentions') - 0.4 * 0.6) < 1e-9);
  assert.ok(Math.abs(stored(c, b, 'mentions') - 0.25 * 0.6) < 1e-9);
  assert.equal(stored(a, c, 'supersedes'), 1);   // structural edges and edges not touching b stay
});

test('cortex-edges: neighbors both directions, ordered by effective weight', () => {
  const { edges, ids: [a, b, c] } = setup();
  edges.link(a, b, 'mentions', { weight: 0.4 });
  edges.link(c, a, 'from', { weight: 0.9 });
  const n = edges.neighbors(a);
  assert.deepEqual(n.map(x => [x.id, x.type, x.hop]), [[c, 'from', 1], [b, 'mentions', 1]]);
  assert.deepEqual(edges.neighbors(a, { types: ['mentions'] }).map(x => x.id), [b]);
});

test('cortex-edges: fan-out cap per type', () => {
  const { edges, ids } = setup(32);
  const [hub, ...rest] = ids;
  for (const id of rest.slice(0, 30)) edges.link(hub, id, 'mentions');
  assert.equal(edges.neighbors(hub, { limit: 100 }).length, 20);
  assert.equal(edges.neighbors(hub).length, 20);
  assert.equal(edges.neighbors(hub, { limit: 5 }).length, 5);
});

test('cortex-edges: around a big hub returns the strongest per type, both directions', () => {
  const { edges, ids, db } = setup(402);
  const [hub, ...rest] = ids;
  rest.forEach((id, i) => edges.link(id, hub, 'mentions', { weight: (i + 1) / 1000 }));   // 401 incoming, weights 0.001..0.401
  edges.link(hub, rest[0], 'by', { weight: 0.9 });                                       // one outgoing of another type
  const got = edges.around(hub, Date.now() + 0, null);
  const mentions = got.filter(e => e.type === 'mentions');
  assert.equal(mentions.length, 20);
  assert.deepEqual(mentions.map(e => e.id), rest.slice(-20).reverse());                  // the 20 strongest
  assert.ok(got.some(e => e.type === 'by' && e.id === rest[0]));
  const plan = db.raw.prepare('EXPLAIN QUERY PLAN SELECT src, weight FROM edge WHERE dst = ? ORDER BY weight DESC LIMIT 100').all(hub).map(r => r.detail).join(' ');
  assert.match(plan, /edge_dst_weight/);                                                 // read by index, not all 401 rows
  assert.doesNotMatch(plan, /TEMP B-TREE/);                                              // no sort of every row
});

test('cortex-edges: depth 2 returns hop 2 with via and no repeats', () => {
  const { edges, ids: [a, b, c] } = setup();
  edges.link(a, b, 'mentions', { weight: 0.8 });
  edges.link(b, c, 'mentions', { weight: 0.5 });
  const n = edges.neighbors(a, { depth: 2 });
  assert.deepEqual(n.map(x => [x.id, x.hop, x.via]), [[b, 1, a], [c, 2, b]]);
  assert.ok(Math.abs(n[1].weight - 0.4) < 1e-9);
  assert.ok(!n.some(x => x.id === a));
});

test('cortex-edges: prune removes below the floor only, in chunks', () => {
  const { db, edges, ids: [a, b, c], advance } = setup();
  edges.link(a, b, 'touched', { weight: 0.5 });     // half-life 30 d
  edges.link(a, c, 'same_as', { weight: 0.5 });     // half-life 3650 d
  advance(30 * 6 * DAY);                             // touched: 0.5 / 64 < 0.02
  const r = edges.prune({ floor: 0.02 });
  assert.equal(r.removed, 1);
  assert.equal(r.nextSrc, null);
  assert.deepEqual(db.raw.prepare('SELECT type FROM edge').all().map(x => x.type), ['same_as']);
});

test('cortex-edges: unlink', () => {
  const { edges, ids: [a, b], stored } = setup();
  edges.link(a, b, 'mentions');
  assert.equal(edges.unlink(a, b, 'mentions'), true);
  assert.equal(stored(a, b, 'mentions'), undefined);
  assert.equal(edges.unlink(a, b, 'mentions'), false);
});
