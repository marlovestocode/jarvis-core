const test = require('node:test');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createYtMusicTool } = require('../src/core/tools/media');

test('queue_random says so when fewer songs were added than asked', async () => {
  const tool = createYtMusicTool({ ytm: { connected: true, queueRandom: async () => ({ ok: true, added: [{ title: 'A', artist: 'X' }, { title: 'B', artist: 'X' }], failed: 3 }) } });
  const r = await tool.run({ action: 'queue_random', query: 'x', count: 5 });
  assert.match(r, /Added 2 of 5 random songs/);
  assert.match(r, /Only 2 of the 5/);
});

test('queue_random with everything added has no shortfall note', async () => {
  const tool = createYtMusicTool({ ytm: { connected: true, queueRandom: async () => ({ ok: true, added: [{ title: 'A', artist: 'X' }], failed: 0 }) } });
  const r = await tool.run({ action: 'queue_random', query: 'x', count: 1 });
  assert.doesNotMatch(r, /Only|of 1/);
});

// ---- browser: reload, groups, split view ----
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const loadExt = () => import(pathToFileURL(path.join(__dirname, '..', 'extension', 'browser.js')).href);
const chromeFake = (extra = {}) => ({
  permissions: { contains: async () => true },
  tabs: { reload: async () => {}, group: async () => 9, ungroup: async () => {}, get: async id => ({ id, splitViewId: 4 }), ...extra },
  tabGroups: { update: async () => {} },
});

test('extension: reload, group and ungroup validate and run', async () => {
  const { browserCommand } = await loadExt();
  assert.deepEqual(await browserCommand('browser_reload', { id: 3 }, chromeFake()), { id: 3 });
  assert.deepEqual(await browserCommand('browser_group', { ids: [1, 2], title: 'Work' }, chromeFake()), { groupId: 9, ids: [1, 2] });
  await assert.rejects(browserCommand('browser_group', { ids: [1, 1] }, chromeFake()), /each tab once/);
  await assert.rejects(browserCommand('browser_group', { ids: [] }, chromeFake()), /Bad ids/);
  assert.deepEqual(await browserCommand('browser_ungroup', { ids: [1] }, chromeFake()), { ids: [1] });
});

test('extension: split view needs Chrome 155 and says so otherwise', async () => {
  const { browserCommand } = await loadExt();
  await assert.rejects(browserCommand('browser_split', { ids: [1, 2] }, chromeFake()), /Chrome 155/);
  const r = await browserCommand('browser_split', { ids: [1, 2] }, chromeFake({ createSplit: async () => {} }));
  assert.deepEqual(r, { ids: [1, 2], splitViewId: 4 });
  await assert.rejects(browserCommand('browser_split', { ids: [1] }, chromeFake({ createSplit: async () => {} })), /Bad ids/);
});

test('extension manifest: version 1.7.0 with the tabGroups permission', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
  assert.equal(m.version, '1.7.0');
  assert.ok(m.permissions.includes('tabGroups'));
});

