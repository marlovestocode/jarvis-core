const test = require('node:test');
const assert = require('node:assert/strict');
const { createBus } = require('../src/core/bus');
const { createProactiveEngine } = require('../src/core/proactive/engine');
const { DEFAULTS } = require('../src/core/config');

// 7:30 PM local; quiet hours 22:00-07:00 by default
const at = (h, m = 0) => new Date(2026, 10, 10, h, m).getTime();
const tick = () => new Promise(r => setImmediate(r));

function setup({ time = at(19, 30), cfg = {}, speakOk = true, isBusy } = {}) {
  let t = time;
  const timers = new Map(); let seq = 0;
  const calls = [];
  const bus = createBus();
  const config = { ...DEFAULTS, proactive: { ...DEFAULTS.proactive, ...cfg } };
  const engine = createProactiveEngine({
    bus, getConfig: () => config,
    speak: async text => { calls.push(['speak', text]); return typeof speakOk === 'function' ? speakOk(text) : speakOk; },
    chime: () => calls.push(['chime']),
    notify: (title, body) => calls.push(['notify', title, body]),
    appendHistory: msg => calls.push(['history', msg]),
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: id => timers.delete(id),
    ...(isBusy ? { isBusy } : {}),
  });
  const advance = async ms => {
    const end = t + ms;
    for (;;) {
      await tick();   // let a delivery in flight finish and arm its timer
      const n = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!n || n[1].at > end) break;
      timers.delete(n[0]); t = n[1].at; n[1].fn(); await tick();
    }
    t = end; await tick();
  };
  const spoken = () => calls.filter(c => c[0] === 'speak').map(c => c[1]);
  return { bus, engine, calls, spoken, advance, config };
}
const fire = (bus, o = {}) => bus.emit('timer', { id: 't1', kind: 'timer', label: 'pasta', due: at(19, 30), missed: false, ...o });

test('proactive: a timer is chimed, spoken and notified when idle', async () => {
  const { bus, calls, spoken } = setup();
  fire(bus);
  await tick();
  assert.deepEqual(spoken(), ['Your pasta timer is done.']);
  const kinds = calls.map(c => c[0]);
  assert.ok(kinds.indexOf('chime') < kinds.indexOf('speak'));
  assert.ok(kinds.includes('notify'));
});

test('proactive: wording for an unlabeled alarm, a reminder and an unlabeled timer', async () => {
  const { bus, spoken, advance } = setup();
  fire(bus, { id: 'a', kind: 'alarm', label: '', due: at(7, 0) });
  fire(bus, { id: 'b', kind: 'reminder', label: 'call mum' });
  fire(bus, { id: 'c', kind: 'timer', label: '' });
  await advance(30000);
  assert.deepEqual(spoken(), ["It's 7:00 AM. Your alarm.", 'Your timer is done.', 'Reminder: call mum.']);
});

test('proactive: queued while busy, delivered on idle', async () => {
  const { bus, spoken } = setup();
  bus.emit('state', { state: 'thinking' });
  fire(bus);
  await tick();
  assert.deepEqual(spoken(), []);
  bus.emit('state', { state: 'speaking' });
  await tick();
  assert.deepEqual(spoken(), []);
  bus.emit('state', { state: 'idle' });
  await tick();
  assert.deepEqual(spoken(), ['Your pasta timer is done.']);
});

test('proactive: quiet hours give a notification only (window wraps midnight)', async () => {
  for (const [h, m, quiet] of [[23, 0, true], [6, 59, true], [7, 0, false], [21, 59, false]]) {
    const { bus, calls } = setup({ time: at(h, m) });
    fire(bus);
    await tick();
    const kinds = calls.map(c => c[0]);
    assert.equal(kinds.includes('speak'), !quiet, `${h}:${m}`);
    assert.equal(kinds.includes('chime'), !quiet, `${h}:${m}`);
    assert.ok(kinds.includes('notify'), `${h}:${m}`);
    assert.ok(kinds.includes('history'), `${h}:${m}`);
  }
});

test('proactive: do not disturb gives a notification only', async () => {
  const { bus, calls } = setup({ cfg: { dnd: true } });
  fire(bus);
  await tick();
  assert.deepEqual(calls.map(c => c[0]).sort(), ['history', 'notify']);
});

