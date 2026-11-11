const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open } = require('../src/core/cortex');
const { createMemory, entityKey } = require('../src/core/memory/facts');

function setup(opts = {}) {
  let t = 1_700_000_000_000;
  const now = () => (t += 1000);
  const cortex = open({ now: () => t });
  const memory = createMemory({ cortex, now, ...opts });
  return { cortex, memory };
}

test('memory-facts: entityKey normalizes names', () => {
  assert.equal(entityKey('  Rex! '), 'entity:rex');
  assert.equal(entityKey('New-York  City'), 'entity:new york city');
});

test('memory-facts: add saves an active profile fact from the user', () => {
  const { cortex, memory } = setup();
  const r = memory.add('I prefer Fahrenheit.');
  assert.deepEqual(r, { ok: true, text: 'I prefer Fahrenheit' });
  const [n] = cortex.node.list({ kind: 'fact' });
  assert.equal(n.data.tier, 'profile');
  assert.equal(cortex.node.get(n.id).sources[0].kind, 'user');
});

test('memory-facts: propose writes pending, not in list() or digest()', () => {
  const { cortex, memory } = setup();
  const r = memory.propose({ text: 'Rex is my dog', tier: 'note', quote: 'my dog Rex', sessionId: 's1', entities: [{ name: 'Rex', type: 'pet' }] });
  assert.ok(r.id);
  assert.equal(cortex.node.get(r.id).status, 'pending');
  assert.deepEqual(memory.list(), []);
  assert.equal(memory.digest(), '');
  assert.equal(memory.count(), 0);
  assert.equal(memory.pending().length, 1);
  assert.equal(memory.pending()[0].text, 'Rex is my dog');
  const ent = cortex.node.find({ kind: 'entity', key: 'entity:rex' });
  assert.equal(ent.status, 'pending');
  assert.ok(cortex.neighbors(r.id).some(n => n.id === ent.id && n.type === 'mentions'));
});

test('memory-facts: propose links the fact to its chat node', () => {
  const { cortex, memory } = setup();
  const src = cortex.source.add({ kind: 'model', ref: 'history/s1.json' });
  const chat = cortex.node.upsert({ kind: 'chat', key: 'chat:s1', text: 'We talked about the dog', source: src }).id;
  const r = memory.propose({ text: 'Rex is my dog', sessionId: 's1', chatNodeId: chat });
  assert.ok(cortex.neighbors(r.id).some(n => n.id === chat && n.type === 'from'));
});

test('memory-facts: approve activates the fact and its pending entities; edit text on approve', () => {
  const { cortex, memory } = setup();
  const r = memory.propose({ text: 'Rex is my dog', sessionId: 's1', entities: [{ name: 'Rex', type: 'pet' }] });
  assert.equal(memory.approve(r.id, { text: 'Rex is my beagle' }).ok, true);
  assert.deepEqual(memory.list(), ['Rex is my beagle']);
  assert.equal(cortex.node.find({ kind: 'entity', key: 'entity:rex' }).status, 'active');
  assert.equal(memory.pending().length, 0);
});

test('memory-facts: reject leaves a tombstone that blocks the same text later and drops its pending entity', () => {
  const { cortex, memory } = setup();
  const r = memory.propose({ text: 'Rex is my dog', sessionId: 's1', entities: [{ name: 'Rex', type: 'pet' }] });
  assert.equal(memory.reject(r.id).ok, true);
  const n = cortex.node.get(r.id);
  assert.equal(n.status, 'archived');
  assert.equal(n.data.rejected, true);
  assert.equal(cortex.node.find({ kind: 'entity', key: 'entity:rex' }), null);
  assert.deepEqual(memory.propose({ text: 'rex is my dog!', sessionId: 's2' }), { skipped: 'rejected' });
  assert.equal(memory.stats().rejected, 1);
});

test('memory-facts: an entity shared with an active fact survives a rejection', () => {
  const { cortex, memory } = setup();
  const a = memory.propose({ text: 'Rex is my dog', sessionId: 's1', entities: [{ name: 'Rex', type: 'pet' }] });
  const b = memory.propose({ text: 'Rex sees the vet in March', sessionId: 's1', entities: [{ name: 'Rex', type: 'pet' }] });
  memory.approve(a.id);
  memory.reject(b.id);
  assert.equal(cortex.node.find({ kind: 'entity', key: 'entity:rex' }).status, 'active');
});

test('memory-facts: duplicates of active or pending facts are skipped', () => {
  const { memory } = setup();
  memory.add('Rex is my dog');
  assert.deepEqual(memory.propose({ text: 'Rex is my dog.', sessionId: 's1' }), { skipped: 'duplicate' });
  memory.propose({ text: 'I live in Abilene', sessionId: 's1' });
  assert.deepEqual(memory.propose({ text: 'i live in abilene', sessionId: 's2' }), { skipped: 'duplicate' });
});

