// A real fetcher (policy, cache, events) over a fake fetch that answers from fixtures by URL regex.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPolicy } = require('../../src/core/net/policy');
const { createFetcher } = require('../../src/core/net/fetcher');
const { DEFAULTS } = require('../../src/core/config');

const FIX = path.join(__dirname, '..', 'fixtures');
const fixture = name => fs.readFileSync(path.join(FIX, name), 'utf8');

// routes: [[RegExp, 'fixture.json' | string body | (url) => Response | Error]]
function fakeNet(routes = [], { config = DEFAULTS, start = Date.parse('2026-11-10T07:00:00Z') } = {}) {
  const calls = [];
  const events = [];
  const clock = { t: start };
  const state = { down: false };
  const fetch = async url => {
    calls.push(url);
    if (state.down) throw new TypeError('fetch failed');
    for (const [re, h] of routes) {
      if (!re.test(url)) continue;
      if (typeof h === 'function') { const r = await h(url); if (r instanceof Error) throw r; return r; }
      const body = /\.(json|xml|html)$/.test(h) && fs.existsSync(path.join(FIX, h)) ? fixture(h) : h;
      return new Response(body, { status: 200 });
    }
    throw new TypeError('fetch failed');
  };
  let cfg = config;
  const fetcher = createFetcher({
    policy: createPolicy(() => cfg), fetch, now: () => clock.t,
    bus: { emit: (type, p) => events.push({ type, ...p }) },
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'jc-fake-')),
  });
  return { fetcher, calls, events, clock, setConfig: c => { cfg = c; }, setDown: v => { state.down = v; } };
}

module.exports = { fakeNet, fixture, FIX };
