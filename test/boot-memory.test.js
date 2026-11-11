const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionStore } = require('../src/core/session');
const { createMemorySkill } = require('../src/core/memory/skill');
const { createMemorySystem } = require('../src/core/memory/system');
const { createFakeEmbedder } = require('../src/core/cortex/embedder');

function boot({ installed = false, pulls = [], idle = true, complete } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jboot-'));
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify({ facts: [{ id: 'a', text: 'I prefer Fahrenheit', at: 1_690_000_000_000 }] }));
  const logs = [];
  let removedHook = () => {};
  const sessions = createSessionStore(dir, { onRemove: id => removedHook(id) });
  const state = { installed };
  const sys = createMemorySystem({
    dataDir: dir, log: m => logs.push(m), sessions, getConfig: () => ({ memory: { autoCapture: true, usePastChats: true }, cortex: { embedModel: 'nomic-embed-text' }, ollama: { host: 'http://127.0.0.1:11434' } }),
    isIdle: () => idle, notify: () => {}, complete: complete || (async () => '{}'), isUntrusted: () => false,
    makeEmbedder: () => ({ ...createFakeEmbedder({ dim: 64 }), status: async () => (state.installed ? { ok: true, model: 'nomic-embed-text' } : { ok: false, model: 'nomic-embed-text', reason: 'model_missing' }) }),
    pull: async model => { pulls.push(model); state.installed = true; return { ok: true }; },
  });
  removedHook = id => sys.onChatRemoved(id);
  return { dir, sys, sessions, logs, state, pulls };
}

test('boot-memory: memory.json is imported once and renamed; the fast path saves into the cortex', async () => {
  const { dir, sys } = boot();
  assert.equal(fs.existsSync(path.join(dir, 'memory.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'memory.json.imported.bak')), true);
  assert.deepEqual(sys.memory.list(), ['I prefer Fahrenheit']);
  const skill = createMemorySkill({ memory: sys.memory, about: t => sys.about(t) });
  assert.match((await skill.handle('remember that my dog is called Rex')).reply, /your dog is called Rex/);
  assert.equal(sys.cortex.node.list({ kind: 'fact' }).length, 2);
  assert.equal(sys.profile({}).text, 'my dog is called Rex; I prefer Fahrenheit');
  sys.close();
  // a second boot: nothing imported again, the facts are still there
  const again = createMemorySystem({ dataDir: dir, sessions: createSessionStore(dir), getConfig: () => ({ memory: {}, cortex: {}, ollama: {} }), complete: async () => '', makeEmbedder: () => null });
  assert.equal(again.memory.count(), 2);
  again.close();
});

test('boot-memory: keyword mode without the model; after install the cortex reopens with it and old nodes get vectors', async () => {
  const { sys, pulls } = boot({ installed: false });
  await sys.ready;
  assert.deepEqual(await sys.embedderStatus(), { model: 'nomic-embed-text', installed: false, mode: 'keyword', queue: 0, pulling: false });
  const r = await sys.installEmbedder();
  assert.equal(r.installed, true);
  assert.deepEqual(pulls, ['nomic-embed-text']);
  const st = await sys.embedderStatus();
  assert.equal(st.mode, 'hybrid');
  assert.equal(st.queue, 1, 'the imported fact waits for its vector');
  await sys.tick();
  assert.equal(sys.cortex.stats().vectors, 1);
  sys.close();
});

test('boot-memory: an installed model is used from the start', async () => {
  const { sys } = boot({ installed: true });
  await sys.ready;
  assert.equal((await sys.embedderStatus()).mode, 'hybrid');
  sys.close();
});

test('boot-memory: deleting a chat removes its summary node', async () => {
  const { sys, sessions } = boot();
  const s = sessions.create(); s.messages.push({ role: 'user', content: 'hi' }); sessions.save(s);
  sys.chats.upsertSummary({ sessionId: s.id, title: 'hi', n: 4, summary: 'We said hello', topics: [] });
  sessions.remove(s.id);
  assert.equal(sys.chats.find(s.id), null);
  sys.close();
});

test('boot-memory: the cortex check is ok, off without the model, a problem when read-only', async () => {
  const { sys } = boot({ installed: false });
  await sys.ready;
  const off = sys.check();
  assert.equal(off.level, 'off');
  assert.match(off.detail, /nomic-embed-text is not installed/);
  await sys.installEmbedder();
  const ok = sys.check();
  assert.equal(ok.level, 'ok');
  assert.match(ok.detail, /nodes/);
  sys.close();
  const broken = createMemorySystem({ dataDir: path.join(os.tmpdir(), 'nope'), sessions: { list: () => [], load: () => null }, getConfig: () => ({ memory: {}, cortex: {}, ollama: {} }), complete: async () => '', makeEmbedder: () => null, openCortex: () => require('../src/core/cortex').open({ file: fs.mkdtempSync(path.join(os.tmpdir(), 'jdir-')) }) });
  assert.equal(broken.check().level, 'bad');
  broken.close();
});

test('boot-memory: store.js is gone and nothing requires it', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '../src/core/memory/store.js')), false);
  const hits = [];
  const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith('.js') && /memory\/store['"]/.test(fs.readFileSync(p, 'utf8'))) hits.push(p); } };
  walk(path.join(__dirname, '../src'));
  walk(__dirname);
  assert.deepEqual(hits, []);
});

