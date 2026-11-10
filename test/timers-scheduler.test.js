const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTimerStore } = require('../src/core/timers/store');
const { createScheduler } = require('../src/core/timers/scheduler');
const { createBus } = require('../src/core/bus');

// fake clock: one list of handles; advance() runs what is due, in time order
function fakeClock(start = 1_800_000_000_000) {
  let t = start, seq = 0;
  const live = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) { const id = ++seq; live.set(id, { fn, at: t + ms, ms }); return id; },
    clearTimer(id) { live.delete(id); },
    live,
    skip(ms) { t += ms; },   // time passes with no callbacks (PC asleep)
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...live.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        live.delete(next[0]); t = next[1].at; next[1].fn();
      }
      t = end;
    },
  };
}
const setup = (clock = fakeClock(), file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jsch-')), 'timers.json')) => {
  const bus = createBus();
  const fired = [];
  bus.on('timer', e => fired.push(e));
  const store = createTimerStore({ file });
  const s = createScheduler({ store, bus, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { clock, bus, fired, store, s, file };
};

test('scheduler: fires at due and emits a timer event', () => {
  const { clock, fired, s, store } = setup();
  s.start();
  const t = s.add({ kind: 'timer', label: 'pasta', due: clock.now() + 600e3 });
  clock.advance(599e3);
  assert.equal(fired.length, 0);
  clock.advance(1e3);
  assert.equal(fired.length, 1);
  assert.deepEqual({ ...fired[0], t: 0 }, { type: 'timer', t: 0, id: t.id, label: 'pasta', kind: 'timer', due: t.due, missed: false });
  assert.deepEqual(store.list(), []);
});

test('scheduler: one timeout at a time, re-armed on add and cancel', () => {
  const { clock, s } = setup();
  s.start();
  s.add({ kind: 'timer', label: 'late', due: clock.now() + 900e3 });
  assert.equal(clock.live.size, 1);
  const early = s.add({ kind: 'timer', label: 'early', due: clock.now() + 60e3 });
  assert.equal(clock.live.size, 1);
  assert.equal([...clock.live.values()][0].ms, 60e3);
  s.cancel({ id: early.id });
  assert.equal(clock.live.size, 1);
  assert.equal([...clock.live.values()][0].ms, 900e3);
  s.cancel({ all: true });
  assert.equal(clock.live.size, 0);
});

test('scheduler: overdue on boot fires once with missed, the rest are re-armed', () => {
  const clock = fakeClock();
  const first = setup(clock);
  first.s.start();
  first.s.add({ kind: 'alarm', label: 'wake', due: clock.now() + 60e3 });
  first.s.add({ kind: 'reminder', label: 'call mum', due: clock.now() + 7200e3 });
  first.s.stop();
  clock.advance(3600e3);   // app was closed for an hour
  const second = setup(clock, first.file);
  const r = second.s.start();
  assert.deepEqual(r, { fired: 1, armed: 1 });
  assert.equal(second.fired.length, 1);
  assert.equal(second.fired[0].label, 'wake');
  assert.equal(second.fired[0].missed, true);
  second.s.stop();
  const third = setup(clock, first.file);   // second restart: nothing fires twice
  assert.deepEqual(third.s.start(), { fired: 0, armed: 1 });
  assert.equal(third.fired.length, 0);
  clock.advance(3600e3);
  assert.equal(third.fired[0].label, 'call mum');
  assert.equal(third.fired[0].missed, false);
});

test('scheduler: cancel by label ignores case, all, and unknown', () => {
  const { clock, s } = setup();
  s.start();
  s.add({ kind: 'timer', label: 'pasta', due: clock.now() + 60e3 });
  s.add({ kind: 'timer', label: 'tea', due: clock.now() + 120e3 });
  s.add({ kind: 'alarm', label: '', due: clock.now() + 180e3 });
  assert.deepEqual(s.cancel({ label: 'Pasta' }).map(t => t.label), ['pasta']);
  assert.deepEqual(s.cancel({ label: 'the tea timer' }).map(t => t.label), ['tea']);
  assert.deepEqual(s.cancel({ label: 'soup' }), []);
  assert.equal(s.cancel({ all: true }).length, 1);
  assert.deepEqual(s.list(), []);
});

test('scheduler: delays above the setTimeout limit are chunked, not fired early', () => {
  const { clock, fired, s } = setup();
  s.start();
  s.add({ kind: 'alarm', label: 'far', due: clock.now() + 30 * 864e5 });
  assert.ok([...clock.live.values()][0].ms <= 2 ** 31 - 1);
  clock.advance(2 ** 31 - 1);
  assert.equal(fired.length, 0);
  clock.advance(30 * 864e5);
  assert.equal(fired.length, 1);
});

test('scheduler: due is absolute epoch ms; firing compares now() >= due', () => {
  const { clock, fired, s } = setup();
  s.start();
  const due = clock.now() + 5e3;
  s.add({ kind: 'timer', label: 'x', due });
  assert.equal(s.list()[0].due, due);
  clock.advance(5e3);
  assert.equal(fired[0].due, due);
});

test('review #4: firing long after due (PC was asleep) counts as missed', () => {
  const { clock, fired, s } = setup();
  s.start();
  s.add({ kind: 'alarm', label: '', due: clock.now() + 60e3 });
  const h = [...clock.live.values()][0];
  clock.live.clear();
  // the PC slept: the timer callback runs 8 hours late
  clock.skip(8 * 3600e3);
  h.fn();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].missed, true);
});
