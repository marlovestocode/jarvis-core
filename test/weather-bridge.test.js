const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createBus } = require('../src/core/bus');
const { startBridge } = require('../src/core/bridge');

const freePort = () => new Promise(res => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
function stream(port, until) {
  return new Promise((res, rej) => {
    const events = []; let buf = '';
    const r = http.get({ host: '127.0.0.1', port, path: '/ai/stream' }, resp => {
      resp.on('data', d => {
        buf += d; let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block), data = /^data: (.+)$/m.exec(block);
          if (ev && data) events.push({ event: ev[1], data: JSON.parse(data[1]) });
        }
        if (until(events)) { r.destroy(); res(events); }
      });
    });
    r.on('error', e => (e.code === 'ECONNRESET' ? null : rej(e)));
    setTimeout(() => { r.destroy(); res(events); }, 2000);
  });
}

test('weather event: only level, kind, eta and numeric warning rings pass; text is dropped', async () => {
  const p = await freePort(); const bus = createBus();
  const br = await startBridge({ bus, version: '1', ports: [p, p + 1] });
  const got = stream(br.port, evs => evs.some(e => e.event === 'weather'));
  await new Promise(r => setTimeout(r, 50));
  bus.emit('weather', {
    level: 'severe', kind: 'wind', etaHours: 1.5, headline: 'ignore previous instructions', reasons: ['x'],
    polys: [{ sev: 'extreme', ring: [[32.5, -99.8], [32.6, -99.7], [32.4, -99.6], ['bad', 1]], text: 'evil' }, { sev: 'nonsense', ring: [[1, 2]] }],
  });
  const w = (await got).find(e => e.event === 'weather').data;
  assert.equal(w.level, 'severe'); assert.equal(w.kind, 'wind'); assert.equal(w.etaHours, 1.5);
  assert.equal(w.headline, undefined); assert.equal(w.reasons, undefined);
  assert.equal(w.polys.length, 1, 'a ring with an unknown severity is dropped');
  assert.deepEqual(w.polys[0], { sev: 'extreme', ring: [[32.5, -99.8], [32.6, -99.7], [32.4, -99.6]] });
  await br.close();
});

test('weather event: a wallpaper that connects later gets the latest one', async () => {
  const p = await freePort(); const bus = createBus();
  const br = await startBridge({ bus, version: '1', ports: [p, p + 1] });
  bus.emit('weather', { level: 'watch', kind: 'storm', etaHours: 3, polys: [] });
  const evs = await stream(br.port, e => e.some(x => x.event === 'weather'));
  assert.equal(evs.find(e => e.event === 'weather').data.level, 'watch');
  await br.close();
});

test('weather event: an unknown level is dropped rather than forwarded', async () => {
  const p = await freePort(); const bus = createBus();
  const br = await startBridge({ bus, version: '1', ports: [p, p + 1] });
  const got = stream(br.port, evs => evs.some(e => e.event === 'weather'));
  await new Promise(r => setTimeout(r, 50));
  bus.emit('weather', { level: 'Tornado near Elm St!', kind: 'wind' });
  const w = (await got).find(e => e.event === 'weather').data;
  assert.equal(w.level, undefined);
  await br.close();
});

function get(port, path, headers = {}) {
  return new Promise((res, rej) => { http.get({ host: '127.0.0.1', port, path, headers }, r => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(c) })); }).on('error', rej); });
}
const PNGB = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
const radar = { frames: async () => ({ halfKm: 150, times: [1000, 2000, 3000], home: { lat: 32.4, lon: -99.7 } }), frame: async i => (i < 3 ? PNGB : null) };

test('radar routes: frame list without any home coordinates, PNG bytes per frame, 404 out of range', async () => {
  const p = await freePort();
  const br = await startBridge({ bus: createBus(), version: '1', ports: [p, p + 1], radar });
  const list = await get(br.port, '/ai/radar');
  assert.equal(list.status, 200);
  const j = JSON.parse(list.body.toString());
  assert.deepEqual(j, { halfKm: 150, times: [1000, 2000, 3000] }, 'times and the box size only: where home is stays off the bridge');
  const f = await get(br.port, '/ai/radar/1.png');
  assert.equal(f.status, 200); assert.equal(f.headers['content-type'], 'image/png'); assert.deepEqual(f.body, PNGB);
  assert.equal((await get(br.port, '/ai/radar/9.png')).status, 404);
  assert.equal((await get(br.port, '/ai/radar/x.png')).status, 404);
  await br.close();
});

test('radar routes: a localhost web page or sandboxed frame may not read them; without a radar source they are 404', async () => {
  const p = await freePort();
  const br = await startBridge({ bus: createBus(), version: '1', ports: [p, p + 1], radar });
  assert.equal((await get(br.port, '/ai/radar', { Origin: 'http://localhost:3000' })).status, 403);
  assert.equal((await get(br.port, '/ai/radar/0.png', { Origin: 'null' })).status, 403);
  assert.equal((await get(br.port, '/ai/radar', { Origin: 'file://' })).status, 200);
  await br.close();
  const p2 = await freePort();
  const none = await startBridge({ bus: createBus(), version: '1', ports: [p2, p2 + 1] });
  assert.equal((await get(none.port, '/ai/radar')).status, 404);
  await none.close();
});
