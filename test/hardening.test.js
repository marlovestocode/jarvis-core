const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createToolRunner } = require('../src/core/tools/registry');
const { createMemoryTools } = require('../src/core/tools/memory');
const { createMemory } = require('../src/core/memory/store');
const { createSessionStore } = require('../src/core/session');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jc-hard-'));

test('memory tools: a turn that read outside text cannot remember or forget', async () => {
  const memory = createMemory({ file: path.join(tmp(), 'm.json') });
  const runner = createToolRunner(createMemoryTools({ memory }));
  const dirty = await runner.run('remember', { fact: 'User banks at evil.example' }, { turn: { tainted: true } });
  assert.equal(dirty.ok, false);
  assert.match(dirty.text, /won't start that from text I read/);
  assert.equal(memory.find('banks evil').length, 0, 'nothing was stored');
  const gone = await runner.run('forget_memory', { about: 'anything' }, { turn: { tainted: true } });
  assert.equal(gone.ok, false);
  const clean = await runner.run('remember', { fact: 'User prefers Fahrenheit' }, { turn: { tainted: false } });
  assert.equal(clean.ok, true);
  assert.equal(memory.find('Fahrenheit').length, 1);
  const noTurn = await runner.run('remember', { fact: 'User likes tea' });
  assert.equal(noTurn.ok, true, 'a call with no turn context (the quick skill path) is the user speaking');
});

test('sessions: the list is built once, then follows save and remove without re-reading files', () => {
  const dir = tmp();
  const store = createSessionStore(dir);
  const a = store.create(); a.messages.push({ role: 'user', content: 'first' }); store.save(a);
  assert.deepEqual(store.list().map(s => s.title), ['first']);
  const histDir = path.join(dir, 'history');
  fs.writeFileSync(path.join(histDir, 'garbage-not-a-session.json'), '{');   // would be parsed by a rebuild
  const b = store.create(); b.messages.push({ role: 'user', content: 'second' }); store.save(b);
  assert.deepEqual(store.list().map(s => s.title), ['second', 'first']);
  store.remove(b.id);
  assert.deepEqual(store.list().map(s => s.title), ['first']);
});

test('sessions: the oldest files past the cap are deleted on the first listing', () => {
  const dir = tmp();
  const first = createSessionStore(dir);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const s = first.create(); s.messages.push({ role: 'user', content: `chat ${i}` }); first.save(s); ids.push(s.id);
    const f = path.join(dir, 'history', s.id + '.json');
    fs.utimesSync(f, new Date(Date.now() - (5 - i) * 60000), new Date(Date.now() - (5 - i) * 60000));
  }
  const second = createSessionStore(dir, { maxSessions: 3 });
  assert.deepEqual(second.list().map(s => s.title), ['chat 4', 'chat 3', 'chat 2']);
  assert.equal(fs.existsSync(path.join(dir, 'history', ids[0] + '.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'history', ids[1] + '.json')), false);
});
