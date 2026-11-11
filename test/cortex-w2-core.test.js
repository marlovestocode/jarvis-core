// Wave 2 core additions (plan E1–E4): edge eta, scaleEdge, unlinkAll, retention except, machine records.
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/core/cortex');

function setup() {
  let t = 1_700_000_000_000;
  const c = open({ now: () => t });
  const src = c.source.add({ kind: 'tool', ref: 'test' });
  const node = (text, kind = 'track') => c.node.upsert({ kind, text, source: src }).id;
  const w = (a, b, type) => c.neighbors(a, { types: [type] }).find(n => n.id === b)?.weight;
  return { c, src, node, w, advance: ms => { t += ms; } };
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('cortex-w2: link with eta starts a new edge at eta and grows an existing one by eta', () => {
  const { c, node, w } = setup();
  const a = node('song a one'), b = node('song b two');
  c.link(a, b, 'next', { eta: 0.15 });
  assert.ok(near(w(a, b, 'next'), 0.15));
  c.link(a, b, 'next', { eta: 0.15 });
  assert.ok(near(w(a, b, 'next'), 0.15 + 0.15 * 0.85));
});

test('cortex-w2: scaleEdge scales one edge only', () => {
  const { c, node, w } = setup();
  const a = node('song a one'), b = node('song b two'), d = node('song d four');
  c.link(a, b, 'next', { weight: 0.5 });
  c.link(a, d, 'next', { weight: 0.5 });
  assert.equal(c.scaleEdge(a, b, 'next', 0.6), true);
  assert.ok(near(w(a, b, 'next'), 0.3));
  assert.ok(near(w(a, d, 'next'), 0.5));
  assert.equal(c.scaleEdge(b, a, 'next', 0.6), false);   // no such edge
});

test('cortex-w2: scaleEdge refuses a structural edge', () => {
  const { c, node, w } = setup();
  const a = node('song a one'), b = node('song b two');
  c.link(a, b, 'supersedes', { weight: 1 });
  assert.equal(c.scaleEdge(a, b, 'supersedes', 0.5), false);
  assert.ok(w(a, b, 'supersedes') > 0.99);
});

test('cortex-w2: unlinkAll removes every edge of that type from the src, no other', () => {
  const { c, node } = setup();
  const p = node('gym playlist', 'playlist');
  const tracks = [];
  for (let i = 0; i < 60; i++) { const t = node('track number ' + i); tracks.push(t); c.link(p, t, 'contains', { weight: 1 }); }
  c.link(p, tracks[0], 'similar', { weight: 0.5 });
  assert.equal(c.unlinkAll(p, 'contains'), 60);
  assert.equal(c.neighbors(p, { types: ['contains'] }).length, 0);
  assert.equal(c.neighbors(p, { types: ['similar'] }).length, 1);
});

test('cortex-w2: deleteWhere keepNewest keeps an excepted old event', () => {
  const { c } = setup();
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(c.event.add({ kind: 'action', payload: { i }, at: 1000 + i }));
  assert.equal(c.event.deleteWhere({ kind: 'action', keepNewest: 3, except: [ids[0]] }), 6);
  assert.deepEqual(c.event.query({ kind: 'action' }).map(e => e.payload.i), [0, 7, 8, 9]);
});

test('cortex-w2: machine records skip the secret pattern (E1)', () => {
  const { c, src } = setup();
  const at = 1_731_340_000_000;
  assert.ok(c.event.add({ kind: 'play', payload: { id: `${at}-abcdefghijk`, at, title: 'Secret', artist: 'Madonna' } }) > 0);
  assert.ok(c.event.add({ kind: 'playlist_edit', payload: { id: 3, at, playlistTitle: 'Token songs' } }) > 0);
  assert.ok(c.event.add({ kind: 'action', payload: { what: 'move_files', undo: [{ from: 'C:\\secret 1234567890123.pdf', to: 'D:\\x.pdf' }] } }) > 0);
  assert.ok(c.node.upsert({ kind: 'track', key: 'track:abc', text: 'Secret — Madonna', data: { videoId: 'abcdefghijk' }, source: src }).id);
  assert.ok(c.node.upsert({ kind: 'file', key: 'path:c:\\secret.docx', text: 'C:\\secret.docx', source: src }).id);
});

test('cortex-w2: free text keeps the secret pattern', () => {
  const { c, src } = setup();
  assert.throws(() => c.node.upsert({ kind: 'fact', text: 'my password is hunter2', source: src }), { code: 'secret' });
  assert.throws(() => c.event.add({ kind: 'tool', payload: { name: 'x', args: { n: 1234567890123 } } }), { code: 'secret' });
});
