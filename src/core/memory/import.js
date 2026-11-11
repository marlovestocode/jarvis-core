// One-time import of the old memory.json (v1: { facts: [{ id, text, at }] }) into the cortex (W1 §3).
// One transaction writes every valid fact (source import, trust 100, tier profile) and the meta.import_memory
// marker; only after it commits is the file renamed memory.json.imported.bak. A crash between the two leaves the
// marker set, so the next boot only renames. A corrupt file is moved to broken/ and nothing is imported.
const fs = require('node:fs');
const path = require('node:path');
const { SECRET } = require('../cortex/guard');
const { MAX_LEN } = require('./facts');

const MARKER = 'import_memory';

function bakName(file, now) {
  const bak = file + '.imported.bak';
  return fs.existsSync(bak) ? `${file}.${now()}.imported.bak` : bak;
}

// the newest memory.json*.imported.bak next to the file (D15: a cortex that recovered empty re-reads it)
function newestBak(file) {
  const dir = path.dirname(file), base = path.basename(file);
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.startsWith(base + '.') && n.endsWith('.imported.bak')); } catch { return null; }
  const withTime = names.map(n => { try { return [n, fs.statSync(path.join(dir, n)).mtimeMs]; } catch { return null; } }).filter(Boolean);
  withTime.sort((a, b) => b[1] - a[1]);
  return withTime.length ? path.join(dir, withTime[0][0]) : null;
}

function importMemoryJson({ cortex, file, log = () => {}, now = Date.now } = {}) {
  // a cortex running in memory (or read-only) would lose what it imports: leave the file for a later boot
  if (!cortex.health().ok) return { imported: 0, skipped: 0, unavailable: true };
  const live = fs.existsSync(file);
  if (cortex.meta.get(MARKER)) {
    if (live) fs.renameSync(file, bakName(file, now));
    return live ? { imported: 0, skipped: 0, already: true } : { imported: 0, skipped: 0 };
  }
  const src = live ? file : newestBak(file);
  if (!src) return { imported: 0, skipped: 0 };
  let facts;
  try {
    const j = JSON.parse(fs.readFileSync(src, 'utf8'));
    if (!j || !Array.isArray(j.facts)) throw new Error('no facts list');
    facts = j.facts;
  } catch (err) {
    if (!live) { log(`memory: ${path.basename(src)} is unreadable (${err.message}); nothing imported`); return { imported: 0, skipped: 0, broken: true }; }
    const broken = path.join(path.dirname(file), 'broken');
    fs.mkdirSync(broken, { recursive: true });
    fs.renameSync(file, path.join(broken, `${now()}-${path.basename(file)}`));
    log(`memory: ${path.basename(file)} is unreadable (${err.message}); moved to broken/, nothing imported`);
    return { imported: 0, skipped: 0, broken: true };
  }

  let imported = 0, skipped = 0;
  cortex.transaction(() => {
    const source = cortex.source.add({ kind: 'import', trust: 100, ref: 'memory.json', title: 'memory.json (before the cortex)' });
    for (const f of facts) {
      const text = typeof f?.text === 'string' ? f.text.replace(/\s+/g, ' ').trim() : '';
      if (text.length < 3 || text.length > MAX_LEN || SECRET.test(text)) { skipped++; continue; }
      try {
        cortex.node.upsert({ kind: 'fact', text, data: { tier: 'profile' }, source, created: Number(f.at) || undefined });
        imported++;
      } catch { skipped++; }
    }
    cortex.meta.set(MARKER, now());
  });
  if (live) fs.renameSync(file, bakName(file, now));
  log(`memory: imported ${imported} fact(s) from ${path.basename(src)} (${skipped} skipped)`);
  return live ? { imported, skipped } : { imported, skipped, from: path.basename(src) };
}

module.exports = { importMemoryJson };
