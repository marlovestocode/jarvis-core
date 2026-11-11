const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/core/cortex/db');
const defaultMigrations = require('../src/core/cortex/migrations');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jcortex-')), 'cortex.db');
const now = 1_700_000_000_000;

function addNode(db, text = 'Rex is my dog') {
  return Number(db.stmt('INSERT INTO node(kind, text, created, updated) VALUES (?, ?, ?, ?)').run('fact', text, now, now).lastInsertRowid);
}

test('cortex-db: pragmas set on a file', () => {
  const db = openDb({ file: tmpFile() });
  assert.equal(db.raw.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(db.raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.raw.prepare('PRAGMA mmap_size').get().mmap_size, 0);
  db.close();
});

test('cortex-db: migrations apply once', () => {
  const file = tmpFile();
  const a = openDb({ file });
  assert.equal(a.version, 1);
  assert.equal(a.readOnly, false);
  a.close();
  const b = openDb({ file });
  assert.equal(b.version, 1);
  assert.equal(b.readOnly, false);
  b.close();
});

test('cortex-db: failed migration rolls back and opens read-only', () => {
  const file = tmpFile();
  openDb({ file }).close();
  const logs = [];
  const bad = { version: 2, name: 'bad', up(raw) { raw.exec('CREATE TABLE x(a)'); throw new Error('boom'); } };
  const db = openDb({ file, migrations: [...defaultMigrations, bad], log: m => logs.push(m) });
  assert.equal(db.readOnly, true);
  assert.equal(db.version, 1);
  assert.equal(db.raw.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'x'").get().n, 0);
  assert.ok(logs.some(l => /boom/.test(l)));
  assert.throws(() => addNode(db));
  db.close();
});

test('cortex-db: cascade delete removes provenance, edges and vector', () => {
  const db = openDb({ file: ':memory:' });
  const a = addNode(db), b = addNode(db, 'Rex likes the park');
  const s = Number(db.stmt('INSERT INTO source(kind, trust, ref, at) VALUES (?, ?, ?, ?)').run('user', 100, 's1', now).lastInsertRowid);
  db.stmt('INSERT INTO provenance(node_id, source_id, at) VALUES (?, ?, ?)').run(a, s, now);
  db.stmt('INSERT INTO edge(src, dst, type, weight, created, last_used) VALUES (?, ?, ?, ?, ?, ?)').run(a, b, 'mentions', 0.5, now, now);
  db.stmt('INSERT INTO edge(src, dst, type, weight, created, last_used) VALUES (?, ?, ?, ?, ?, ?)').run(b, a, 'mentions', 0.5, now, now);
  db.stmt('INSERT INTO vec(node_id, dim, scale, v) VALUES (?, ?, ?, ?)').run(a, 2, 0.01, new Uint8Array([1, 2]));
  db.stmt('DELETE FROM node WHERE id = ?').run(a);
  for (const t of ['provenance', 'edge', 'vec']) assert.equal(db.raw.prepare(`SELECT count(*) n FROM ${t}`).get().n, 0, t);
  db.close();
});

test('cortex-db: fts triggers keep the index current', () => {
  const db = openDb({ file: ':memory:' });
  const match = q => db.raw.prepare('SELECT rowid FROM node_fts WHERE node_fts MATCH ?').all(q).map(r => r.rowid);
  const id = addNode(db, 'Rex has a vet visit');
  assert.deepEqual(match('"vet"'), [id]);
  db.stmt('UPDATE node SET text = ? WHERE id = ?').run('Rex goes to the groomer', id);
  assert.deepEqual(match('"vet"'), []);
  assert.deepEqual(match('"groomer"'), [id]);
  db.stmt('DELETE FROM node WHERE id = ?').run(id);
  assert.deepEqual(match('"groomer"'), []);
  db.close();
});

test('cortex-db: tx commits, rolls back on throw, and nests', () => {
  const db = openDb({ file: ':memory:' });
  db.tx(() => { addNode(db, 'one fact'); db.tx(() => addNode(db, 'two fact')); });
  assert.throws(() => db.tx(() => { addNode(db, 'three fact'); throw new Error('no'); }));
  db.tx(() => { addNode(db, 'four fact'); try { db.tx(() => { addNode(db, 'five fact'); throw new Error('inner'); }); } catch { /* inner only */ } });
  const texts = db.raw.prepare('SELECT text FROM node ORDER BY id').all().map(r => r.text);
  assert.deepEqual(texts, ['one fact', 'two fact', 'four fact']);
  db.close();
});

test('cortex-db: stmt cache returns the same prepared statement', () => {
  const db = openDb({ file: ':memory:' });
  assert.equal(db.stmt('SELECT 1'), db.stmt('SELECT 1'));
  db.close();
});

test('cortex-db: corrupt file is quarantined and the newest backup restored', () => {
  const cortexLib = require('../src/core/cortex');
  const file = tmpFile(), dir = path.dirname(file);
  const a = cortexLib.open({ file });
  const s = a.source.add({ kind: 'user', ref: 'x' });
  a.node.upsert({ kind: 'fact', text: 'Rex is my dog', source: s });
  a.backup();
  a.node.upsert({ kind: 'fact', text: 'written after the backup', source: s });
  a.close();
  fs.writeFileSync(file, Buffer.alloc(8192, 0x5a));   // garbage over the db
  const logs = [];
  const b = cortexLib.open({ file, log: m => logs.push(m) });
  assert.equal(b.health().ok, true);
  assert.equal(b.health().restoredFrom !== null, true);
  assert.deepEqual(b.node.list({ kind: 'fact' }).map(n => n.text), ['Rex is my dog']);
  assert.ok(fs.readdirSync(path.join(dir, 'broken')).length >= 1);
  b.close();
});

test('cortex-db: corrupt file with no backup starts empty and marks it', () => {
  const cortexLib = require('../src/core/cortex');
  const file = tmpFile();
  fs.writeFileSync(file, Buffer.alloc(8192, 0x5a));
  const c = cortexLib.open({ file });
  assert.equal(c.stats().nodes, 0);
  assert.ok(c.health().recoveredEmpty > 0);
  c.close();
});

test('cortex-db: after a clean close the full check is skipped; after a crash it runs', () => {
  const cortexLib = require('../src/core/cortex');
  const file = tmpFile();
  cortexLib.open({ file }).close();
  const a = cortexLib.open({ file });
  assert.equal(a.health().quickCheck, 'skipped');           // clean close before
  const b = cortexLib.open({ file });                       // a is still open: as after a crash
  assert.equal(b.health().quickCheck, 'ok');
  b.close(); a.close();
});

test('cortex-db: a failed daily check forces the full check at the next boot', () => {
  const cortexLib = require('../src/core/cortex');
  const file = tmpFile();
  cortexLib.open({ file }).close();
  const raw = openDb({ file });
  raw.stmt("INSERT INTO meta(key, value) VALUES ('check_failed', '1')").run();
  raw.close();
  const c = cortexLib.open({ file });
  assert.equal(c.health().quickCheck, 'ok');
  c.close();
});

test('cortex-db: open never throws on an unusable path', () => {
  const cortexLib = require('../src/core/cortex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jcortex-'));
  const asDir = path.join(dir, 'cortex.db');
  fs.mkdirSync(asDir);                                  // a folder where the file should be
  const c = cortexLib.open({ file: asDir });
  assert.equal(c.health().ok, false);
  const s = c.source.add({ kind: 'user', ref: 'x' });   // degraded but usable (in memory)
  assert.equal(c.node.upsert({ kind: 'fact', text: 'Rex is my dog', source: s }).created, true);
  c.close();
});

test('cortex-db: only db.js requires node:sqlite', () => {
  const hits = [];
  const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith('.js') && /node:sqlite/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(path.join(__dirname, '..'), p).replace(/\\/g, '/')); } };
  walk(path.join(__dirname, '..', 'src'));
  assert.deepEqual(hits, ['src/core/cortex/db.js']);
});
