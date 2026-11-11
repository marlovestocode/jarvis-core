// The only file that imports node:sqlite (core spec §1, §3). Swapping the driver touches this file alone.
// openDb → { raw, stmt(sql), tx(fn), readOnly, version, file, close() }
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const defaultMigrations = require('./migrations');

function openDb({ file = ':memory:', migrations = defaultMigrations, log = () => {} } = {}) {
  const memory = file === ':memory:';
  if (!memory) fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  try {
    if (!memory) raw.exec('PRAGMA journal_mode = WAL');
    raw.exec(`PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;
              PRAGMA cache_size = -4000; PRAGMA mmap_size = 0; PRAGMA temp_store = MEMORY;`);
  } catch (err) {
    try { raw.close(); } catch { /* not open */ }   // an open handle locks the file on Windows, so quarantine could not move it
    throw err;
  }

  const cache = new Map();
  function stmt(sql) {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
    return s;
  }

  // Nested calls become savepoints, so an inner failure rolls back only its own part.
  let depth = 0;
  function tx(fn) {
    const sp = depth ? `sp${depth}` : null;
    raw.exec(sp ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE');
    depth++;
    try {
      const out = fn();
      depth--;
      raw.exec(sp ? `RELEASE ${sp}` : 'COMMIT');
      return out;
    } catch (err) {
      depth--;
      try { raw.exec(sp ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  const userVersion = () => raw.prepare('PRAGMA user_version').get().user_version;
  let readOnly = false;
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= userVersion()) continue;
    try {
      raw.exec('BEGIN IMMEDIATE');
      m.up(raw);
      raw.exec(`PRAGMA user_version = ${Number(m.version)}`);
      raw.exec('COMMIT');
    } catch (err) {
      try { raw.exec('ROLLBACK'); } catch { /* nothing open */ }
      log(`cortex migration ${m.version}-${m.name} failed, read-only: ${err.message}`);
      raw.exec('PRAGMA query_only = ON');   // the old version keeps serving reads (spec §8)
      readOnly = true;
      break;
    }
  }

  return {
    raw, stmt, tx, file, readOnly,
    get version() { return userVersion(); },
    close() { cache.clear(); try { raw.close(); } catch { /* already closed */ } },
  };
}

module.exports = { openDb };
