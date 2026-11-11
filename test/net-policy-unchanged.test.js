// Cortex wave 3 §6 net-policy-unchanged: nothing in the cortex path opens a socket. The allowlist tests themselves
// (net.test.js, web.test.js) run unchanged. Here: no module on the cortex path loads a network module or calls fetch,
// and a full write/find/reuse/timer round with every network entry point trapped makes no network call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'src', 'core');
const CORTEX_PATH = [
  ...fs.readdirSync(path.join(ROOT, 'cortex')).filter(f => f.endsWith('.js') && f !== 'embedder.js').map(f => path.join(ROOT, 'cortex', f)),
  path.join(ROOT, 'knowledge', 'store.js'), path.join(ROOT, 'timers', 'cortex-store.js'), path.join(ROOT, 'timers', 'import.js'),
];
const NET = /require\(\s*['"](?:node:)?(?:net|http|https|tls|dgram|http2)['"]\s*\)|\bfetch\s*\(/;

test('net-policy-unchanged: no cortex-path module loads a network module or calls fetch', () => {
  for (const f of CORTEX_PATH) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), NET, path.relative(ROOT, f));
});

test('net-policy-unchanged: a knowledge and timer round opens no socket', async () => {
  const net = require('node:net'), http = require('node:http'), https = require('node:https');
  const calls = [];
  const trap = name => () => { calls.push(name); throw new Error('network used: ' + name); };
  const saved = { fetch: globalThis.fetch, connect: net.Socket.prototype.connect, http: http.request, https: https.request };
  globalThis.fetch = trap('fetch'); net.Socket.prototype.connect = trap('socket'); http.request = trap('http'); https.request = trap('https');
  try {
    const { open } = require('../src/core/cortex');
    const { createKnowledgeStore } = require('../src/core/knowledge/store');
    const { createCortexTimerStore } = require('../src/core/timers/cortex-store');
    const cortex = open({});
    const k = createKnowledgeStore({ cortex });
    k.save({ key: 'kn:wikipedia.org:rome', host: 'wikipedia.org', title: 'Rome', url: 'https://en.wikipedia.org/wiki/Rome', text: 'Rome is the capital city of Italy.', sourceKind: 'wiki', ttlClass: 'stable', tool: 'lookup_knowledge' });
    const hit = await k.find('capital of italy rome');
    assert.ok(hit);
    k.reused(hit, 'lookup_knowledge');
    const s = createCortexTimerStore({ cortex });
    s.remove(s.add({ kind: 'timer', label: 'tea', due: Date.now() + 1e5, created: Date.now() }).id);
    cortex.close();
  } finally {
    globalThis.fetch = saved.fetch; net.Socket.prototype.connect = saved.connect; http.request = saved.http; https.request = saved.https;
  }
  assert.deepEqual(calls, []);
});
