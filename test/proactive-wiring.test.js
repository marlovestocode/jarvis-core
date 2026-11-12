const test = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { createLiveState } = require('../src/core/livestate');
const { timersSource } = require('../src/core/livestate/sources');
const { createProactiveEngine } = require('../src/core/proactive/engine');
const { createMonitors } = require('../src/core/proactive/monitors');
const timersSoon = require('../src/core/proactive/monitors/timers-soon');
const { DEFAULTS } = require('../src/core/config');

// 7:30 PM local, outside quiet hours (22:00-07:00)
const T0 = new Date(2026, 10, 10, 19, 30).getTime();
const MIN = 60000;
const tick = () => new Promise(r => setImmediate(r));

// Note: the bus delivers typed subscribers before '*', so on 'state idle' the engine pumps before live state
// has recorded idle; isBusy still reads the old voice state and the engine's 2 s retry does the delivery.
// the same wiring main.js does: real bus, live state, engine (with main's isBusy) and monitor runner
function setup({ pcfg = {} } = {}) {
  let t = T0;
  const timers = new Map(); let seq = 0;
  const calls = [];
  const bus = createBus();
  const config = { ...DEFAULTS, proactive: { ...DEFAULTS.proactive, ...pcfg, monitors: { ...DEFAULTS.proactive.monitors, timersSoon: { enabled: true, leadMin: 10 }, sysmon: { enabled: false } } } };
  const list = [{ id: 't1', label: 'pasta', kind: 'timer', due: T0 + 9 * MIN }];
  const live = createLiveState({ bus, now: () => t });
  live.register('timers', timersSource({ list: () => list, now: () => t }));
  const isBusy = () => { const s = live.snapshot(); return !!s.confirm || ['listening', 'thinking', 'speaking'].includes(s.voice); };
  const setTimer = (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id; };
  const clearTimer = id => timers.delete(id);
  const engine = createProactiveEngine({
    bus, getConfig: () => config,
    speak: async text => { calls.push(['speak', text]); return true; },
    chime: () => calls.push(['chime']),
    notify: (title, body) => calls.push(['notify', title, body]),
    appendHistory: msg => calls.push(['history', msg]),
    now: () => t, setTimer, clearTimer, isBusy,
  });
  const monitors = createMonitors({ engine, live, getConfig: () => config, monitors: [timersSoon], now: () => t, setTimer, clearTimer });
  const advance = async ms => {
    const end = t + ms;
    for (;;) {
      await tick();
      const n = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!n || n[1].at > end) break;
      timers.delete(n[0]); t = n[1].at; n[1].fn(); await tick();
    }
    t = end; await tick();
  };
  const spoken = () => calls.filter(c => c[0] === 'speak').map(c => c[1]);
  const of = k => calls.filter(c => c[0] === k);
  return { bus, live, monitors, calls, spoken, of, advance };
}
const LINE = 'Your pasta timer is in 9 minutes.';

test('wiring: monitor line is held while speaking, spoken once on idle', async () => {
  const s = setup();
  s.bus.emit('state', { state: 'speaking' });
  await s.monitors.tick(); await tick();
  assert.deepEqual(s.spoken(), []);
  s.bus.emit('state', { state: 'idle' });
  await s.advance(2500);   // live state hears 'idle' after the engine does (see the note above setup), so the 2 s retry delivers it
  assert.deepEqual(s.spoken(), [LINE]);
});

test('wiring: listening and thinking hold the line too', async () => {
  for (const v of ['listening', 'thinking']) {
    const s = setup();
    s.bus.emit('state', { state: v });
    await s.monitors.tick(); await tick();
    assert.deepEqual(s.spoken(), [], v);
    s.bus.emit('state', { state: 'idle' });
    await s.advance(2500);
    assert.deepEqual(s.spoken(), [LINE], v);
  }
});

test('wiring: a pending confirm holds the line until it clears and the 2 s retry fires', async () => {
  const s = setup();
  let pending = { summary: 'x' };
  s.live.register('confirm', () => pending);
  await s.monitors.tick(); await tick();
  assert.deepEqual(s.spoken(), []);
  await s.advance(10000);
  assert.deepEqual(s.spoken(), []);          // still held while the confirm is up
  pending = null;
  await s.advance(2500);
  assert.deepEqual(s.spoken(), [LINE]);
});

test('wiring: the monitor line is spoken once, not on later ticks', async () => {
  const s = setup();
  await s.monitors.tick(); await tick();
  await s.monitors.tick(); await s.monitors.tick(); await s.advance(60000);
  await s.monitors.tick(); await s.advance(60000);
  assert.deepEqual(s.spoken(), [LINE]);
  assert.equal(s.of('history').length, 1);
});

test('wiring: proactive.enabled false gives notification and history only', async () => {
  const s = setup({ pcfg: { enabled: false } });
  await s.monitors.tick(); await tick();
  assert.deepEqual(s.spoken(), []);
  assert.equal(s.of('chime').length, 0);
  assert.equal(s.of('notify').length, 1);
  assert.equal(s.of('history').length, 1);
});

test('wiring: dnd gives notification and history only', async () => {
  const s = setup({ pcfg: { dnd: true } });
  await s.monitors.tick(); await tick();
  assert.deepEqual(s.spoken(), []);
  assert.equal(s.of('chime').length, 0);
  assert.equal(s.of('notify').length, 1);
  assert.equal(s.of('history').length, 1);
});
