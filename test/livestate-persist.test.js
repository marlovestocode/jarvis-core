const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createBus } = require('../src/core/bus');
const { createLiveState } = require('../src/core/livestate');
const persist = require('../src/core/livestate/persist');
const { createActiveWindow } = require('../src/core/livestate/active-window');
const { startBridge } = require('../src/core/bridge');
const { loadConfig, DEFAULTS } = require('../src/core/config');
const { applyPatch } = require('../src/core/settings');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jv-live-'));
const NOW = 1_800_000_000_000;
const snap = (over = {}) => ({
  t: NOW, voice: 'idle',
  tools: [{ name: 'open_app', ok: true, soft: false, t: NOW - 1000 }],
  models: [{ name: 'qwen3:8b', t: NOW - 2000 }],
  route: { tier: 'fast', model: 'qwen3:8b', reason: 'short' },
  turn: { ms: 1200 },
  ...over,
});

test('persist: snapshot round-trips', () => {
  const dir = tmp();
  persist.save(dir, snap(), { delayMs: 0 });
  persist.flush();
  assert.deepEqual(persist.load(dir, { now: () => NOW + 1000 }), snap());
});

test('persist: missing, corrupt and non-object files load as null', () => {
  const dir = tmp();
  assert.equal(persist.load(dir), null);
  const f = path.join(dir, 'livestate.json');
  for (const body of ['{ not json', '[]', '"x"', '42', 'null', '']) {
    fs.writeFileSync(f, body);
    assert.equal(persist.load(dir, { now: () => NOW }), null, body);
  }
  assert.equal(persist.load(path.join(dir, 'nope', 'deeper')), null);
});

test('persist: a snapshot older than 24 h is discarded', () => {
  const dir = tmp();
  persist.save(dir, snap(), { delayMs: 0 });
  persist.flush();
  assert.ok(persist.load(dir, { now: () => NOW + 23 * 3600e3 }));
  assert.equal(persist.load(dir, { now: () => NOW + 25 * 3600e3 }), null);
});