test('proactive: at most one spoken item per minGapSec', async () => {
  const { bus, spoken, advance } = setup();
  fire(bus, { id: 'a', label: 'pasta' });
  await tick();
  await advance(1000);
  fire(bus, { id: 'b', label: 'tea' });
  await tick();
  assert.deepEqual(spoken(), ['Your pasta timer is done.']);
  await advance(8000);
  assert.equal(spoken().length, 1);
  await advance(1000);
  assert.deepEqual(spoken(), ['Your pasta timer is done.', 'Your tea timer is done.']);
});

test('proactive: priority alarm > timer > reminder when queued together', async () => {
  const { bus, spoken, advance } = setup();
  bus.emit('state', { state: 'listening' });
  fire(bus, { id: 'r', kind: 'reminder', label: 'call mum' });
  fire(bus, { id: 't', kind: 'timer', label: 'tea' });
  fire(bus, { id: 'a', kind: 'alarm', label: 'wake', due: at(19, 30) });
  bus.emit('state', { state: 'idle' });
  await tick();
  await advance(30000);
  assert.deepEqual(spoken(), ["It's 7:30 PM. Your wake alarm.", 'Your tea timer is done.', 'Reminder: call mum.']);
});

test('proactive: duplicates collapse', async () => {
  const { bus, spoken, engine, advance } = setup();
  bus.emit('state', { state: 'thinking' });
  engine.push({ kind: 'info', text: 'Build finished.' });
  engine.push({ kind: 'info', text: 'Build finished.' });
  bus.emit('state', { state: 'idle' });
  await advance(30000);
  assert.deepEqual(spoken(), ['Build finished.']);
});

test('proactive: TTS missing falls back to notification only', async () => {
  const { bus, calls } = setup({ speakOk: false });
  fire(bus);
  await tick();
  const n = calls.filter(c => c[0] === 'notify');
  assert.equal(n.length, 1);
  assert.equal(n[0][2], 'Your pasta timer is done.');
});

test('proactive: speak that throws still notifies and the queue keeps going', async () => {
  const { bus, calls, advance } = setup({ speakOk: () => { throw new Error('no tts'); } });
  fire(bus, { id: 'a' });
  await tick();
  fire(bus, { id: 'b', label: 'tea' });
  await advance(20000);
  assert.equal(calls.filter(c => c[0] === 'notify').length, 2);
});

test('proactive: barge-in (speak resolves false) is not re-queued', async () => {
  const { bus, spoken, advance } = setup({ speakOk: false });
  fire(bus);
  await advance(60000);
  assert.equal(spoken().length, 1);
});

test('proactive: history entries are tagged proactive', async () => {
  const { bus, calls } = setup();
  fire(bus);
  await tick();
  const h = calls.filter(c => c[0] === 'history').map(c => c[1]);
  assert.deepEqual(h, [{ role: 'assistant', content: 'Your pasta timer is done.', proactive: true }]);
});

test('proactive: missed items say they happened while off', async () => {
  const { bus, spoken, advance } = setup();
  fire(bus, { id: 'a', kind: 'alarm', label: '', due: at(7, 0), missed: true });
  fire(bus, { id: 'b', kind: 'timer', label: 'pasta', missed: true });
  fire(bus, { id: 'c', kind: 'reminder', label: 'call mum', missed: true });
  await advance(30000);
  assert.deepEqual(spoken(), ['While I was off, your 7:00 AM alarm went off.', 'While I was off, your pasta timer finished.', 'While I was off, a reminder came due: call mum.']);
});

test('proactive: morning briefing hook pushes the provider text', async () => {
  const { engine, spoken } = setup();
  await engine.briefing.run();
  assert.deepEqual(spoken(), []);
  engine.briefing.set(async () => 'Good morning. Clear skies.');
  await engine.briefing.run();
  await tick();
  assert.deepEqual(spoken(), ['Good morning. Clear skies.']);
});

test('proactive: disabled engine notifies only', async () => {
  const { bus, calls } = setup({ cfg: { enabled: false } });
  fire(bus);
  await tick();
  assert.ok(!calls.some(c => c[0] === 'speak'));
  assert.ok(calls.some(c => c[0] === 'notify'));
});

test('config: proactive defaults and validation', () => {
  const { loadConfig } = require('../src/core/config');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpro-'));
  assert.deepEqual(DEFAULTS.proactive, { enabled: true, dnd: false, quietStart: '22:00', quietEnd: '07:00', minGapSec: 10, chime: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ proactive: { quietStart: '25:00', quietEnd: '6:00', minGapSec: 1, dnd: true } }));
  const c = loadConfig(dir);
  assert.equal(c.proactive.quietStart, '22:00');
  assert.equal(c.proactive.quietEnd, '07:00');
  assert.equal(c.proactive.minGapSec, 3);
  assert.equal(c.proactive.dnd, true);
});

