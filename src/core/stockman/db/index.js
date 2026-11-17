// Database connection and migrations for stockman.db.
//   openStockmanDb({ file, features, log }) → { raw, stmt, tx, version, readOnly, file, close }   (the shape of src/core/cortex/db.js)
// Reuses the cortex opener on purpose: it is the one file in jarvis that loads the SQLite driver, so a driver swap stays a one-file job,
// and it already sets WAL, foreign keys, a busy timeout and runs each migration in its own transaction.
// Differences from using it blind: stockman.db is its own file (vault note 07: one database owned by the engine, not cortex.db),
// feature migrations are validated and merged with the framework's, and a failed migration THROWS here instead of leaving a
// silent read-only handle (vault rule: fail loudly).
// Port for mocks: any object with { raw, stmt, tx, version, readOnly, close } works; ':memory:' is the mock for tests.
const { openDb } = require('../../cortex/db');
const coreMigrations = require('./migrations');
const { MigrationError } = require('../errors');

// feature migrations must be well formed, unique, and numbered after every framework migration
function checkMigrations(list, { after = 0, who = 'migrations' } = {}) {
  const seen = new Set();
  for (const m of list) {
    if (!m || !Number.isInteger(m.version) || m.version < 1 || typeof m.name !== 'string' || !m.name || typeof m.up !== 'function') throw new MigrationError(`${who}: each migration needs an integer version, a name and an up(raw) function`);
    if (m.version <= after) throw new MigrationError(`${who}: version ${m.version} (${m.name}) is not above ${after}, the last framework migration`);
    if (seen.has(m.version)) throw new MigrationError(`${who}: version ${m.version} is used twice`);
    seen.add(m.version);
  }
}

function openStockmanDb({ file = ':memory:', features = [], log = () => {}, openDbImpl = openDb } = {}) {
  const lastCore = Math.max(...coreMigrations.map(m => m.version));
  checkMigrations(coreMigrations, { who: 'framework migrations' });
  checkMigrations(features, { after: lastCore, who: 'feature migrations' });
  const migrations = [...coreMigrations, ...features];
  let failure = null;
  const db = openDbImpl({ file, migrations, log: msg => { failure = msg; log(msg); } });
  if (db.readOnly) {
    db.close();
    throw new MigrationError(`stockman.db migration failed, refusing to run read-only: ${failure || 'unknown error'}`);
  }
  const wanted = Math.max(...migrations.map(m => m.version));
  const found = db.version;   // read before close(): a closed handle cannot answer
  if (found > wanted) {
    db.close();
    throw new MigrationError(`stockman.db is at version ${found} but this build only knows up to ${wanted}: it was written by a newer build`);
  }
  return db;
}

module.exports = { openStockmanDb, checkMigrations, coreMigrations };