test('persist: atomic write leaves no temp file and replaces whole', () => {
  const dir = tmp();
  persist.save(dir, snap(), { delayMs: 0 });
  persist.flush();
  persist.save(dir, snap({ voice: 'speaking' }), { delayMs: 0 });
  persist.flush();
  assert.deepEqual(fs.readdirSync(dir), ['livestate.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'livestate.json'), 'utf8')).voice, 'speaking');
});

test('persist: save never throws (unwritable dir)', () => {
  const dir = tmp();
  const file = path.join(dir, 'blocker');
  fs.writeFileSync(file, 'x');
  assert.doesNotThrow(() => { persist.save(path.join(file, 'sub'), snap(), { delayMs: 0 }); persist.flush(); });
});

test('persist: debounce coalesces writes, keeping the last', async () => {
  const dir = tmp();
  const orig = fs.renameSync;
  let renames = 0;
  fs.renameSync = (...a) => { renames++; return orig(...a); };
  try {
    for (let i = 0; i < 10; i++) persist.save(dir, snap({ turn: { ms: i } }), { delayMs: 30 });
    assert.equal(renames, 0);
    await new Promise(r => setTimeout(r, 120));
    assert.equal(renames, 1);
    assert.equal(persist.load(dir, { now: () => NOW }).turn.ms, 9);
  } finally { fs.renameSync = orig; }
});

test('persist: only metadata is serialized, never args, output or text', () => {
  const dir = tmp();
  persist.save(dir, snap({
    tools: [{ name: 'type_text', ok: true, soft: false, t: NOW, args: { text: 'SECRET' }, output: 'SECRET', label: 'SECRET' }],
    route: { tier: 'fast', model: 'm', reason: 'r', text: 'SECRET' },
    reply: 'SECRET', text: 'SECRET',
    activeWindow: { app: 'chrome', title: 'SECRET bank' },
    media: { playing: true },
  }), { delayMs: 0 });
  persist.flush();
  const raw = fs.readFileSync(path.join(dir, 'livestate.json'), 'utf8');
  assert.ok(!raw.includes('SECRET'));
  assert.deepEqual(Object.keys(JSON.parse(raw).tools[0]).sort(), ['name', 'ok', 'soft', 't']);
});

test('persist: size is bounded', () => {
  const dir = tmp();
  const many = Array.from({ length: 500 }, (_, i) => ({ name: 'x'.repeat(500), ok: true, soft: false, t: NOW - i }));
  persist.save(dir, snap({ tools: many, models: many.map(m => ({ name: m.name, t: m.t })) }), { delayMs: 0 });
  persist.flush();
  assert.ok(fs.statSync(path.join(dir, 'livestate.json')).size < 8192);
});

test('LiveState: restore re-prunes by TTL, save hook gets metadata', () => {
  let t = NOW;
  const restore = snap({ tools: [
    { name: 'old', ok: true, soft: false, t: NOW - 11 * 60e3 },
    { name: 'fresh', ok: false, soft: false, t: NOW - 60e3 },
    { name: 'future', ok: true, soft: false, t: NOW + 99999 },
    { bad: 1 },
  ] });
  const live = createLiveState({ bus: createBus(), now: () => t, restore });
  const s = live.snapshot();
  assert.deepEqual(s.tools.map(x => x.name), ['fresh']);
  assert.deepEqual(s.models.map(x => x.name), ['qwen3:8b']);
  assert.equal(s.route.tier, 'fast');
  assert.equal(s.voice, null, 'a stale voice state is not restored');
  t += 11 * 60e3;
  assert.deepEqual(live.snapshot().tools, []);
  live.close();
});

test('LiveState: bus events call the save hook; a throwing hook or garbage restore is harmless', () => {
  const bus = createBus();
  const saved = [];
  const live = createLiveState({ bus, now: () => NOW, restore: 'garbage', save: s => { saved.push(s); throw new Error('disk'); } });
  bus.emit('tool', { name: 'open_app', phase: 'end', ok: true, args: { a: 'SECRET' } });
  assert.equal(saved.length, 1);
  assert.ok(!JSON.stringify(saved[0]).includes('SECRET'));
  assert.equal(live.snapshot().tools.length, 1);
  live.close();
});

test('LiveState without restore or save behaves as before', () => {
  const live = createLiveState({ bus: createBus(), now: () => NOW });
  assert.deepEqual(live.snapshot().tools, []);
  live.close();
});

function fakeHost(ws, fg) {
  let calls = 0;
  return { calls: () => calls, host: { foreground: async () => { calls++; return fg; }, windows: async () => ws } };
}
const WS = [{ hwnd: 7, pid: 1, app: 'chrome', title: 'Bank - private tab' }, { hwnd: 8, pid: 2, app: 'code', title: 'x' }];
const settle = () => new Promise(r => setImmediate(r));

test('active window: only { app } when the title flag is off', async () => {
  const { host } = fakeHost(WS, 7);
  const aw = createActiveWindow({ host, includeTitle: () => false, now: () => NOW });
  assert.equal(aw.name, 'activeWindow');
  assert.equal(aw.read(), null, 'first read never blocks');
  await settle(); await settle();
  assert.deepEqual(aw.read(), { app: 'chrome' });
});

test('active window: title included when the flag is on', async () => {
  const { host } = fakeHost(WS, 7);
  const aw = createActiveWindow({ host, includeTitle: () => true, now: () => NOW });
  aw.read(); await settle(); await settle();
  assert.deepEqual(aw.read(), { app: 'chrome', title: 'Bank - private tab' });
});

test('active window: cached (no host call per read), refreshed after the TTL, skipped on host failure', async () => {
  let t = NOW;
  const f = fakeHost(WS, 7);
  const aw = createActiveWindow({ host: f.host, includeTitle: () => false, now: () => t, ttlMs: 2000 });
  aw.read(); await settle(); await settle();
  for (let i = 0; i < 20; i++) aw.read();
  assert.equal(f.calls(), 1);
  t += 3000; aw.read(); await settle(); await settle();
  assert.equal(f.calls(), 2);
  const bad = createActiveWindow({ host: { foreground: async () => { throw new Error('down'); }, windows: async () => [] }, includeTitle: () => false, now: () => t });
  bad.read(); await settle(); await settle();
  assert.equal(bad.read(), null);
  assert.equal(createActiveWindow({ host: null }).read(), null);
});

test('active window: a stale cache is not served; turning the flag off hides a cached title', async () => {
  let t = NOW; let flag = true;
  const { host } = fakeHost(WS, 7);
  const aw = createActiveWindow({ host, includeTitle: () => flag, now: () => t, ttlMs: 2000 });
  aw.read(); await settle(); await settle();
  flag = false;
  assert.deepEqual(aw.read(), { app: 'chrome' });
  t += 60000;
  assert.equal(aw.read(), null);
});

const REGS = { providers: { get: () => null }, engines: {} };
test('config: livestate.windowTitle defaults false, validated as boolean, settable', () => {
  assert.equal(DEFAULTS.livestate.windowTitle, false);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ livestate: { windowTitle: 'yes' } }));
  assert.equal(loadConfig(dir).livestate.windowTitle, false);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ livestate: { windowTitle: true } }));
  assert.equal(loadConfig(dir).livestate.windowTitle, true);
  assert.equal(applyPatch(DEFAULTS, { livestate: { windowTitle: true } }, REGS).config.livestate.windowTitle, true);
  assert.ok(applyPatch(DEFAULTS, { livestate: { windowTitle: 'x' } }, REGS).errors.length);
});

test('bridge: a window title on an event never reaches the public stream', async () => {
  const port = await new Promise(res => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const bus = createBus();
  const br = await startBridge({ bus, version: '0', ports: [port, port + 1] });
  const events = [];
  await new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port: br.port, path: '/ai/stream' }, resp => {
      let buf = '';
      resp.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { events.push(buf.slice(0, i)); buf = buf.slice(i + 2); }
        if (events.some(e => e.includes('event: route'))) { r.destroy(); res(); }
      });
      setTimeout(() => bus.emit('state', { state: 'idle', activeWindow: { app: 'chrome', title: 'SECRET title' }, title: 'SECRET title' }), 30);
      setTimeout(() => bus.emit('route', { tier: 'fast', model: 'm', title: 'SECRET title', windowTitle: 'SECRET title', live: { activeWindow: { title: 'SECRET title' } } }), 60);
    });
    r.on('error', () => {});
  });
  assert.ok(!events.join('\n').includes('SECRET'));
  await br.close();
});
