// Parity (cortex wave 3 §6, plan E13): the existing scheduler and timer-tool tests run, unchanged, against the
// cortex-backed timer store. createTimerStore is swapped in the require cache for a factory that opens one cortex per
// data folder (so a "restart" on the same folder sees the same store), then the two test files are loaded as they are.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open } = require('../src/core/cortex');
const storeModule = require('../src/core/timers/store');
const { createCortexTimerStore } = require('../src/core/timers/cortex-store');
const { createScheduler } = require('../src/core/timers/scheduler');
const { createTimerTools } = require('../src/core/tools/timers');
const { createBus } = require('../src/core/bus');

const dbs = new Map();
storeModule.createTimerStore = ({ file, log }) => {
  const dir = path.dirname(file);
  if (!dbs.has(dir)) dbs.set(dir, open({}));
  return createCortexTimerStore({ cortex: dbs.get(dir), log });
};
require('./timers-scheduler.test.js');
require('./timers-tools.test.js');

// ---- the cortex store's own cases ----
const T0 = Date.UTC(2026, 10, 11, 9, 0);
const item = (o = {}) => ({ kind: 'reminder', label: 'take the bins out', due: T0 + 3600e3, created: T0, ...o });
function setup() {
  let t = T0;
  const clock = { now: () => t, skip: ms => { t += ms; } };
  const cortex = open({ now: clock.now });
  return { cortex, clock, store: () => createCortexTimerStore({ cortex, now: clock.now }) };
}

test('cortex timer store: a new store on the same cortex lists the timer (restart)', () => {
  const { store } = setup();
  const s = store();
  const t = s.add(item());
  assert.match(t.id, /^t/);
  assert.deepEqual(store().list(), [t]);
  assert.deepEqual(store().get(t.id), t);
});

test('cortex timer store: the reminder is a node with the label, the type, the time as ISO and state pending', () => {
  const { cortex, store } = setup();
  const t = store().add(item());
  const n = cortex.node.find({ kind: 'reminder', key: 'reminder:' + t.id });
  assert.equal(n.text, 'take the bins out');
  assert.equal(n.status, 'active');
  assert.deepEqual(n.data, { type: 'reminder', label: 'take the bins out', at: new Date(T0 + 3600e3).toISOString(), created: new Date(T0).toISOString(), state: 'pending' });
  assert.equal(n.sources[0].kind, 'user');
});

test('cortex timer store: fired → archived with state fired and a reminder_fired event; a later boot does not fire it again', () => {
  const { cortex, clock, store } = setup();
  const s = store();
  const t = s.add(item());
  clock.skip(3 * 3600e3);   // the app was off past the due time
  const bus = createBus();
  const fired = [];
  bus.on('timer', e => fired.push(e));
  const sch = createScheduler({ store: store(), bus, now: clock.now, setTimer: () => 1, clearTimer: () => {} });
  assert.deepEqual(sch.start(), { fired: 1, armed: 0 });
  assert.equal(fired[0].missed, true);
  const n = cortex.node.find({ kind: 'reminder', key: 'reminder:' + t.id });
  assert.equal(n.status, 'archived');
  assert.equal(n.data.state, 'fired');
  assert.equal(n.data.firedAt, new Date(clock.now()).toISOString());
  const ev = cortex.event.query({ kind: 'reminder_fired' });
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].payload, { timerId: t.id, late: true });
  const again = createScheduler({ store: store(), bus, now: clock.now, setTimer: () => 1, clearTimer: () => {} });
  assert.deepEqual(again.start(), { fired: 0, armed: 0 });
  assert.equal(fired.length, 1);
});

test('cortex timer store: cancel → archived with state cancelled, no event; removing twice is false', () => {
  const { cortex, store } = setup();
  const s = store();
  const t = s.add(item());
  assert.equal(s.remove(t.id), true);
  assert.equal(s.remove(t.id), false);
  assert.equal(cortex.node.find({ kind: 'reminder', key: 'reminder:' + t.id }).data.state, 'cancelled');
  assert.equal(cortex.event.count({ kind: 'reminder_fired' }), 0);
  assert.deepEqual(store().list(), []);
});

test('cortex timer store: an in-memory fallback cortex cannot hold a timer, so add says it could not save', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jcts-'));
  fs.writeFileSync(path.join(dir, 'blocked'), 'a file, not a folder');
  const cortex = open({ file: path.join(dir, 'blocked', 'cortex.db') });
  assert.equal(cortex.health().ok, false);
  const s = createCortexTimerStore({ cortex });
  assert.throws(() => s.add(item()), /could not save the timer/i);
  assert.deepEqual(s.list(), []);
});

test('cortex timer store: a label the secret guard refuses is not set, and set_reminder says why', async () => {
  const { store, clock } = setup();
  const s = store();
  assert.throws(() => s.add(item({ label: 'change my password' })), /could not save the timer: its label looks like a password/i);
  assert.deepEqual(s.list(), []);
  let armed = 0;
  const sch = createScheduler({ store: s, bus: createBus(), now: clock.now, setTimer: () => { armed++; return 1; }, clearTimer: () => {} });
  sch.start();
  const [, , setReminder] = createTimerTools({ scheduler: sch, now: clock.now });
  await assert.rejects(setReminder.run({ text: 'change my password', in: '1 hour' }), /could not save the timer/i);
  assert.equal(armed, 0);
  assert.deepEqual(sch.list(), []);
});

test('cortex timer store: an empty label is stored with the kind word as text and comes back empty', () => {
  const { cortex, store } = setup();
  const t = store().add(item({ kind: 'timer', label: '' }));
  assert.equal(t.label, '');
  assert.equal(cortex.node.find({ kind: 'reminder', key: 'reminder:' + t.id }).text, 'timer');
  assert.equal(store().get(t.id).label, '');
});