test('settings: proactive patch is validated', () => {
  const { applyPatch } = require('../src/core/settings');
  const { loadConfig } = require('../src/core/config');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const cur = loadConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'jpro-')));
  const deps = { providers: { get: () => null }, engines: {} };
  let r = applyPatch(cur, { proactive: { dnd: true, quietStart: '23:30', quietEnd: '06:15', minGapSec: 500 } }, deps);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.config.proactive, { ...cur.proactive, dnd: true, quietStart: '23:30', quietEnd: '06:15', minGapSec: 120 });
  assert.equal(cur.proactive.dnd, false);
  r = applyPatch(cur, { proactive: { quietStart: 'late' } }, deps);
  assert.equal(r.errors.length, 1);
  assert.equal(r.config.proactive.quietStart, '22:00');
});

const MIN = 60000;

test('monitor item: same key within cooldown is dropped, spoken again after cooldown', async () => {
  const { engine, spoken, advance } = setup();
  engine.push({ text: 'CPU is high.', key: 'k', monitor: true });
  await advance(5 * MIN);
  engine.push({ text: 'CPU is high.', key: 'k', monitor: true });
  await advance(1000);
  assert.equal(spoken().length, 1);
  await advance(11 * MIN);
  engine.push({ text: 'CPU is high.', key: 'k', monitor: true });
  await advance(1000);
  assert.equal(spoken().length, 2);
});

test('monitor item: cooldownMs on the item overrides config', async () => {
  const { engine, spoken, advance } = setup();
  engine.push({ text: 'Disk is full.', key: 'k', monitor: true, cooldownMs: 60000 });
  await advance(2 * MIN);
  engine.push({ text: 'Disk is full.', key: 'k', monitor: true, cooldownMs: 60000 });
  await advance(1000);
  assert.equal(spoken().length, 2);
});

test('non-monitor items ignore cooldown and cap', async () => {
  const { bus, spoken, advance } = setup({ cfg: { maxPerHour: 2 } });
  for (let i = 0; i < 8; i++) { fire(bus, { id: `t${i}` }); await advance(11000); }
  assert.equal(spoken().length, 8);
});

test('hourly cap: items over maxPerHour are notification only, history still recorded', async () => {
  const { engine, calls, spoken, advance } = setup({ cfg: { maxPerHour: 2 } });
  for (const k of ['a', 'b', 'c']) { engine.push({ text: `item ${k}`, key: k, monitor: true }); await advance(11000); }
  assert.deepEqual(spoken(), ['item a', 'item b']);
  assert.ok(calls.some(c => c[0] === 'notify' && c[2] === 'item c'));
  assert.ok(calls.some(c => c[0] === 'history' && c[1].content === 'item c' && c[1].proactive === true));
  await advance(61 * MIN);
  engine.push({ text: 'item d', key: 'd', monitor: true });
  await advance(1000);
  assert.deepEqual(spoken(), ['item a', 'item b', 'item d']);
});

test('isBusy true holds speech, delivered once it turns false', async () => {
  let busy = true;
  const { bus, spoken, advance } = setup({ isBusy: () => busy });
  fire(bus);
  await advance(1000);
  assert.deepEqual(spoken(), []);
  busy = false;
  await advance(3000);
  assert.deepEqual(spoken(), ['Your pasta timer is done.']);
});

test('isBusy throwing counts as not busy', async () => {
  const { bus, spoken, advance } = setup({ isBusy: () => { throw new Error('boom'); } });
  fire(bus);
  await advance(1000);
  assert.deepEqual(spoken(), ['Your pasta timer is done.']);
});

test('hourly cap holds for items queued while busy', async () => {
  let busy = true;
  const { engine, calls, spoken, advance } = setup({ cfg: { maxPerHour: 2 }, isBusy: () => busy });
  for (const k of ['a', 'b', 'c', 'd']) engine.push({ text: `item ${k}`, key: k, monitor: true });
  await advance(1000);
  busy = false;
  await advance(60000);
  assert.deepEqual(spoken(), ['item a', 'item b']);
  for (const k of ['c', 'd']) {
    assert.equal(calls.filter(c => c[0] === 'notify' && c[2] === `item ${k}`).length, 1);
    assert.equal(calls.filter(c => c[0] === 'history' && c[1].content === `item ${k}`).length, 1);
  }
});
