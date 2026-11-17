const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStockmanDb, checkMigrations, coreMigrations } = require('../src/core/stockman/db');
const { createEventLog } = require('../src/core/stockman/db/events');
const { MigrationError } = require('../src/core/stockman/errors');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stockman-db-')), 'stockman.db');
const tables = db => db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);

test('stockman-db: a fresh file gets exactly the framework tables, WAL and foreign keys', () => {
  const db = openStockmanDb({ file: tmpFile() });
  assert.equal(db.version, 1);
  assert.deepEqual(tables(db), ['engine_event', 'meta']);
  assert.equal(db.raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.raw.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  db.close();
});

test('stockman-db: reopening applies nothing twice and keeps the data', () => {
  const file = tmpFile();
  const a = openStockmanDb({ file });
  a.stmt('INSERT INTO meta(key, value, updated) VALUES (?, ?, ?)').run('k', 'v', 1);
  a.close();
  const b = openStockmanDb({ file });
  assert.equal(b.version, 1);
  assert.equal(b.stmt('SELECT value FROM meta WHERE key = ?').get('k').value, 'v');
  b.close();
});

test('stockman-db: feature migrations run after the framework ones, once, in order', () => {
  const file = tmpFile();
  const feature = [
    { version: 3, name: 'second', up: raw => raw.exec('ALTER TABLE feat_a ADD COLUMN extra TEXT') },
    { version: 2, name: 'first', up: raw => raw.exec('CREATE TABLE feat_a(id INTEGER PRIMARY KEY)') },
  ];
  const a = openStockmanDb({ file, features: feature });
  assert.equal(a.version, 3);
  assert.deepEqual(a.raw.prepare('PRAGMA table_info(feat_a)').all().map(c => c.name), ['id', 'extra']);
  a.close();
  const b = openStockmanDb({ file, features: feature });   // nothing re-applied, so no "table exists" failure
  assert.equal(b.version, 3);
  b.close();
});

test('stockman-db: bad feature migrations are rejected before the file is touched', () => {
  const up = () => {};
  assert.throws(() => checkMigrations([{ version: 1, name: 'x', up }], { after: 1 }), MigrationError);                 // clashes with the framework
  assert.throws(() => checkMigrations([{ version: 2, name: 'x', up }, { version: 2, name: 'y', up }], { after: 1 }), /used twice/);
  assert.throws(() => checkMigrations([{ version: 2, name: '', up }], { after: 1 }), MigrationError);
  assert.throws(() => checkMigrations([{ version: 1.5, name: 'x', up }]), MigrationError);
  const file = tmpFile();
  assert.throws(() => openStockmanDb({ file, features: [{ version: 1, name: 'clash', up }] }), MigrationError);
  assert.equal(fs.existsSync(file), false);
});

test('stockman-db: a failing migration throws (never a silent read-only handle) and rolls back', () => {
  const file = tmpFile();
  const bad = [{ version: 2, name: 'boom', up: raw => { raw.exec('CREATE TABLE half(id INTEGER)'); throw new Error('boom'); } }];
  assert.throws(() => openStockmanDb({ file, features: bad }), /migration failed.*boom/s);
  const db = openStockmanDb({ file });   // the framework part stayed, the failed one left nothing behind
  assert.equal(db.version, 1);
  assert.ok(!tables(db).includes('half'));
  db.close();
});

test('stockman-db: a file written by a newer build is refused', () => {
  const file = tmpFile();
  const a = openStockmanDb({ file, features: [{ version: 2, name: 'future', up: raw => raw.exec('CREATE TABLE f(x)') }] });
  a.close();
  assert.throws(() => openStockmanDb({ file }), /newer build/);
});

test('stockman-db: framework migration list is well formed', () => {
  assert.doesNotThrow(() => checkMigrations(coreMigrations));
});

test('stockman-db: event log appends, filters, truncates and prunes; it never throws', () => {
  const db = openStockmanDb({ file: ':memory:' });
  let t = 1_000_000_000_000;
  const log = createEventLog(db, { now: () => t });
  assert.equal(log.append({ level: 'info', source: 'a', message: 'one' }), true);
  t += 1000;
  assert.equal(log.append({ level: 'error', source: 'b', message: 'x'.repeat(5000), data: { a: 1 } }), true);
  assert.equal(log.append({ level: 'loud', source: 'a', message: 'bad level' }), false);   // refused, not thrown
  assert.equal(log.count(), 2);
  assert.equal(log.recent()[0].source, 'b');                                      // newest first
  assert.equal(log.recent()[0].message.length, 2000);
  assert.deepEqual(log.recent({ level: 'error' })[0].data, { a: 1 });
  assert.equal(log.recent({ source: 'a' }).length, 1);
  t += 40 * 86400000;
  assert.equal(log.prune(30), 2);
  assert.equal(log.count(), 0);
  db.close();
  assert.equal(log.append({ level: 'info', source: 'a', message: 'after close' }), false);   // closed db: false, no throw
});
