const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open } = require('../src/core/cortex');
const { importMemoryJson } = require('../src/core/memory/import');

function setup(facts, raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmemi-'));
  const file = path.join(dir, 'memory.json');
  fs.writeFileSync(file, raw ?? JSON.stringify({ facts }));
  const cortex = open({ file: path.join(dir, 'cortex.db') });
  const logs = [];
  return { dir, file, cortex, logs, log: m => logs.push(m) };
}
const V1 = [
  { id: 'a', text: 'I prefer Fahrenheit', at: 1_690_000_000_000 },
  { id: 'b', text: 'Rex is my dog', at: 1_695_000_000_000 },
];

test('memory-import: v1 → active profile nodes with an import source', () => {
  const { file, cortex, log } = setup(V1);
  const r = importMemoryJson({ cortex, file, log });
  assert.deepEqual(r, { imported: 2, skipped: 0 });
  const nodes = cortex.node.list({ kind: 'fact', order: 'created' });
  assert.deepEqual(nodes.map(n => n.text).sort(), ['I prefer Fahrenheit', 'Rex is my dog']);
  for (const n of nodes) {
    assert.equal(n.status, 'active');
    assert.equal(n.data.tier, 'profile');
    const s = cortex.node.get(n.id).sources[0];
    assert.equal(s.kind, 'import'); assert.equal(s.trust, 100); assert.equal(s.ref, 'memory.json');
  }
  assert.equal(nodes.find(n => n.text === 'Rex is my dog').created, 1_695_000_000_000);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(file + '.imported.bak'), true);
  assert.ok(cortex.meta.get('import_memory'));
});

test('memory-import: idempotent (second run imports 0)', () => {
  const { file, cortex, log } = setup(V1);
  importMemoryJson({ cortex, file, log });
  fs.writeFileSync(file, JSON.stringify({ facts: V1 }));   // the file comes back somehow
  const r = importMemoryJson({ cortex, file, log });
  assert.equal(r.imported, 0);
  assert.equal(r.already, true);
  assert.equal(cortex.node.list({ kind: 'fact' }).length, 2);
});

test('memory-import: crash after commit before rename → rename only', () => {
  const { dir, file, cortex, log } = setup(V1);
  cortex.meta.set('import_memory', '123');   // the transaction committed, then the app died
  fs.writeFileSync(file + '.imported.bak', 'older');
  const r = importMemoryJson({ cortex, file, log });
  assert.deepEqual(r, { imported: 0, skipped: 0, already: true });
  assert.equal(cortex.node.list({ kind: 'fact' }).length, 0);
  assert.equal(fs.existsSync(file), false);
  const baks = fs.readdirSync(dir).filter(f => f.endsWith('.imported.bak'));
  assert.equal(baks.length, 2, 'an existing .bak is kept; the new one gets a stamp');
});

test('memory-import: secret, empty and malformed facts skipped and counted', () => {
  const { file, cortex, log } = setup([...V1, { text: 'my password is hunter2' }, { text: '' }, null, { text: 42 }, { text: 'x'.repeat(400) }]);
  const r = importMemoryJson({ cortex, file, log });
  assert.deepEqual(r, { imported: 2, skipped: 5 });
});

test('memory-import: corrupt JSON → nothing imported, file moved to broken/, logged', () => {
  const { dir, file, cortex, logs, log } = setup(null, '{ not json');
  const r = importMemoryJson({ cortex, file, log });
  assert.equal(r.imported, 0);
  assert.equal(r.broken, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(path.join(dir, 'broken')).length, 1);
  assert.ok(logs.some(m => /memory\.json/.test(m)));
  assert.equal(cortex.meta.get('import_memory'), null, 'a later good file could still be imported');
});

test('memory-import: missing file → imported 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmemi-'));
  const cortex = open({});
  assert.deepEqual(importMemoryJson({ cortex, file: path.join(dir, 'memory.json') }), { imported: 0, skipped: 0 });
});

test('memory-import: marker missing but an .imported.bak exists (cortex recovered empty) → re-imported from the .bak', () => {
  const { dir, file, cortex, log } = setup(V1);
  fs.renameSync(file, file + '.imported.bak');
  fs.writeFileSync(file + '.1700000000000.imported.bak', JSON.stringify({ facts: [{ text: 'an older copy' }] }));
  fs.utimesSync(file + '.1700000000000.imported.bak', new Date(Date.now() - 864e5), new Date(Date.now() - 864e5));
  const r = importMemoryJson({ cortex, file, log });
  assert.equal(r.imported, 2);
  assert.equal(r.from, 'memory.json.imported.bak');
  assert.ok(fs.existsSync(file + '.imported.bak'), 'the .bak stays where it is');
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.imported.bak')).length, 2);
  assert.equal(importMemoryJson({ cortex, file, log }).imported, 0, 'marker set now');
});

test('memory-import: a cortex running in memory imports nothing and leaves memory.json alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmemi-'));
  const file = path.join(dir, 'memory.json');
  fs.writeFileSync(file, JSON.stringify({ facts: V1 }));
  const cortex = open({ file: dir });   // a folder: cannot hold a database → in memory, health().ok false
  assert.equal(cortex.health().ok, false);
  const r = importMemoryJson({ cortex, file });
  assert.deepEqual(r, { imported: 0, skipped: 0, unavailable: true });
  assert.ok(fs.existsSync(file));
  assert.equal(cortex.node.list({ kind: 'fact' }).length, 0);
});
