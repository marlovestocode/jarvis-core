const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createFakeProvider } = require('./helpers/fake-provider');
const { createBus } = require('../src/core/bus');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { DEFAULTS } = require('../src/core/config');
const { startBridge } = require('../src/core/bridge');

function orcWith({ memoryBlock, live, context, route }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jco-'));
  const providers = createRegistry();
  providers.add(NullProvider);
  const fp = createFakeProvider([{ type: 'token', text: 'ok' }, { type: 'done' }]);
  providers.add(fp);
  const bus = createBus();
  const events = [];
  bus.on('ctxpkg', e => events.push(e));
  const orc = createOrchestrator({ bus, sessions: createSessionStore(dir), providers, tools: null, getConfig: () => ({ ...DEFAULTS, provider: fp.id }), memoryBlock, live, context, route });
  return { orc, bus, events };
}
function spyBlock() {
  const calls = [];
  return { calls, forTurn: async o => { calls.push(o); return { memo: '', ids: [] }; }, afterTurn() {}, onUserMessage() {} };
}
const liveWith = snap => ({ snapshot: () => snap });
const SNAP = { activeWindow: { app: 'Code', title: 'wallpaper' } };
function spyContext(result) {
  const calls = [];
  return { calls, assemble: async r => { calls.push(r); if (result instanceof Error) throw result; return result; } };
}
const PKG = { items: [1, 2], text: 'T', hint: 'assembled hint', dropped: [1], errors: [], ms: 3 };

test('assembler hint reaches forTurn instead of liveContext', async () => {
  const block = spyBlock(); const context = spyContext(PKG);
  const { orc } = orcWith({ memoryBlock: block, live: liveWith(SNAP), context });
  await orc.send(null, 'what port does it use', { source: 'text' });
  assert.equal(context.calls.length, 1);
  assert.equal(context.calls[0].brief, false);
  assert.equal(typeof context.calls[0].sessionId, 'string');
  assert.equal(block.calls[0].context, 'assembled hint');
});

test('one snapshot per turn: the request carries snap; no second live.snapshot() and no tasks.active()', async () => {
  const { createAssembler } = require('../src/core/context/assemble');
  const { liveProvider, taskProvider } = require('../src/core/context/providers');
  let snaps = 0, actives = 0;
  const snap = { activeWindow: { app: 'Code' }, task: { id: 't1', title: 'wallpaper project', status: 'running', done: 0, total: 2 } };
  const live = { snapshot: () => { snaps++; return snap; } };
  const tasks = { active: () => { actives++; return snap.task; } };
  const context = createAssembler({ providers: [liveProvider({ live }), taskProvider({ tasks })] });
  const block = spyBlock();
  const { orc } = orcWith({ memoryBlock: block, live, context });
  await orc.send(null, 'what port does it use', { source: 'text' });
  assert.equal(snaps, 1); assert.equal(actives, 0);
  assert.equal(block.calls[0].context, 'Code wallpaper project');
});

test('assembler throws: falls back to liveContext', async () => {
  const block = spyBlock();
  const { orc } = orcWith({ memoryBlock: block, live: liveWith(SNAP), context: spyContext(new Error('boom')) });
  await orc.send(null, 'what port does it use', { source: 'text' });
  assert.match(block.calls[0].context, /wallpaper/);
});

test('empty hint: falls back to liveContext', async () => {
  const block = spyBlock();
  const { orc } = orcWith({ memoryBlock: block, live: liveWith(SNAP), context: spyContext({ ...PKG, hint: '' }) });
  await orc.send(null, 'what port does it use', { source: 'text' });
  assert.match(block.calls[0].context, /wallpaper/);
});

test('guest turn: assembler not called', async () => {
  const block = spyBlock(); const context = spyContext(PKG);
  const { orc } = orcWith({ memoryBlock: block, live: liveWith(SNAP), context });
  await orc.send(null, 'what port does it use', { source: 'text', speaker: 'guest' });
  assert.equal(context.calls.length, 0);
});

test('brief turn: assembler not called', async () => {
  const block = spyBlock(); const context = spyContext(PKG);
  const { orc } = orcWith({ memoryBlock: block, live: liveWith(SNAP), context, route: () => ({ tier: 'fast', tools: false }) });
  await orc.send(null, 'hi', { source: 'text' });
  assert.equal(block.calls[0].brief, true);
  assert.equal(context.calls.length, 0);
});

test('no context option: today behavior', async () => {
  const block = spyBlock();
  const { orc, events } = orcWith({ memoryBlock: block, live: liveWith(SNAP) });
  await orc.send(null, 'what port does it use', { source: 'text' });
  assert.match(block.calls[0].context, /wallpaper/);
  assert.equal(events.length, 0);
});

test('bus event carries counts only', async () => {
  const block = spyBlock(); const context = spyContext({ ...PKG, errors: [{ provider: 'x', error: 'secret text' }] });
  const { orc, events } = orcWith({ memoryBlock: block, live: liveWith(SNAP), context });
  await orc.send(null, 'what port does it use', { source: 'text' });
  const ev = events[0];
  assert.ok(ev);
  assert.equal(ev.items, 2); assert.equal(ev.dropped, 1); assert.equal(ev.errors, 1); assert.equal(typeof ev.ms, 'number');
  assert.ok(!/assembled hint|secret/.test(JSON.stringify(ev)));
});

test('bridge: ctxpkg forwards as exactly {type,t}; the context gauge still forwards used/max', { timeout: 5000 }, async () => {
  const http = require('node:http');
  const port = await new Promise(res => { const sv = http.createServer().listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => res(p)); }); });
  const bus = createBus();
  const br = await startBridge({ bus, version: 't', ports: [port, port + 1] });
  const grab = name => new Promise(res => {
    const re = new RegExp('event: ' + name + String.fromCharCode(10) + 'data: (.+)' + String.fromCharCode(10, 10));
    const r = http.get({ host: '127.0.0.1', port: br.port, path: '/ai/stream' }, resp => {
      let buf = '';
      const tick = setInterval(() => { bus.emit('ctxpkg', { items: 2, dropped: 1, errors: 0, ms: 3 }); bus.emit('context', { used: 10, max: 100 }); }, 25);
      resp.on('close', () => clearInterval(tick));
      resp.on('data', d => { buf += d; const m = re.exec(buf); if (m) { clearInterval(tick); r.destroy(); res(JSON.parse(m[1])); } });
    });
    r.on('error', () => {});
  });
  const pkg = await grab('ctxpkg');
  assert.deepEqual(Object.keys(pkg).sort(), ['t', 'type']);
  assert.equal(pkg.type, 'ctxpkg');
  const gauge = await grab('context');
  assert.equal(gauge.used, 10); assert.equal(gauge.max, 100);
  await br.close();
});