test('memory-facts: an explicit add of a pending fact approves it', () => {
  const { memory } = setup();
  memory.propose({ text: 'I live in Abilene', sessionId: 's1' });
  assert.equal(memory.add('I live in Abilene').ok, true);
  assert.deepEqual(memory.list(), ['I live in Abilene']);
  assert.equal(memory.pending().length, 0);
});

test('memory-facts: secret proposal skipped', () => {
  const { memory } = setup();
  assert.deepEqual(memory.propose({ text: 'my api key is sk-123', sessionId: 's1' }), { skipped: 'secret' });
  assert.equal(memory.pending().length, 0);
});

test('memory-facts: caps (pending full; at the active cap the oldest note archives; a profile add returns full)', () => {
  const { memory } = setup({ caps: { active: 3, pending: 2 } });
  memory.propose({ text: 'pending one', sessionId: 's' });
  memory.propose({ text: 'pending two', sessionId: 's' });
  assert.deepEqual(memory.propose({ text: 'pending three', sessionId: 's' }), { skipped: 'full' });
  const p = memory.pending();
  memory.approve(p[0].id); memory.approve(p[1].id);   // two notes (proposals default to note)
  memory.add('profile fact one');
  assert.equal(memory.count(), 3);
  assert.equal(memory.add('profile fact two').ok, true, 'the oldest note made room');
  assert.equal(memory.list().includes('pending one'), false);
  assert.equal(memory.add('profile fact three').ok, true);
  assert.deepEqual(memory.add('profile fact four'), { ok: false, reason: 'full' });
  assert.equal(memory.count(), 3);
});

test('memory-facts: clear keeps tombstones and summaries, drops facts and orphan entities (E3)', () => {
  const { cortex, memory } = setup();
  const src = cortex.source.add({ kind: 'model', ref: 'history/s1.json' });
  const chat = cortex.node.upsert({ kind: 'chat', key: 'chat:s1', text: 'We talked about the dog', source: src }).id;
  memory.add('I like jazz');
  const r = memory.propose({ text: 'Rex is my dog', sessionId: 's1', entities: [{ name: 'Rex', type: 'pet' }] });
  memory.propose({ text: 'Max is my cat', sessionId: 's1', entities: [{ name: 'Max', type: 'pet' }] });
  const max = cortex.node.find({ kind: 'entity', key: 'entity:max' }).id;
  cortex.link(chat, max, 'mentions', { weight: 0.5 });
  const t = memory.propose({ text: 'I hate mondays', sessionId: 's1' });
  memory.reject(t.id);
  memory.approve(r.id);
  assert.equal(memory.clear(), 3);
  assert.equal(memory.count(), 0);
  assert.equal(memory.pending().length, 0);
  assert.equal(memory.stats().rejected, 1);
  assert.equal(cortex.node.find({ kind: 'entity', key: 'entity:rex' }), null);
  assert.ok(cortex.node.find({ kind: 'entity', key: 'entity:max' }), 'still linked from a chat');
  assert.ok(cortex.node.get(chat), 'summaries stay');
});

test('memory-facts: profile is within budget, newest first, with ids', () => {
  const { memory } = setup();
  memory.add('first fact here'); memory.add('second fact here');
  const p = memory.profile({ budget: 500 });
  assert.equal(p.text, 'second fact here; first fact here');
  assert.equal(p.ids.length, 2);
  assert.deepEqual(memory.profile({ budget: 20 }), { text: 'second fact here', ids: [p.ids[0]] });
});

test('memory-facts: profile leaves notes out and puts the most used first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmemf-'));
  const file = path.join(dir, 'cortex.db');
  let cortex = open({ file });
  let memory = createMemory({ cortex });
  memory.add('first fact here'); memory.add('second fact here');
  const note = memory.propose({ text: 'a note fact', tier: 'note', sessionId: 's' }); memory.approve(note.id);
  const first = cortex.node.list({ kind: 'fact' }).find(n => n.text === 'first fact here').id;
  cortex.reinforce([first]);
  cortex.close();   // flushes use counts
  cortex = open({ file });
  memory = createMemory({ cortex });
  const p = memory.profile({ budget: 500 });
  assert.equal(p.text, 'first fact here; second fact here');
  assert.equal(p.ids[0], first);
  cortex.close();
});

test('memory-facts: edit, remove, active listing with query and tier', () => {
  const { memory } = setup();
  memory.add('I like jazz');
  const n = memory.propose({ text: 'Rex is my dog', sessionId: 's' }); memory.approve(n.id);
  assert.equal(memory.active({ tier: 'note' }).length, 1);
  assert.equal(memory.active({ query: 'jazz' })[0].text, 'I like jazz');
  assert.equal(memory.edit(n.id, { tier: 'profile' }).ok, true);
  assert.equal(memory.active({ tier: 'profile' }).length, 2);
  assert.deepEqual(memory.edit(n.id, { text: 'my password is x' }), { ok: false, reason: 'secret' });
  assert.equal(memory.remove(n.id).ok, true);
  assert.deepEqual(memory.list(), ['I like jazz']);
  assert.deepEqual(memory.stats(), { active: 1, pending: 0, rejected: 0, cap: 300 });
});
