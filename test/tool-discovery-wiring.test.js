const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionStore } = require('../src/core/session');
const { createMemorySystem } = require('../src/core/memory/system');
const { createFakeEmbedder } = require('../src/core/cortex/embedder');

function boot(makeEmbedder) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jtd-'));
  const sys = createMemorySystem({
    dataDir: dir, log: () => {}, sessions: createSessionStore(dir), getConfig: () => ({ memory: {}, cortex: { embedModel: 'nomic-embed-text' }, ollama: {} }),
    complete: async () => '', makeEmbedder,
  });
  return { dir, sys };
}

test('memorySystem.embed rejects without an embedder and delegates with one', async () => {
  const a = boot(() => null);
  await assert.rejects(() => a.sys.embed(['x'], { role: 'query' }), /no embedder/);
  a.sys.close(); fs.rmSync(a.dir, { recursive: true, force: true });
  const b = boot(() => createFakeEmbedder({ dim: 64 }));
  await b.sys.ready;
  const v = await b.sys.embed(['hello'], { role: 'query' });
  assert.equal(v.length, 1);
  assert.equal(v[0].length, 64);
  b.sys.close(); fs.rmSync(b.dir, { recursive: true, force: true });
});

test('main.js wires the tool index and the embedder into the orchestrator and the runner', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');
  const call = src.slice(src.indexOf('createOrchestrator({'));
  assert.match(call.slice(0, 600), /toolIndex/);
  assert.match(call.slice(0, 600), /embed:\s*\(?/);
  assert.match(src, /createToolRunner\([^)]*toolIndex/);
});
