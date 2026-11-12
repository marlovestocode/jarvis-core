const test = require('node:test');
const assert = require('node:assert/strict');
const { createMonitors } = require('../src/core/proactive/monitors');
const timersSoon = require('../src/core/proactive/monitors/timers-soon');
const { createSysmonMonitor, createSysmonStats } = require('../src/core/proactive/monitors/sysmon-threshold');

const MIN = 60000;
const tick = () => new Promise(r => setImmediate(r));
function rig({ monitors, cfg, snap = {} }) {
  let t = 1e9; const pushed = [], logs = [], timers = new Map(); let seq = 0, snaps = 0;
  const m = createMonitors({
    engine: { push: i => pushed.push(i) },
    live: { snapshot: () => { snaps++; return typeof snap === 'function' ? snap() : snap; } },
    getConfig: () => ({ proactive: { monitors: cfg } }),
    monitors, now: () => t, log: s => logs.push(s),
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimer: id => timers.delete(id),
  });
  return { m, pushed, logs, timers, snaps: () => snaps, now: () => t };
}
const tcfg = (leadMin = 10) => ({ timersSoon: { enabled: true, leadMin }, sysmon: { enabled: false } });

test('nothing enabled: no snapshot, no pushes', async () => {
  const r = rig({ monitors: [timersSoon], cfg: { timersSoon: { enabled: false }, sysmon: { enabled: false } } });
  await r.m.tick();
  assert.equal(r.snaps(), 0); assert.equal(r.pushed.length, 0);
});

test('timersSoon: announces once, singular/plural, nothing out of window or overdue', async () => {
  let list;
  const r = rig({ monitors: [timersSoon], cfg: tcfg(), snap: () => ({ timers: { upcoming: list } }) });
  list = [{ id: 't1', label: 'pasta', kind: 'timer', due: r.now() + 9 * MIN }];
  await r.m.tick();
  assert.deepEqual(r.pushed, [{ kind: 'timer', text: 'Your pasta timer is in 9 minutes.', key: 'soon:t1', monitor: true }]);
  await r.m.tick(); assert.equal(r.pushed.length, 1);
  r.pushed.length = 0;
  list = [{ id: 't2', label: 'tea', kind: 'timer', due: r.now() + MIN }];
  await r.m.tick(); assert.equal(r.pushed[0].text, 'Your tea timer is in 1 minute.');
  r.pushed.length = 0;
  list = [{ id: 't3', label: 'far', kind: 'timer', due: r.now() + 11 * MIN }, { id: 't4', label: 'late', kind: 'timer', due: r.now() - 3 * MIN }, { id: 't5', kind: 'timer', due: r.now() }];
  await r.m.tick(); assert.equal(r.pushed.length, 0);
});

test('timersSoon: one per tick, created-in-window announced once, unlabeled reminder, told pruned', async () => {
  let list;
  const r = rig({ monitors: [timersSoon], cfg: tcfg(), snap: () => ({ timers: { upcoming: list } }) });
  list = [{ id: 'a', label: 'one', kind: 'timer', due: r.now() + 2 * MIN }, { id: 'b', label: 'two', kind: 'timer', due: r.now() + 5 * MIN }];
  await r.m.tick(); assert.deepEqual(r.pushed.map(p => p.key), ['soon:a']);
  await r.m.tick(); assert.deepEqual(r.pushed.map(p => p.key), ['soon:a', 'soon:b']);
  await r.m.tick(); assert.equal(r.pushed.length, 2);
  r.pushed.length = 0;
  list = [{ id: 'c', label: '', kind: 'reminder', due: r.now() + 5 * MIN }];
  await r.m.tick(); assert.equal(r.pushed[0].text, 'Your reminder is in 5 minutes.'); assert.equal(r.pushed[0].kind, 'reminder');
  await r.m.tick(); assert.equal(r.pushed.length, 1);
  list = []; await r.m.tick();
  list = [{ id: 'c', label: '', kind: 'reminder', due: r.now() + 5 * MIN }];
  await r.m.tick(); assert.equal(r.pushed.length, 2);   // id was pruned once gone
});

function sysRig(statsFn) {
  const logs = [];
  const mon = createSysmonMonitor({ getStats: statsFn, log: s => logs.push(s) });
  const cfg = { sysmon: { enabled: true, cpu: 90, ram: 90, disk: 95, temp: 85 } };
  const state = {};
  return { logs, run: now => mon.check({}, cfg, state, now) };
}
const stats = o => async () => ({ cpu: null, ram: null, disk: null, temp: null, ...o() });

test('sysmon: fires once, then disarmed', async () => {
  const s = sysRig(stats(() => ({ ram: 93 })));
  assert.deepEqual(await s.run(0), { kind: 'info', key: 'sysmon:ram', cooldownMs: 15 * MIN, text: 'RAM is at 93%, over your 90% limit.' });
  assert.equal(await s.run(MIN), null);
  assert.equal(await s.run(20 * MIN), null);
});

test('sysmon: re-armed spike inside cooldown is silent, after cooldown it fires', async () => {
  let ram = 93;
  const s = sysRig(stats(() => ({ ram })));
  assert.ok(await s.run(0));
  ram = 84; assert.equal(await s.run(MIN), null);
  ram = 93; assert.equal(await s.run(2 * MIN), null);
  assert.equal((await s.run(15 * MIN)).key, 'sysmon:ram');   // cooldown over and re-armed
});

