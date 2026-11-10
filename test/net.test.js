const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPolicy, BASE_HOSTS } = require('../src/core/net/policy');
const { createFetcher } = require('../src/core/net/fetcher');
const { DEFAULTS, loadConfig } = require('../src/core/config');

const cfg = (over = {}) => ({ ...DEFAULTS, ...over, online: { ...DEFAULTS.online, ...(over.online || {}) } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jc-net-'));

// fake fetch: answers from a table, counts calls
function fakeFetch(table = {}) {
  const f = async (url, opts = {}) => {
    f.calls.push({ url, opts });
    const h = table[url];
    if (!h) throw new TypeError('fetch failed');
    if (typeof h === 'function') return h(url, opts);
    return new Response(typeof h === 'string' ? h : JSON.stringify(h), { status: 200 });
  };
  f.calls = [];
  return f;
}
function setup({ table, config = cfg(), now, cacheDir = tmp(), timeoutMs, maxBytes } = {}) {
  const events = [];
  const bus = { emit: (type, p) => events.push({ type, ...p }) };
  const policy = createPolicy(() => config);
  const fetch = fakeFetch(table);
  const clock = { t: 1_000_000 };
  const fetcher = createFetcher({ policy, fetch, bus, cacheDir, now: now || (() => clock.t), timeoutMs, maxBytes });
  return { fetcher, fetch, events, clock, policy, cacheDir };
}
const W = 'https://api.open-meteo.com/v1/forecast?latitude=32.45&longitude=-99.73';

test('config: online, location, news, sports defaults', () => {
  assert.deepEqual(DEFAULTS.online, { enabled: true, weather: true, news: true, sports: true, wiki: true });
  assert.deepEqual(DEFAULTS.location, { city: 'Abilene, TX', lat: 32.4487, lon: -99.7331, country: 'US', units: 'F' });
  assert.equal(DEFAULTS.news.feeds.length, 4);
  assert.ok(DEFAULTS.news.feeds.every(u => u.startsWith('https://')));
  assert.deepEqual(DEFAULTS.sports.follow, []);
});

test('config: bad news/sports/location values fall back per key', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({
    news: { feeds: 'x' }, sports: { follow: [{ league: 'nfl', team: 'Cowboys' }, 5, { league: 1 }] },
    location: { city: 'Dallas, TX', lat: 'n', lon: -96.8, units: 'F' }, online: { enabled: false, news: 'no' },
  }));
  const c = loadConfig(d);
  assert.deepEqual(c.news.feeds, DEFAULTS.news.feeds);
  assert.deepEqual(c.sports.follow, [{ league: 'nfl', team: 'Cowboys' }]);
  assert.equal(c.location.city, 'Dallas, TX');
  assert.equal(c.location.lat, DEFAULTS.location.lat);
  assert.equal(c.online.enabled, false);
  assert.equal(c.online.news, true);
});

test('policy: allowlisted hosts pass; feed hosts are added from config', () => {
  const p = createPolicy(() => cfg({ news: { feeds: ['https://example-news.org/rss'] } }));
  assert.equal(p.allowed(W, 'weather').ok, true);
  assert.equal(p.allowed('https://example-news.org/rss', 'news').ok, true);
  assert.ok(p.hosts().includes('api.weather.gov'));
  assert.ok(BASE_HOSTS.includes('site.api.espn.com'));
  assert.equal(p.allowed('https://feeds.bbci.co.uk/news/rss.xml', 'news').ok, false, 'default feed removed from config');
});

for (const [name, url] of [
  ['other host', 'https://evil.com/x'],
  ['http', 'http://api.open-meteo.com/v1/forecast'],
  ['IP literal', 'https://93.184.216.34/'],
  ['IPv6 literal', 'https://[::1]/'],
  ['userinfo trick', 'https://api.open-meteo.com@evil.com/'],
  ['userinfo on allowed host', 'https://user:pw@api.open-meteo.com/'],
  ['uppercase host', 'https://API.Open-Meteo.com/v1/forecast'],
  ['suffix trick', 'https://api.open-meteo.com.evil.com/'],
  ['trailing dot', 'https://api.open-meteo.com./v1'],
  ['explicit port', 'https://api.open-meteo.com:8443/v1'],
  ['not a url', 'api.open-meteo.com/v1'],
]) {
  test(`policy: refuses ${name}, with no fetch`, async () => {
    const { fetcher, fetch, events } = setup({ table: { [url]: {} } });
    assert.equal(createPolicy(() => cfg()).allowed(url, 'weather').ok, false);
    await assert.rejects(fetcher.getJson('weather', url, { ttlMs: 1000 }), /refused|not allowed|https/i);
    assert.equal(fetch.calls.length, 0);
    assert.equal(events.at(-1)?.ok, false);
  });
}

test('policy: configured feeds cannot allowlist IP literals or local hosts', () => {
  const urls = ['https://127.0.0.1/rss', 'https://[::1]/rss', 'https://news.local/rss', 'https://news.internal/rss', 'https://user:pass@feeds.bbci.co.uk/rss'];
  const p = createPolicy(() => cfg({ news: { feeds: urls } }));
  for (const url of urls) assert.equal(p.allowed(url, 'news').ok, false, url);
});

test('policy: master switch and per-source switch', async () => {
  let c = cfg({ online: { enabled: false } });
  const p = createPolicy(() => c);
  assert.match(p.allowed(W, 'weather').reason, /online lookups are off/i);
  c = cfg({ online: { weather: false } });
  assert.match(p.allowed(W, 'weather').reason, /weather lookups are off/i);
  assert.equal(p.allowed('https://en.wikipedia.org/w/api.php', 'wiki').ok, true);
  const { fetcher, fetch } = setup({ config: cfg({ online: { enabled: false } }), table: { [W]: { a: 1 } } });
  await assert.rejects(fetcher.getJson('weather', W), /online lookups are off/i);
  assert.equal(fetch.calls.length, 0);
});

