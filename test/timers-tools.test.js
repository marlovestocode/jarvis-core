const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTimerStore } = require('../src/core/timers/store');
const { createScheduler } = require('../src/core/timers/scheduler');
const { createTimerTools } = require('../src/core/tools/timers');
const { createToolRunner } = require('../src/core/tools/registry');
const { createBus } = require('../src/core/bus');

const NOW = new Date(2026, 10, 10, 19, 30).getTime();
function setup() {
  let t = NOW;
  const now = () => t;
  const store = createTimerStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jtt-')), 'timers.json') });
  const scheduler = createScheduler({ store, bus: createBus(), now, setTimer: () => 1, clearTimer: () => {} });
  scheduler.start();
  const tools = createTimerTools({ scheduler, now });
  const by = Object.fromEntries(tools.map(x => [x.name, x]));
  return { tools, by, scheduler, store, tick: ms => { t += ms; } };
}

test('timer tools: set_timer from duration text, persisted', async () => {
  const { by, store } = setup();
  assert.equal(await by.set_timer.run({ duration_text: 'ten minutes' }), 'Timer set for 10 minutes, done at 7:40 PM.');
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].due, NOW + 600e3);
  assert.equal(await by.set_timer.run({ seconds: 90, label: 'Eggs' }), 'Eggs timer set for 1 minute 30 seconds, done at 7:31 PM.');
});

test('timer tools: set_timer needs a usable length', async () => {
  const { by } = setup();
  await assert.rejects(by.set_timer.run({}), /How long/);
  await assert.rejects(by.set_timer.run({ duration_text: 'banana' }), /Could not read "banana" as a length/);
  await assert.rejects(by.set_timer.run({ seconds: -5 }), /How long/);
});

test('timer tools: set_alarm "at 7" in the evening states the resolved time', async () => {
  const { by, store } = setup();
  const r = await by.set_alarm.run({ at: 'at 7' });
  assert.match(r, /7:00 AM tomorrow/);
  assert.equal(store.list()[0].kind, 'alarm');
  assert.equal(store.list()[0].due, new Date(2026, 10, 11, 7, 0).getTime());
  await assert.rejects(by.set_alarm.run({ at: 'banana' }), /Could not read "banana" as a time/);
});

test('timer tools: set_reminder needs when; accepts at or in', async () => {
  const { by, store } = setup();
  await assert.rejects(by.set_reminder.run({ text: 'call mum' }), /When should I remind you\?/);
  assert.equal(await by.set_reminder.run({ text: 'call mum', in: '20 minutes' }), 'I will remind you to call mum at 7:50 PM today.');
  assert.equal(await by.set_reminder.run({ text: 'Take the bins out', at: 'tomorrow at 8 am' }), 'I will remind you to take the bins out at 8:00 AM tomorrow.');
  assert.deepEqual(store.list().map(t => [t.kind, t.label]), [['reminder', 'call mum'], ['reminder', 'Take the bins out']]);
});

test('timer tools: list_timers', async () => {
  const { by, tick } = setup();
  assert.equal(await by.list_timers.run({}), 'No timers set.');
  await by.set_timer.run({ duration_text: '10 minutes', label: 'pasta' });
  await by.set_alarm.run({ at: '7:30 am' });
  tick(60e3);
  assert.equal(await by.list_timers.run({}), 'Pasta timer: 9 minutes left, at 7:40 PM today.\nAlarm: at 7:30 AM tomorrow.');
});

test('timer tools: cancel_timer by label, all, nothing', async () => {
  const { by, store } = setup();
  await by.set_timer.run({ duration_text: '10 minutes', label: 'pasta' });
  await by.set_timer.run({ duration_text: '5 minutes', label: 'tea' });
  await by.set_alarm.run({ at: '7 am' });
  assert.equal(await by.cancel_timer.run({ label: 'pasta' }), 'Cancelled the pasta timer.');
  await assert.rejects(by.cancel_timer.run({ label: 'soup' }), /No timer matches "soup"/);
  await assert.rejects(by.cancel_timer.run({}), /Which timer/);
  assert.equal(await by.cancel_timer.run({ all: true }), 'Cancelled 2 timers.');
  assert.deepEqual(store.list(), []);
});

test('timer tools: strict schemas and aliases resolve', async () => {
  const { tools } = setup();
  assert.deepEqual(tools.map(t => t.name), ['set_timer', 'set_alarm', 'set_reminder', 'list_timers', 'cancel_timer']);
  for (const t of tools) {
    assert.equal(t.params.additionalProperties, false, t.name);
    assert.ok(t.description.length < 200, t.name);
  }
  const runner = createToolRunner(tools);
  for (const [alias, real] of [['start_timer', 'set_timer'], ['remind_me', 'set_reminder'], ['get_timers', 'list_timers'], ['stop_timer', 'cancel_timer'], ['cancel_alarm', 'cancel_timer'], ['create_alarm', 'set_alarm']]) {
    const r = await runner.run(alias, real === 'list_timers' ? {} : { all: true });
    assert.doesNotMatch(r.text, /unknown tool/, alias);
  }
});

test('timer tools: defaultTools offers them when a scheduler is given', () => {
  const { defaultTools } = require('../src/core/brain');
  const { scheduler } = setup();
  const names = defaultTools({ scheduler }).map(t => t.name);
  for (const n of ['set_timer', 'set_alarm', 'set_reminder', 'list_timers', 'cancel_timer']) assert.ok(names.includes(n), n);
  assert.ok(!defaultTools({}).some(t => t.name === 'set_timer'));
});
