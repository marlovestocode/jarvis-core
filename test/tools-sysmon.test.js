const test = require('node:test');
const assert = require('node:assert/strict');
const { createSysmonTool } = require('../src/core/tools/sysmon');
const { createMediaTool, ACTIONS } = require('../src/core/tools/media');
const { createToolRunner } = require('../src/core/tools/registry');

const snapshot = {
  t: 1, cpu: { load: 12.3, temp: 54.1, cores: [1, 2] }, gpu: { load: 20, temp: 45 }, mem: { pct: 77.4 },
  net: { rx: 1200000, tx: 2048 }, disk: { read: 0, write: 2300000, volumes: [{ mount: 'C:\\', pct: 82 }, { mount: 'D:\\', pct: 91 }] },
};
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, opts = {}) => { calls.push({ url, opts }); return handler(url, opts); };
  f.calls = calls;
  return f;
}
const json = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });

test('stats summary text', async () => {
  const fetch = fakeFetch(() => json(snapshot));
  const runner = createToolRunner([createSysmonTool({ fetch })]);
  const res = await runner.run('get_system_stats', {}, {});
  assert.equal(res.ok, true);
  assert.equal(fetch.calls[0].url, 'http://127.0.0.1:47800/snapshot');
  for (const part of ['CPU 12%', '54°C', 'GPU 20%', '45°C', 'RAM 77%', '1.2 MB/s', 'C: 82%', 'D: 91%']) assert.ok(res.text.includes(part), `${part} in ${res.text}`);
});

test('empty snapshot → ok:false Sysmon has no data yet', async () => {
  const runner = createToolRunner([createSysmonTool({ fetch: fakeFetch(() => json({})) })]);
  const res = await runner.run('get_system_stats', {}, {});
  assert.deepEqual([res.ok, /Sysmon has no data yet/.test(res.text)], [false, true]);
});

test('sysmon down → ok:false', async () => {
  const runner = createToolRunner([createSysmonTool({ fetch: fakeFetch(() => { throw new TypeError('fetch failed'); }) })]);
  const res = await runner.run('get_system_stats', {}, {});
  assert.equal(res.ok, false);
  assert.match(res.text, /Sysmon is not running/);
});

test('media posts right key with Origin', async () => {
  const fetch = fakeFetch(() => ({ ok: true, status: 204 }));
  const runner = createToolRunner([createMediaTool({ fetch })]);
  const res = await runner.run('media_control', { action: 'next' }, {});
  assert.equal(res.ok, true);
  assert.equal(fetch.calls[0].url, 'http://127.0.0.1:47800/media/next');
  assert.equal(fetch.calls[0].opts.method, 'POST');
  assert.equal(fetch.calls[0].opts.headers.Origin, 'http://127.0.0.1');
  assert.deepEqual(ACTIONS, ['playpause', 'next', 'prev', 'stop', 'mute', 'volup', 'voldown']);
});

test('bad action → ok:false, nothing posted', async () => {
  const fetch = fakeFetch(() => ({ ok: true, status: 204 }));
  const runner = createToolRunner([createMediaTool({ fetch })]);
  const res = await runner.run('media_control', { action: '../calendar' }, {});
  assert.equal(res.ok, false);
  assert.equal(fetch.calls.length, 0);
});

test('media: sysmon answers 429/503 → ok:false with reason', async () => {
  for (const [status, re] of [[429, /too fast/i], [503, /unavailable/i]]) {
    const runner = createToolRunner([createMediaTool({ fetch: fakeFetch(() => ({ ok: false, status })) })]);
    const res = await runner.run('media_control', { action: 'mute' }, {});
    assert.equal(res.ok, false);
    assert.match(res.text, re);
  }
});

test('tools only talk to 127.0.0.1:47800', async () => {
  const urls = [];
  const fetch = fakeFetch(url => { urls.push(url); return url.endsWith('snapshot') ? json(snapshot) : { ok: true, status: 204 }; });
  const runner = createToolRunner([createSysmonTool({ fetch }), createMediaTool({ fetch })]);
  await runner.run('get_system_stats', {}, {});
  for (const a of ACTIONS) await runner.run('media_control', { action: a }, {});
  assert.ok(urls.every(u => u.startsWith('http://127.0.0.1:47800/')));
});
