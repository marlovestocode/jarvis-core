const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseRepeat, nextDue, sayRepeat } = require('../src/core/timers/recur');
const { createTimerStore } = require('../src/core/timers/store');
const { createScheduler } = require('../src/core/timers/scheduler');
const { createTimerTools } = require('../src/core/tools/timers');
const { createBus } = require('../src/core/bus');

const at = (y, mo, d, h, m = 0) => new Date(y, mo - 1, d, h, m).getTime();
// 2026-11-14 is a Saturday; 2026-11-16 is a Monday

test('recur: weekday words give Monday to Friday at the clock time', () => {
  const rep = parseRepeat('weekdays', at(2026, 11, 14, 8));
  assert.deepEqual(rep, { kind: 'weekly', days: [1, 2, 3, 4, 5], at: '08:00' });
  assert.equal(nextDue(rep, at(2026, 11, 14, 9)), at(2026, 11, 16, 8), 'Saturday 9:00 → Monday 8:00');
  assert.equal(nextDue(rep, at(2026, 11, 16, 7)), at(2026, 11, 16, 8), 'Monday 7:00 → Monday 8:00');
  assert.equal(nextDue(rep, at(2026, 11, 16, 8)), at(2026, 11, 17, 8), 'strictly after: Monday 8:00 → Tuesday 8:00');
  assert.equal(sayRepeat(rep), 'every weekday at 8:00 AM');
});

test('recur: named days, daily, weekly and monthly; nonsense is not a repeat', () => {
  const t = at(2026, 11, 14, 18, 30);   // Saturday
  assert.deepEqual(parseRepeat('monday and thursday', t).days, [1, 4]);
  assert.deepEqual(parseRepeat('every friday', t).days, [5]);
  assert.equal(parseRepeat('daily', t).kind, 'daily');
  assert.deepEqual(parseRepeat('weekly', t).days, [6]);
  assert.equal(parseRepeat('monthly', t).dom, 14);
  assert.equal(parseRepeat('whenever', t), null);
  assert.equal(nextDue(parseRepeat('monthly', at(2026, 1, 31, 9)), at(2026, 2, 1, 0)), at(2026, 3, 31, 9), 'a month without the 31st is skipped');
});

test('scheduler: a repeating reminder is put back for its next occurrence when it fires', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-'));
  const store = createTimerStore({ file: path.join(dir, 't.json') });
  let t = at(2026, 11, 16, 7, 59);
  const bus = createBus(), fired = [];
  bus.on('timer', e => fired.push(e));
  const s = createScheduler({ store, bus, now: () => t, setTimer: () => 1, clearTimer: () => {} });
  const rep = parseRepeat('weekdays', at(2026, 11, 16, 8));
  s.add({ kind: 'reminder', label: 'stand up', due: at(2026, 11, 16, 8), repeat: rep });
  s.start();
  t = at(2026, 11, 16, 8, 0);
  const n = (() => { const before = fired.length; s.start(); return fired.length - before; })();
  assert.equal(n, 1);
  const left = s.list();
  assert.equal(left.length, 1, 'the next occurrence is stored');
  assert.equal(left[0].due, at(2026, 11, 17, 8));
  assert.deepEqual(left[0].repeat, rep);
});

test('scheduler: a repeat missed while the app was closed fires once, then waits for the next future occurrence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-'));
  const file = path.join(dir, 't.json');
  let t = at(2026, 11, 16, 7, 0);
  const rep = parseRepeat('daily', at(2026, 11, 16, 8));
  createScheduler({ store: createTimerStore({ file }), bus: createBus(), now: () => t, setTimer: () => 1, clearTimer: () => {} })
    .add({ kind: 'alarm', label: '', due: at(2026, 11, 16, 8), repeat: rep });
  t = at(2026, 11, 19, 12, 0);   // three days later
  const bus = createBus(), fired = [];
  bus.on('timer', e => fired.push(e));
  const store = createTimerStore({ file });   // a restart: the repeat survives on disk
  const s = createScheduler({ store, bus, now: () => t, setTimer: () => 1, clearTimer: () => {} });
  assert.equal(s.start().fired, 1);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].missed, true);
  assert.equal(s.list()[0].due, at(2026, 11, 20, 8), 'next occurrence, not three catch-ups');
});

test('timer tools: set_reminder with repeat stores it, lists it, and cancel stops it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jr-'));
  const t = at(2026, 11, 14, 12, 0);   // Saturday noon
  const scheduler = createScheduler({ store: createTimerStore({ file: path.join(dir, 't.json') }), bus: createBus(), now: () => t, setTimer: () => 1, clearTimer: () => {} });
  const tools = Object.fromEntries(createTimerTools({ scheduler, now: () => t }).map(x => [x.name, x]));
  const r = await tools.set_reminder.run({ text: 'stand up', at: '8am', repeat: 'weekdays' });
  assert.match(r, /every weekday at 8:00 AM, next at 8:00 AM on Monday/);
  assert.match(await tools.list_timers.run(), /repeats every weekday at 8:00 AM/);
  await assert.rejects(tools.set_reminder.run({ text: 'x', at: '8am', repeat: 'whenever' }), /Could not read "whenever" as a repeat/);
  await tools.cancel_timer.run({ label: 'stand up' });
  assert.equal(scheduler.list().length, 0, 'cancelling removes the repeat too');
});
