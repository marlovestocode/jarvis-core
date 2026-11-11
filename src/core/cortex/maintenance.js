// Cortex maintenance (core spec §8): integrity at open, quarantine + restore, backups, export, wipe.
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const { CortexError, NODE_KINDS } = require('./guard');

const quickCheck = db => { try { return db.raw.prepare('PRAGMA quick_check').get().quick_check; } catch (err) { return err.message; } };
const naming = file => {
  const dir = path.dirname(file), base = path.basename(file).replace(/\.db$/i, '');
  return { dir, base, re: new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.backup-(\\d+)\\.db$`) };
};
function listBackups(file) {
  const { dir, re } = naming(file);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.map(n => [n, re.exec(n)]).filter(x => x[1]).sort((a, b) => Number(b[1][1]) - Number(a[1][1])).map(x => path.join(dir, x[0]));
}
const setMeta = (db, key, value) => db.stmt('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
const getMeta = (db, key) => db.stmt('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;

// Open a file, check it, and if it is broken move it (and its -wal/-shm) to broken/ and restore the newest good backup.
// No good backup: an empty cortex with meta.recovered_empty (wave importers re-read their *.imported.bak, plan D15).
// Throws only when the path cannot hold a database at all (the caller then runs in memory).
function openChecked({ file, log = () => {}, now = Date.now }) {
  if (file === ':memory:') return { db: openDb({ file, log }), quickCheck: 'ok', restoredFrom: null, recoveredEmpty: null };
  const exists = fs.existsSync(file);
  if (exists && !fs.statSync(file).isFile()) throw new CortexError('not_a_file', file);
  let db = null, qc;
  try {
    db = openDb({ file, log });
    // after a clean close (and no failed daily check) the full scan is skipped: it is the slowest part of boot.
    // After a crash it runs here; the idle job also runs it once a day.
    const clean = getMeta(db, 'clean_close') === '1' && getMeta(db, 'check_failed') === null;
    qc = clean ? 'skipped' : quickCheck(db);
  } catch (err) { qc = err.message; }
  if (qc === 'ok' || qc === 'skipped') {
    if (!db.readOnly) setMeta(db, 'clean_close', '0');
    return { db, quickCheck: qc, restoredFrom: null, recoveredEmpty: null };
  }

  try { db?.close(); } catch { /* broken anyway */ }
  log(`cortex: ${file} failed quick_check (${qc}); quarantining`);
  const { dir } = naming(file);
  const broken = path.join(dir, 'broken');
  fs.mkdirSync(broken, { recursive: true });
  const stamp = now();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, path.join(broken, `${stamp}-${path.basename(file)}${suffix}`));
  }
  for (const b of listBackups(file)) {
    try {
      fs.copyFileSync(b, file);
      const r = openDb({ file, log });
      if (quickCheck(r) === 'ok') { log('cortex: restored ' + path.basename(b)); return { db: r, quickCheck: 'ok', restoredFrom: b, recoveredEmpty: null }; }
      r.close();
    } catch { /* try the next one */ }
    try { fs.rmSync(file, { force: true }); } catch { /* next */ }
  }
  const fresh = openDb({ file, log });
  setMeta(fresh, 'recovered_empty', stamp);
  log('cortex: no usable backup, started empty');
  return { db: fresh, quickCheck: 'ok', restoredFrom: null, recoveredEmpty: stamp };
}

function createMaintenance({ db, file, now = Date.now, keep = 3, log = () => {}, onWipe = () => {} }) {
  const memory = file === ':memory:';

  function backup() {
    if (memory) return null;
    const { dir, base } = naming(file);
    let t = now(), out;
    do { out = path.join(dir, `${base}.backup-${t}.db`); t++; } while (fs.existsSync(out));
    db.raw.prepare('VACUUM INTO ?').run(out);
    for (const old of listBackups(file).slice(keep)) { try { fs.rmSync(old, { force: true }); } catch (err) { log('cortex backup cleanup: ' + err.message); } }
    setMeta(db, 'last_backup', now());
    return out;
  }

  const lastBackupAt = () => Number(getMeta(db, 'last_backup')) || null;

  function exportAll() {
    const all = sql => db.raw.prepare(sql).all();
    const parse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
    return JSON.parse(JSON.stringify({
      version: db.version,
      exportedAt: now(),
      nodes: all('SELECT id, kind, key, text, data, status, importance, confidence, uses, created, updated, last_used FROM node ORDER BY id').map(n => ({ ...n, data: parse(n.data) })),
      edges: all('SELECT * FROM edge ORDER BY src, dst, type'),
      provenance: all('SELECT * FROM provenance ORDER BY node_id, source_id'),
      sources: all('SELECT * FROM source ORDER BY id'),
      events: all('SELECT * FROM event ORDER BY id').map(e => ({ ...e, payload: parse(e.payload) })),
    }));
  }

  // kinds: delete those nodes (edges, provenance, vectors cascade). everything: every row, then checkpoint, VACUUM,
  // and delete backups and *.imported.bak next to the db, so nothing is left to restore from (spec §8).
  function wipe({ kinds, everything = false } = {}) {
    if (!everything) {
      const list = [...(kinds || [])];
      if (!list.length || list.some(k => !NODE_KINDS.has(k))) throw new CortexError('kind', 'wipe needs known node kinds');
      const n = db.tx(() => db.stmt('DELETE FROM node WHERE kind IN (SELECT value FROM json_each(?))').run(JSON.stringify(list)).changes);
      onWipe();
      return n;
    }
    const n = db.tx(() => {
      const c = db.stmt('SELECT count(*) n FROM node').get().n;
      for (const t of ['event', 'edge', 'provenance', 'vec', 'node', 'source', 'meta']) db.raw.exec(`DELETE FROM ${t}`);
      db.raw.exec("INSERT INTO node_fts(node_fts) VALUES ('rebuild')");
      return c;
    });
    onWipe();
    if (!memory) {
      db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.raw.exec('VACUUM');
      for (const b of listBackups(file)) fs.rmSync(b, { force: true });
      const { dir } = naming(file);
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.imported.bak')) fs.rmSync(path.join(dir, f), { force: true });
    }
    return n;
  }

  return { backup, lastBackupAt, export: exportAll, wipe, quickCheck: () => quickCheck(db) };
}

module.exports = { openChecked, createMaintenance, listBackups, getMeta, setMeta };