// ---- reliability: backoff ----
test('capture scheduler: a failed capture is not retried until its cooldown passes, and the wait grows', async () => {
  const { createCaptureScheduler } = require('../src/core/memory/scheduler');
  let t = 0, runs = 0;
  const msgs = [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' }];
  const sess = { id: 'a', messages: msgs, updated: 1 };
  const sc = createCaptureScheduler({
    sessions: { list: () => [{ id: 'a', updated: 0 }], load: () => sess },
    extractor: { run: async () => { runs++; throw new Error('Ollama is not running'); } },
    chats: { floor: () => 0, find: () => null },
    now: () => t, idleMs: 0,
  });
  await sc.tick(); assert.equal(runs, 1);
  t = 5000; await sc.tick(); assert.equal(runs, 1, 'still cooling after 5 s');
  t = 61000; await sc.tick(); assert.equal(runs, 2, 'retried after 60 s');
  t = 61000 + 60000; await sc.tick(); assert.equal(runs, 2, 'the second wait is 2 minutes');
  t = 61000 + 121000; await sc.tick(); assert.equal(runs, 3);
});

// ---- Wave 2: routing of history and self-knowledge phrases ----
test('routing: playback history goes to ytmusic, model and speed questions to self', () => {
  const { selectGroups } = require('../src/core/skills/select');
  const { loadGroups, buildCatalog } = require('../src/core/skills');
  const { toolDeps } = require('./helpers/tool-deps');
  const { route } = require('../src/core/brain/router');
  const catalog = buildCatalog(loadGroups(toolDeps()));
  assert.ok(selectGroups('what was the last song you played', {}, catalog).includes('ytmusic'));
  assert.ok(selectGroups('what songs did i just listen to', {}, catalog).includes('ytmusic'));
  assert.ok(selectGroups('what model are you running on', {}, catalog).includes('self'));
  assert.ok(selectGroups('how fast are you', {}, catalog).includes('self'));
  assert.ok(route('what model are you', {}).tools !== false);
});

test('self_config reports the model and the embedder it is given, or says none', async () => {
  const { createSelfTools } = require('../src/core/tools/self');
  const mk = about => createSelfTools({ getChecks: () => [], about: () => ({ version: '1', startedAt: 0, ...about }), logFile: '', dataDir: '' }).find(t => t.name === 'self_config');
  assert.match(await mk({ model: 'jarvis-worker8:latest', embedder: 'ollama:nomic-embed-text@768' }).run(), /Language model: jarvis-worker8:latest\. Memory embedder: ollama:nomic-embed-text@768/);
  assert.match(await mk({}).run(), /Language model: unknown\. Memory embedder: none \(keyword recall only\)/);
});

// ---- process_top ----
test('process_top: lists the heaviest apps by memory or by CPU time from the PC host', async () => {
  const { createGroup } = require('../src/core/skills/system');
  const { createFakePcHost } = require('./helpers/fake-pc-host');
  const host = createFakePcHost({ processes: [
    { name: 'chrome', count: 40, memMB: 3200, cpuSec: 5000 }, { name: 'code', count: 8, memMB: 1500, cpuSec: 9000 }, { name: 'notepad', count: 1, memMB: 40, cpuSec: 2 },
  ] });
  const tool = createGroup({ pc: { host } }).tools.find(t => t.name === 'process_top');
  assert.ok(tool);
  assert.equal(await tool.run({ count: 2 }), 'Top 2 by memory: 1. chrome (40 processes): 3.1 GB; 2. code (8 processes): 1.5 GB.');
  assert.match(await tool.run({ by: 'cpu', count: 1 }), /Top 1 by CPU time used so far: 1\. code \(8 processes\): 2 h 30 min of CPU time\./);
  assert.deepEqual(host.calls.filter(c => c[0] === 'processTop').map(c => c[1]), [{ by: 'memory', count: 2 }, { by: 'cpu', count: 1 }]);
  assert.equal(createGroup({}).tools.some(t => t.name === 'process_top'), false, 'no PC host, no tool');
});

test('process_top: the host client validates the sort and clamps the count', async () => {
  const { createPcHost } = require('../src/core/pc/host');
  const sent = [];
  const host = createPcHost({ spawn: () => { throw new Error('no spawn'); }, request: async (cmd, args) => { sent.push([cmd, args]); return [{ name: 'a', count: 2, memMB: 10, cpuSec: 1 }, null, { nope: 1 }]; } });
  await assert.rejects(host.processTop('disk', 3), /Bad sort/);
  const r = await host.processTop('cpu', 99);
  assert.deepEqual(sent[0], ['processTop', { by: 'cpu', count: 25 }]);
  assert.deepEqual(r, [{ name: 'a', count: 2, memMB: 10, cpuSec: 1 }]);
});

// ---- speakChatReplies ----
test('speech.speakChatReplies defaults off, round-trips through settings, and rejects a non-boolean', () => {
  const { DEFAULTS, loadConfig } = require('../src/core/config');
  const { applyPatch } = require('../src/core/settings');
  const { createRegistry } = require('../src/core/providers/provider');
  const { NullProvider } = require('../src/core/providers/null-provider');
  const { createEngineRegistries } = require('../src/core/voice/engines');
  const providers = createRegistry(); providers.add(NullProvider);
  const engines = createEngineRegistries();
  assert.equal(DEFAULTS.speech.speakChatReplies, false);
  const on = applyPatch(DEFAULTS, { speech: { speakChatReplies: true } }, { providers, engines });
  assert.equal(on.config.speech.speakChatReplies, true);
  assert.equal(on.errors.length, 0);
  const bad = applyPatch(DEFAULTS, { speech: { speakChatReplies: 'yes' } }, { providers, engines });
  assert.equal(bad.config.speech.speakChatReplies, false);
  assert.ok(bad.errors.length);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsp-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ speech: { speakChatReplies: true } }));
  assert.equal(loadConfig(dir).speech.speakChatReplies, true);
});

// ---- memory_list and "about me" ----
test('memory_list lists every saved fact; memory_about for the user themself does the same', async () => {
  const { createMemoryTools } = require('../src/core/tools/memory');
  const memory = { list: () => ['Prefers Fahrenheit', 'Cat is called Milo'], add: () => ({}), forget: () => ({ removed: [] }) };
  const cortex = { node: { find: () => null, get: () => null }, recall: async () => ({ items: [] }), neighbors: () => [] };
  const tools = Object.fromEntries(createMemoryTools({ memory, cortex }).map(t => [t.name, t]));
  assert.equal(await tools.memory_list.run(), 'Saved about the user (2): 1. Prefers Fahrenheit 2. Cat is called Milo');
  assert.match(await tools.memory_about.run({ topic: 'User' }), /Saved about the user \(2\)/);
  const none = Object.fromEntries(createMemoryTools({ memory: { list: () => [] }, cortex }).map(t => [t.name, t]));
  assert.equal(await none.memory_list.run(), 'Nothing is saved about the user yet.');
});
