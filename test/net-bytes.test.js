const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPolicy } = require('../src/core/net/policy');
const { createFetcher } = require('../src/core/net/fetcher');
const { DEFAULTS } = require('../src/core/config');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x80, 0xfe]);   // not valid UTF-8 on purpose
function make({ body = PNG, status = 200 } = {}) {
  const calls = []; const clock = { t: 1e9 };
  const fetch = async url => { calls.push(url); return new Response(body, { status }); };
  const events = [];
  const fetcher = createFetcher({ policy: createPolicy(() => DEFAULTS), fetch, now: () => clock.t, bus: { emit: (t, p) => events.push(p) }, cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'jc-b-')) });
  return { fetcher, calls, clock, events };
}
const URL_OK = 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer/exportImage?f=image';

test('policy: the NOAA map-services host is allowed for weather (and nothing else on noaa.gov)', () => {
  const p = createPolicy(() => DEFAULTS);
  assert.equal(p.allowed(URL_OK, 'weather').ok, true);
  assert.equal(p.allowed(URL_OK, 'news').ok, true, 'host list is shared; the per-source switch is what gates it');
  assert.equal(p.allowed('https://www.noaa.gov/x', 'weather').ok, false);
  assert.equal(p.allowed('https://evil.mapservices.weather.noaa.gov/x', 'weather').ok, false);
  assert.equal(createPolicy(() => ({ ...DEFAULTS, online: { ...DEFAULTS.online, weather: false } })).allowed(URL_OK, 'weather').ok, false);
});

test('getBytes: returns the exact bytes (no UTF-8 mangling), caches for the TTL, refetches after it', async () => {
  const { fetcher, calls, clock } = make();
  const a = await fetcher.getBytes('weather', URL_OK, { ttlMs: 60000 });
  assert.ok(Buffer.isBuffer(a.data)); assert.deepEqual(a.data, PNG);
  const b = await fetcher.getBytes('weather', URL_OK, { ttlMs: 60000 });
  assert.equal(b.cached, true); assert.equal(calls.length, 1);
  clock.t += 61000;
  await fetcher.getBytes('weather', URL_OK, { ttlMs: 60000 });
  assert.equal(calls.length, 2);
});

test('getBytes: policy refusal, size cap and HTTP errors behave like getText', async () => {
  const { fetcher } = make();
  await assert.rejects(fetcher.getBytes('weather', 'https://example.com/a.png'), /not allowed/);
  const big = make({ body: Buffer.alloc(3 * 1024 * 1024) });
  await assert.rejects(big.fetcher.getBytes('weather', URL_OK), /too large/);
  const bad = make({ status: 500 });
  await assert.rejects(bad.fetcher.getBytes('weather', URL_OK), /HTTP 500/);
});