test('fetcher: GET with JARVIS user agent, no cookies/body; net event', async () => {
  const { fetcher, fetch, events } = setup({ table: { [W]: { temp: 70 } } });
  const r = await fetcher.getJson('weather', W, { ttlMs: 60000 });
  assert.deepEqual(r.data, { temp: 70 });
  assert.equal(r.cached, false);
  const o = fetch.calls[0].opts;
  assert.equal(o.method, 'GET');
  assert.equal(o.body, undefined);
  assert.equal(o.redirect, 'manual');
  assert.match(o.headers['User-Agent'], /^JARVIS-core\/0\.\d+ \(local assistant\)$/);
  const ev = events.find(e => e.type === 'net');
  assert.equal(ev.source, 'weather'); assert.equal(ev.host, 'api.open-meteo.com'); assert.equal(ev.ok, true); assert.equal(ev.cached, false);
  assert.equal(typeof ev.ms, 'number');
});

test('fetcher: redirect to another host refused; same-host redirect followed', async () => {
  const A = 'https://en.wikipedia.org/wiki/A';
  const B = 'https://en.wikipedia.org/wiki/B';
  const { fetcher, fetch } = setup({ table: {
    [W]: () => new Response('', { status: 302, headers: { location: 'https://evil.com/steal' } }),
    [A]: () => new Response('', { status: 301, headers: { location: '/wiki/B' } }),
    [B]: 'final',
  } });
  await assert.rejects(fetcher.getText('weather', W), /redirect.*refused|refused/i);
  assert.equal(fetch.calls.filter(c => c.url.includes('evil')).length, 0);
  const r = await fetcher.getText('wiki', A);
  assert.equal(r.data, 'final');
});

test('fetcher: timeout → error', async () => {
  const { fetcher } = setup({ timeoutMs: 30, table: { [W]: (u, o) => new Promise((res, rej) => o.signal.addEventListener('abort', () => rej(o.signal.reason))) } });
  await assert.rejects(fetcher.getJson('weather', W), /timed out/i);
});

test('fetcher: response over the size cap → error', async () => {
  const big = 'x'.repeat(5000);
  const { fetcher } = setup({ maxBytes: 4096, table: { [W]: big, 'https://en.wikipedia.org/x': () => new Response(big, { headers: { 'content-length': '5000' } }) } });
  await assert.rejects(fetcher.getText('weather', W), /too large/i);
  await assert.rejects(fetcher.getText('wiki', 'https://en.wikipedia.org/x'), /too large/i);
  const { DEFAULT_MAX_BYTES } = require('../src/core/net/fetcher');
  assert.equal(DEFAULT_MAX_BYTES, 2 * 1024 * 1024);
});

test('fetcher: HTTP error status → error', async () => {
  const { fetcher } = setup({ table: { [W]: () => new Response('no', { status: 503 }) } });
  await assert.rejects(fetcher.getText('weather', W), /HTTP 503/);
});

test('fetcher: TTL cache hit (no fetch) and expiry', async () => {
  const { fetcher, fetch, clock, events } = setup({ table: { [W]: { n: 1 } } });
  await fetcher.getJson('weather', W, { ttlMs: 10 * 60000 });
  clock.t += 5 * 60000;
  const r = await fetcher.getJson('weather', W, { ttlMs: 10 * 60000 });
  assert.equal(fetch.calls.length, 1);
  assert.equal(r.cached, true);
  assert.equal(r.ageMs, 5 * 60000);
  assert.equal(events.filter(e => e.type === 'net').at(-1).cached, true);
  assert.equal(events.filter(e => e.type === 'net').at(-1).ageMs, 5 * 60000);
  clock.t += 6 * 60000;
  const r2 = await fetcher.getJson('weather', W, { ttlMs: 10 * 60000 });
  assert.equal(fetch.calls.length, 2);
  assert.equal(r2.cached, false);
});

test('fetcher: network error with disk cache → stale result with its age', async () => {
  const dir = tmp();
  const a = setup({ cacheDir: dir, table: { [W]: { temp: 71 } } });
  await a.fetcher.getJson('weather', W, { ttlMs: 60000 });
  // a fresh process (empty memory) with the network down, 2 hours later
  const b = setup({ cacheDir: dir, table: {} });
  b.clock.t = a.clock.t + 2 * 3600000;
  const r = await b.fetcher.getJson('weather', W, { ttlMs: 60000 });
  assert.deepEqual(r.data, { temp: 71 });
  assert.equal(r.cached, true);
  assert.equal(r.stale, true);
  assert.equal(r.ageMs, 2 * 3600000);
  const ev = b.events.filter(e => e.type === 'net').at(-1);
  assert.equal(ev.ok, false); assert.equal(ev.stale, true);
  assert.equal(ev.ageMs, 2 * 3600000);
});

test('fetcher: network error with no cache → error', async () => {
  const { fetcher } = setup({ table: {} });
  await assert.rejects(fetcher.getJson('weather', W), /fetch failed|could not reach/i);
});

test('fetcher: switch off never serves from cache silently as live', async () => {
  let c = cfg();
  const dir = tmp();
  const events = [];
  const fetcher = createFetcher({ policy: createPolicy(() => c), fetch: fakeFetch({ [W]: { a: 1 } }), bus: { emit: (t, p) => events.push(p) }, cacheDir: dir, now: () => 1 });
  await fetcher.getJson('weather', W, { ttlMs: 60000 });
  c = cfg({ online: { enabled: false } });
  await assert.rejects(fetcher.getJson('weather', W, { ttlMs: 60000 }), /online lookups are off/i);
});
