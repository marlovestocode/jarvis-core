// Scenarios for test/ext-background.test.js, one per process (node test/helpers/ext-bg-scenarios.js <name>): the worker keeps module
// state and timers, so two runs in one process would see each other's sockets.
// extension/background.js runs for real against a fake `chrome` and a fake WebSocket that the scenario controls.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mock } = require('node:test');

const KEY = 'ab'.repeat(32);
const hmac = (...p) => crypto.createHmac('sha256', KEY).update(p.join('|')).digest('hex');
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
// with timers and Date mocked there is no clock to wait on: wait for the condition by turning the event loop
const spin = async (cond, max = 20000) => { for (let i = 0; i < max && !(await cond()); i++) await new Promise(r => setImmediate(r)); };
const flush = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function install({ accept = port => port === 47831 } = {}) {
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url; this.port = Number(/:(\d+)\//.exec(url)[1]); this.readyState = 0; this.sent = []; sockets.push(this);
      queueMicrotask(() => { if (accept(this.port)) { this.readyState = 1; this.onopen?.(); } else { this.readyState = 3; this.onerror?.(new Error('refused')); } });
    }
    send(d) { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(JSON.parse(d)); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
    serverSend(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  }
  const mem = { local: { linkKey: KEY }, session: {} };
  const area = o => ({ get: async k => (typeof k === 'string' ? { [k]: o[k] } : { ...o }), set: async v => { await new Promise(r => setImmediate(r)); Object.assign(o, JSON.parse(JSON.stringify(v))); } });
  const listeners = [], badge = [];
  globalThis.WebSocket = FakeWebSocket;
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: '9.9.9' }), onStartup: { addListener() {} }, onInstalled: { addListener() {} }, onMessage: { addListener: fn => listeners.push(fn) } },
    storage: { local: area(mem.local), session: area(mem.session) },
    alarms: { create() {}, get: async () => ({}), onAlarm: { addListener() {} } },
    action: { setBadgeText: o => badge.push(o.text), setBadgeBackgroundColor() {} },
    tabs: { query: async () => [], create: async () => ({ id: 1 }), get: async () => ({ status: 'complete' }), onUpdated: { addListener() {}, removeListener() {} } },
    scripting: { executeScript: async () => [{ result: true }] },
    windows: { update: async () => {} },
  };
  const message = (m, sender = {}) => new Promise(res => { let replied = false; const reply = v => { replied = true; res(v); }; let isAsync = false; for (const l of listeners) { if (l(m, sender, reply) === true) isAsync = true; } if (!isAsync && !replied) res(undefined); });
  return { sockets, mem, message, badge };
}

async function boot(opts) {
  const env = install(opts);
  await import(pathToFileURL(path.join(__dirname, '../../extension/background.js')).href);
  return env;
}
async function until(fn, ms = 1500) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await tick(5); } return fn(); }

async function handshake(env) {
  const sock = await until(() => env.sockets.find(s => s.port === 47831 && s.readyState === 1));
  assert.ok(sock, 'dialled the open port');
  sock.serverSend({ type: 'challenge', nonce: 'srvnonce' });
  const hello = await until(() => sock.sent.find(m => m.type === 'hello'));
  assert.ok(hello, 'answered the challenge');
  assert.equal(hello.proof, hmac('ext', 47831, 'srvnonce'), 'the proof names the port and the challenge');
  assert.equal(hello.version, '9.9.9');
  sock.serverSend({ type: 'auth', proof: hmac('srv', 47831, 'srvnonce', hello.nonce) });
  await until(async () => (await env.message({ type: 'status' })).connected);
  return sock;
}

