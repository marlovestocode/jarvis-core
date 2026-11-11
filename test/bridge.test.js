const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createBus } = require('../src/core/bus');
const { startBridge } = require('../src/core/bridge');

function freePort() {
  return new Promise(res => {
    const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function req(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, resp => {
      let body = '';
      resp.on('data', d => { body += d; });
      resp.on('end', () => res({ status: resp.statusCode, headers: resp.headers, body }));
    });
    r.on('error', rej);
    r.end();
  });
}

// Open an SSE stream and collect parsed events until `until(events)` is true.
function stream(port, until, headers = {}) {
  return new Promise((res, rej) => {
    const events = [];
    const r = http.get({ host: '127.0.0.1', port, path: '/ai/stream', headers }, resp => {
      if (resp.statusCode !== 200) { res({ status: resp.statusCode, events }); return; }
      let buf = '';
      resp.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block);
          const data = /^data: (.+)$/m.exec(block);
          if (ev && data) events.push({ event: ev[1], data: JSON.parse(data[1]) });
        }
        if (until(events)) { r.destroy(); res({ status: 200, events }); }
      });
    });
    r.on('error', e => (e.code === 'ECONNRESET' ? null : rej(e)));
    stream.last = r;
  });
}

async function boot(opts = {}) {
  const p = await freePort();
  const bus = createBus();
  const opened = [];
  const br = await startBridge({ bus, version: '9.9.9', onOpen: m => opened.push(m), ports: [p, p + 1], ...opts });
  return { bus, br, opened };
}

test('hello returns app name', async () => {
  const { br } = await boot();
  const r = await req(br.port, { path: '/ai/hello' });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { app: 'jarvis-core', version: '9.9.9' });
  await br.close();
});

test('stream delivers bus events as SSE, with current state and provider on connect', async () => {
  const { bus, br } = await boot();
  bus.emit('provider', { id: 'null', label: 'No model', ready: false });
  const got = stream(br.port, evs => evs.some(e => e.event === 'token'));
  await new Promise(r => setTimeout(r, 50));
  bus.emit('token', { text: 'hi', prob: 0.5 });
  const { events } = await got;
  assert.equal(events[0].event, 'state');
  assert.equal(events[0].data.state, 'idle');
  assert.equal(events[1].event, 'provider');
  assert.equal(events[1].data.label, 'No model');
  const tok = events.find(e => e.event === 'token');
  assert.equal(tok.data.text, '', 'the words of the conversation are not sent on the stream');
  assert.equal(tok.data.prob, 0.5);
  await br.close();
});

test('level throttled: 100 emits in 100 ms → ≤ 4 delivered', async () => {
  const { bus, br } = await boot();
  const got = stream(br.port, evs => evs.some(e => e.event === 'wake'));
  await new Promise(r => setTimeout(r, 50));
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) {
    while (Date.now() - t0 < i) { /* spread 100 emits over ~100 ms */ }
    bus.emit('level', { source: 'mic', rms: i / 100 });
  }
  // tts levels are throttled separately
  bus.emit('level', { source: 'tts', rms: 0.5 });
  bus.emit('wake', {});
  const { events } = await got;
  const mic = events.filter(e => e.event === 'level' && e.data.source === 'mic');
  const tts = events.filter(e => e.event === 'level' && e.data.source === 'tts');
  assert.ok(mic.length >= 1 && mic.length <= 4, `mic levels ${mic.length}`);
  assert.equal(tts.length, 1);
  await br.close();
});

test('foreign Origin → 403', async () => {
  const { br } = await boot();
  assert.equal((await req(br.port, { path: '/ai/hello', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await stream(br.port, () => true, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await req(br.port, { path: '/ai/hello', headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await req(br.port, { path: '/ai/hello', headers: { Origin: 'http://localhost:5177' } })).status, 200);
  await br.close();
});

test('POST open: the wallpaper (file:// page, no Origin header) and local pages may open; foreign sites may not', async () => {
  const { br, opened } = await boot();
  // Chromium sends no Origin on a POST from a file:// page: that is the wallpaper's TALK button
  assert.equal((await req(br.port, { method: 'POST', path: '/ai/open?mode=voice' })).status, 204);
  assert.equal((await req(br.port, { method: 'POST', path: '/ai/open', headers: { Origin: 'http://127.0.0.1:5177' } })).status, 204);
  assert.equal((await req(br.port, { method: 'POST', path: '/ai/open', headers: { Origin: 'null' } })).status, 204);
  assert.equal((await req(br.port, { method: 'POST', path: '/ai/open?mode=voice', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await req(br.port, { method: 'POST', path: '/ai/open', headers: { Host: 'evil.example' } })).status, 403);
  assert.deepEqual(opened, ['voice', 'chat', 'chat']);
  await br.close();
});

test('first port busy → binds the next one', async () => {
  const p = await freePort();
  const blocker = http.createServer().listen(p, '127.0.0.1');
  await new Promise(r => blocker.once('listening', r));
  const br = await startBridge({ bus: createBus(), version: '1', onOpen() {}, ports: [p, p + 1] });
  assert.equal(br.port, p + 1);
  const r = await req(br.port, { path: '/ai/hello' });
  assert.equal(r.status, 200);
  await br.close();
  blocker.close();
});

test('all ports busy → rejects', async () => {
  const p = await freePort();
  const blocker = http.createServer().listen(p, '127.0.0.1');
  await new Promise(r => blocker.once('listening', r));
  await assert.rejects(startBridge({ bus: createBus(), version: '1', onOpen() {}, ports: [p] }));
  blocker.close();
});

test('binds 127.0.0.1 only', async () => {
  const { br } = await boot();
  assert.equal(br.address, '127.0.0.1');
  await br.close();
});

test('bridge: a client that connects soon after boot gets the boot events replayed; clients() counts', async () => {
  const { bus, br } = await boot();
  bus.emit('boot', { stage: 'core', ok: true });
  bus.emit('boot', { stage: 'model', ok: true, detail: 'jarvis-worker' });
  assert.equal(br.clients(), 0);
  const got = stream(br.port, evs => evs.filter(e => e.event === 'boot').length >= 2);
  const { events } = await got;
  assert.deepEqual(events.filter(e => e.event === 'boot').map(e => e.data.stage), ['core', 'model']);
  await br.close();
});