test('sysmon: 86 does not re-arm', async () => {
  let ram = 93;
  const s = sysRig(stats(() => ({ ram })));
  assert.ok(await s.run(0));
  ram = 86; await s.run(MIN);
  ram = 93; assert.equal(await s.run(30 * MIN), null);
});

test('sysmon: temperature text, null skipped, larger overage first', async () => {
  const s = sysRig(stats(() => ({ cpu: 95, ram: 99 })));
  assert.equal((await s.run(0)).key, 'sysmon:ram');
  assert.equal((await s.run(MIN)).key, 'sysmon:cpu');
  assert.equal(await s.run(2 * MIN), null);
  const t = sysRig(stats(() => ({ temp: 91 })));
  assert.equal((await t.run(0)).text, 'Temperature is at 91°C, over your 85°C limit.');
  assert.equal(await sysRig(stats(() => ({}))).run(0), null);
});

test('sysmon: failing getStats gives no push and one log per streak', async () => {
  let ok = false;
  const s = sysRig(async () => { if (!ok) throw new Error('down'); return { cpu: null, ram: 10, disk: null, temp: null }; });
  for (let i = 0; i < 3; i++) assert.equal(await s.run(i * MIN), null);
  assert.equal(s.logs.length, 1);
  ok = true; await s.run(4 * MIN); ok = false; await s.run(5 * MIN);
  assert.equal(s.logs.length, 2);
  const n = sysRig(async () => null);
  await n.run(0); await n.run(MIN); assert.equal(n.logs.length, 1);
});

test('createSysmonStats: normalizes, caches 30 s, null on failure', async () => {
  let t = 0, calls = 0;
  const snap = { t: 1, cpu: { load: 41.5, temp: 60 }, gpu: { temp: 72 }, mem: { pct: 63 }, disk: { volumes: [{ pct: 40 }, { pct: 88 }] } };
  const get = createSysmonStats({ fetch: async () => { calls++; return { ok: true, json: async () => snap }; }, now: () => t });
  assert.deepEqual(await get(), { cpu: 41.5, ram: 63, disk: 88, temp: 72 });
  t = 29000; await get(); assert.equal(calls, 1);
  t = 31000; await get(); assert.equal(calls, 2);
  assert.equal(await createSysmonStats({ fetch: async () => ({ ok: false }) })(), null);
  assert.equal(await createSysmonStats({ fetch: async () => { throw new Error('x'); } })(), null);
  assert.equal(await createSysmonStats({ fetch: async () => ({ ok: true, json: async () => ({ cpu: {} }) }) })(), null);
});

test('runner: throwing monitor skipped and logged once, others run', async () => {
  const bad = { id: 'bad', enabled: () => true, check: () => { throw new Error('boom'); } };
  const good = { id: 'good', enabled: () => true, check: () => ({ kind: 'info', text: 'hi', key: 'k' }) };
  const r = rig({ monitors: [bad, good], cfg: {} });
  await r.m.tick(); await r.m.tick();
  assert.equal(r.logs.length, 1);
  assert.equal(r.pushed.length, 2);
  assert.equal(r.pushed[0].monitor, true);
});

test('runner: ticks never overlap', async () => {
  let release, checks = 0;
  const slow = { id: 'slow', enabled: () => true, check: () => { checks++; return new Promise(res => { release = res; }); } };
  const r = rig({ monitors: [slow], cfg: {} });
  const first = r.m.tick(); await tick();
  await r.m.tick();
  release(null); await first;
  assert.equal(checks, 1);
});

test('runner: start re-arms after each tick, stop clears the timer', async () => {
  const quiet = { id: 'q', enabled: () => false, check: () => null };
  const r = rig({ monitors: [quiet], cfg: {} });
  r.m.start(); assert.equal(r.timers.size, 1);
  const [[id, t]] = [...r.timers]; r.timers.delete(id);
  t.fn(); await tick(); await tick();
  assert.equal(r.timers.size, 1);
  assert.equal(r.snaps(), 0);
  r.m.stop(); assert.equal(r.timers.size, 0);
});

test('engine: a monitor item is titled JARVIS, a real timer event keeps Timer done', () => {
  const { createBus } = require('../src/core/bus');
  const { createProactiveEngine } = require('../src/core/proactive/engine');
  const bus = createBus(); const notes = [];
  const engine = createProactiveEngine({
    bus, getConfig: () => ({ proactive: { enabled: false, dnd: true, quietStart: '22:00', quietEnd: '07:00' } }),
    speak: async () => true, chime() {}, notify: (title, body) => notes.push([title, body]), appendHistory() {},
    now: () => 1e9, setTimer: () => 1, clearTimer() {}, isBusy: () => false,
  });
  engine.push({ kind: 'timer', text: 'Your pasta timer is in 9 minutes.', key: 'm1', monitor: true });
  engine.push({ kind: 'timer', text: 'Your pasta timer is done.', key: 't1' });
  assert.deepEqual(notes.map(n => n[0]), ['JARVIS', 'Timer done']);
});
