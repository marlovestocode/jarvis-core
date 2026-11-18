'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { takeSnapshot, undoSnapshot } = require('../src/core/routines/snapshot');

function fakes(over = {}) {
  const log = [];
  const state = { vol: 0.2, focus: false, out: { id: 'hp', name: 'Headphones' }, bright: 60, plan: 'p1', night: false, bt: true };
  const host = {
    async audioDevices() { log.push('read output'); return [{ id: state.out.id, name: state.out.name, default: true }]; },
    async audioSetDefault(id) { log.push(`set output ${id}`); return true; },
    async brightness() { log.push('read brightness'); return state.bright; },
    async setBrightness(n) { log.push(`set brightness ${n}`); },
    async powerPlans() { log.push('read plan'); return [{ id: state.plan, name: 'Balanced', active: true }]; },
    async setPowerPlan(id) { log.push(`set plan ${id}`); return true; },
    async focusAssist(on) { if (on === undefined) { log.push('read focus'); return state.focus; } log.push(`set focus ${on}`); return on; },
    async nightLight(on) { if (on === undefined) { log.push('read night'); return state.night; } log.push(`set night ${on}`); return on; },
    async bluetooth() { log.push('read bt'); return { enabled: state.bt, devices: [] }; },
    async setBluetooth(on) { log.push(`set bt ${on}`); return true; },
    ...over.host,
  };
  const media = {
    async state() { log.push('read volume'); return { system: { volume: state.vol } }; },
    async act(a) { log.push(`set volume ${Math.round(a.set * 100)}`); return { ok: true }; },
    ...over.media,
  };
  const openApp = over.openApp || (async name => { log.push(`open ${name}`); return `Opened ${name}.`; });
  const isOpen = over.isOpen || (async () => true);
  return { host, media, openApp, isOpen, log, state };
}
const steps = (...t) => t.map(([tool, args]) => ({ tool, args: args || {} }));

test('snapshot reads only the state the steps touch', async () => {
  const f = fakes();
  const snap = await takeSnapshot({ host: f.host, media: f.media, isOpen: f.isOpen, steps: steps(['focus_assist', { on: true }], ['set_system_volume', { percent: 40 }]), now: () => 100 });
  assert.deepEqual(f.log.sort(), ['read focus', 'read volume']);
  assert.equal(snap.focus, false);
  assert.equal(snap.volume, 20);
  assert.equal(snap.at, 100);
  assert.equal('output' in snap, false);
});

test('snapshot of a failing read stores null for that key', async () => {
  const f = fakes({ host: { async focusAssist() { throw new Error('no'); } } });
  const snap = await takeSnapshot({ host: f.host, media: f.media, isOpen: f.isOpen, steps: steps(['focus_assist', { on: true }]) });
  assert.equal(snap.focus, null);
});

test('snapshot lists only apps that are open', async () => {
  const f = fakes({ isOpen: async n => n === 'Discord' });
  const snap = await takeSnapshot({ host: f.host, media: f.media, isOpen: f.isOpen, steps: steps(['routine_close', { name: 'Discord' }], ['routine_close', { name: 'Chrome' }]) });
  assert.deepEqual(snap.apps, [{ name: 'Discord' }]);
});

test('undo restores in reverse order of capture', async () => {
  const f = fakes();
  const snap = await takeSnapshot({ host: f.host, media: f.media, isOpen: f.isOpen, steps: steps(['focus_assist', { on: true }], ['set_system_volume', { percent: 40 }]) });
  f.log.length = 0;
  const r = await undoSnapshot({ host: f.host, media: f.media, openApp: f.openApp, snapshot: snap, now: () => 200 });
  assert.deepEqual(f.log, ['set volume 20', 'set focus false']);
  assert.equal(r.ok, true);
  assert.equal(r.lines.length, 2);
  assert.match(r.lines[0], /restored volume/i);
});

test('undo keeps going after one restore fails and reports it', async () => {
  const f = fakes({ media: { async act() { throw new Error('mixer gone'); } } });
  const snap = await takeSnapshot({ host: f.host, media: f.media, isOpen: f.isOpen, steps: steps(['focus_assist', { on: true }], ['set_system_volume', { percent: 40 }]) });
  f.log.length = 0;
  const r = await undoSnapshot({ host: f.host, media: f.media, openApp: f.openApp, snapshot: snap });
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /could not restore volume: mixer gone/i);
  assert.deepEqual(f.log, ['set focus false']);
});

test('undo reopens closed apps; an app that will not open is a line, not a throw', async () => {
  const f = fakes({ openApp: async name => { if (name === 'Chrome') throw new Error('not an app I can open'); return `Opened ${name}.`; } });
  const snap = { at: 1, apps: [{ name: 'Discord' }, { name: 'Chrome' }] };
  const r = await undoSnapshot({ host: f.host, media: f.media, openApp: f.openApp, snapshot: snap, now: () => 2 });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some(l => /reopened Discord/i.test(l)));
  assert.ok(r.lines.some(l => /could not restore Chrome/i.test(l)));
});

test('undo skips unreadable keys and refuses snapshots older than a week', async () => {
  const f = fakes();
  const r = await undoSnapshot({ host: f.host, media: f.media, openApp: f.openApp, snapshot: { at: 1, focus: null }, now: () => 2 });
  assert.match(r.lines[0], /skipped focus/i);
  assert.equal(r.ok, true);
  const old = await undoSnapshot({ host: f.host, media: f.media, openApp: f.openApp, snapshot: { at: 1, volume: 20 }, now: () => 1 + 8 * 864e5 });
  assert.equal(old.ok, false);
  assert.match(old.lines[0], /more than a week/);
});

test('undo of an empty snapshot says there is nothing to undo', async () => {
  const f = fakes();
  const r = await undoSnapshot({ host: f.host, media: f.media, openApp: f.openApp, snapshot: { at: 1 }, now: () => 2 });
  assert.deepEqual(r.lines, ['There is nothing to undo.']);
});