test('boot-memory: reopening with the embedder keeps the session marked unclean (crash detection stays on)', async () => {
  const { sys } = boot({ installed: true });
  await sys.ready;
  assert.equal(sys.cortex.meta.get('clean_close'), '0');
  sys.close();
});

test('boot-memory: a close before the embedder check finishes leaves no open cortex', async () => {
  const { sys } = boot({ installed: true });
  sys.close();
  await sys.ready;
  assert.throws(() => sys.cortex.stats());
});

test('boot-memory (wave 3): timers.json is imported into the cortex and the system timer store lists it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jboot3-'));
  const due = Date.now() + 3600e3;
  fs.writeFileSync(path.join(dir, 'timers.json'), JSON.stringify({ timers: [{ id: 'tkeep1', kind: 'reminder', label: 'water the plants', due, created: Date.now() }] }));
  const sys = createMemorySystem({ dataDir: dir, sessions: createSessionStore(dir), getConfig: () => ({ memory: {}, cortex: {}, ollama: {} }), complete: async () => '', makeEmbedder: () => null });
  assert.equal(fs.existsSync(path.join(dir, 'timers.json')), false);
  assert.deepEqual(sys.timerStore.list().map(t => [t.id, t.label, t.due]), [['tkeep1', 'water the plants', due]]);
  const t = sys.timerStore.add({ kind: 'timer', label: 'tea', due: Date.now() + 60e3, created: Date.now() });
  sys.close();
  const again = createMemorySystem({ dataDir: dir, sessions: createSessionStore(dir), getConfig: () => ({ memory: {}, cortex: {}, ollama: {} }), complete: async () => '', makeEmbedder: () => null });
  assert.deepEqual(again.timerStore.list().map(x => x.id).sort(), ['tkeep1', t.id].sort());
  again.close();
});

test('boot-memory (wave 3): the knowledge store is built on the same cortex', async () => {
  const { sys } = boot();
  const r = sys.knowledge.save({ key: 'kn:wikipedia.org:rome', host: 'wikipedia.org', title: 'Rome', url: 'https://en.wikipedia.org/wiki/Rome', text: 'Rome is the capital city of Italy.', sourceKind: 'wiki', ttlClass: 'stable', tool: 'lookup_knowledge' });
  assert.ok(r.id);
  assert.equal(sys.cortex.node.get(r.id).kind, 'knowledge');
  assert.equal((await sys.knowledge.find('capital of italy rome'))?.id, r.id);
  sys.close();
});

test('boot-memory (wave 3): main.js takes the timer store and knowledge from the memory system', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.doesNotMatch(main, /require\('\.\.\/core\/timers\/store'\)/, 'timers.json is no longer opened by main');
  assert.match(main, /ctx\.timerStore = ctx\.memorySystem\.timerStore;/);
  assert.match(main, /defaultCatalog\(\{[^\n]*knowledge: ctx\.memorySystem\.knowledge/);
});
