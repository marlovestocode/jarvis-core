const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/core/cortex');
const { createCortexTimerStore } = require('../src/core/timers/cortex-store');
const { entityKey } = require('../src/core/memory/facts');
const { aboutText } = require('../src/core/tools/memory');

const T0 = Date.UTC(2027, 2, 1, 9, 0);
function setup(names = ['Rex']) {
  const cortex = open({ now: () => T0 });
  const src = cortex.source.add({ kind: 'user', ref: 'chat-1' });
  const ents = Object.fromEntries(names.map(n => [n, cortex.node.upsert({ kind: 'entity', key: entityKey(n), text: n, source: src }).id]));
  const store = createCortexTimerStore({ cortex, now: () => T0 });
  return { cortex, store, ents };
}
const node = (cortex, t) => cortex.node.find({ kind: 'reminder', key: 'reminder:' + t.id });

test('timer links: a reminder naming a known entity is linked about it', () => {
  const { cortex, store, ents } = setup();
  const t = store.add({ kind: 'reminder', label: 'Take Rex to the vet', due: T0 + 11 * 864e5, created: T0 });
  assert.ok(cortex.neighbors(node(cortex, t).id, { types: ['about'] }).some(n => n.id === ents.Rex));
});

test('timer links: the match is on whole words, case-insensitive', () => {
  const { cortex, store, ents } = setup(['Rex', 'Anna Lee']);
  const a = store.add({ kind: 'reminder', label: 'call rexford about the car', due: T0 + 1e6, created: T0 });
  assert.equal(cortex.neighbors(node(cortex, a).id, { types: ['about'] }).length, 0);
  const b = store.add({ kind: 'reminder', label: "ANNA LEE's birthday gift", due: T0 + 1e6, created: T0 });
  assert.deepEqual(cortex.neighbors(node(cortex, b).id, { types: ['about'] }).map(n => n.id), [ents['Anna Lee']]);
});

test('timer links: memory_about lists the reminder for the entity', async () => {
  const { cortex, store } = setup();
  store.add({ kind: 'reminder', label: 'Take Rex to the vet', due: T0 + 11 * 864e5, created: T0 });
  assert.match(await aboutText(cortex, 'Rex'), /Reminders: Take Rex to the vet/);
});

test('timer links: no entities → no links and no error', () => {
  const { cortex, store } = setup([]);
  const t = store.add({ kind: 'alarm', label: 'wake up', due: T0 + 1e6, created: T0 });
  assert.equal(cortex.neighbors(node(cortex, t).id).length, 0);
});