const scenarios = {
  async ports() {
    const env = await boot();
    const sock = await handshake(env);
    assert.equal((await env.message({ type: 'status' })).port, 47831);
    await tick(20);
    assert.equal(env.sockets.filter(s => s.readyState === 1).length, 1, 'the other ports are refused or closed');
    const act = await env.message({ type: 'activity' });
    assert.match(act.at(-1).text, /Connected to JARVIS \(port 47831\)/);
    sock.close();
  },

  async wrongProof() {
    const env = await boot();
    const sock = await until(() => env.sockets.find(s => s.port === 47831 && s.readyState === 1));
    sock.serverSend({ type: 'challenge', nonce: 'n1' });
    const hello = await until(() => sock.sent.find(m => m.type === 'hello'));
    sock.serverSend({ type: 'auth', proof: hmac('srv', 47831, 'n1', hello.nonce + 'x') });
    await tick(40);
    const st = await env.message({ type: 'status' });
    assert.equal(st.connected, false);
    assert.match(st.lastError || '', /does not match/);
  },

  async commands() {
    const env = await boot();
    const sock = await handshake(env);
    sock.serverSend({ id: 7, cmd: 'hello', args: {} });
    const answer = await until(() => sock.sent.find(m => m.id === 7));
    assert.deepEqual(answer, { id: 7, ok: true, result: { version: '9.9.9' } });
    sock.serverSend({ id: 8, cmd: 'browser_tab_open', args: { url: 'file:///C:/secret.txt' } });
    const refused = await until(() => sock.sent.find(m => m.id === 8));
    assert.equal(refused.ok, false);
    const act = await env.message({ type: 'activity' });
    const cmd = act.filter(e => e.kind === 'command');
    assert.equal(cmd.length, 2);
    assert.equal(cmd[0].ok, true); assert.ok(cmd[0].ms >= 0);
    assert.match(cmd[1].text, /browser_tab_open · file:\/\/\/C:\/secret\.txt failed: Only http and https/);
    assert.ok(env.badge.includes('•') && env.badge.includes('!'), 'the toolbar badge flashed for both');
    sock.close();
  },

  async prompts() {
    const env = await boot();
    const sock = await handshake(env);
    // only the music tab's own page may report
    await env.message({ type: 'prompt-confirmed', kind: 'still-listening', label: 'Yes' }, { url: 'https://evil.example/' });
    await env.message({ type: 'prompt-confirmed', kind: 'still-listening', label: 'Yes' }, { url: 'https://music.youtube.com/watch?v=1', tab: { id: 3 } });
    await env.message({ type: 'prompt-skipped', kind: 'age-confirm', reason: 'needs the account' }, { url: 'https://music.youtube.com/', tab: { id: 3 } });
    await tick(20);
    const act = await env.message({ type: 'activity' });
    const pr = act.filter(e => e.kind === 'prompt');
    assert.equal(pr.length, 2, 'the page that is not YouTube Music is ignored');
    assert.match(pr[0].text, /Confirmed the still-listening prompt \("Yes"\)/); assert.equal(pr[0].ok, true);
    assert.match(pr[1].text, /Left the age notice alone: needs the account/); assert.equal(pr[1].ok, false);
    const sent = sock.sent.filter(m => m.type === 'prompt');
    assert.deepEqual(sent.map(m => [m.kind, m.confirmed]), [['still-listening', true], ['age-confirm', false]]);
    sock.close();
  },

  async pendingPlays() {
    const env = await boot({ accept: () => false });   // JARVIS is not running
    await tick(30);
    const plays = Array.from({ length: 12 }, (_, i) => ({ videoId: 'v' + i, startedAt: i }));
    await Promise.all(plays.map(p => env.message({ type: 'play-log', event: p })));   // twelve at the same moment
    await until(() => env.mem.local.pending?.length === 12, 3000);
    assert.deepEqual(env.mem.local.pending.map(p => p.videoId).sort(), plays.map(p => p.videoId).sort(), 'no play lost to a racing read-modify-write');
  },

  async silence() {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const env = await boot();
    await flush();
    await spin(() => env.sockets.find(s => s.port === 47831 && s.readyState === 1));
    const sock = env.sockets.find(s => s.port === 47831 && s.readyState === 1);
    assert.ok(sock, 'dialled');
    sock.serverSend({ type: 'challenge', nonce: 'm1' });
    await spin(() => sock.sent.find(m => m.type === 'hello'));
    const hello = sock.sent.find(m => m.type === 'hello');
    assert.ok(hello, 'hello sent');
    sock.serverSend({ type: 'auth', proof: hmac('srv', 47831, 'm1', hello.nonce) });
    await spin(async () => (await env.message({ type: 'status' })).connected);
    assert.equal((await env.message({ type: 'status' })).connected, true);
    mock.timers.tick(20000);   // a ping goes out
    assert.ok(sock.sent.some(m => m.type === 'ping'));
    sock.serverSend({ type: 'pong' });   // it answers: alive
    mock.timers.tick(20000); mock.timers.tick(20000);   // 40 s of silence after the pong: still under the limit
    assert.equal(sock.readyState, 1);
    mock.timers.tick(20000);   // 60 s since it last said anything
    assert.equal(sock.readyState, 3, 'closed because it stopped answering');
    await flush();
    const act = await env.message({ type: 'activity' });
    assert.ok(act.some(e => /stopped answering/.test(e.text)));
  },
};

const name = process.argv[2];
if (!scenarios[name]) { console.error('unknown scenario ' + name); process.exit(2); }
scenarios[name]().then(() => process.exit(0), err => { console.error(err?.stack || err); process.exit(1); });
