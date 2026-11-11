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

function importMemoryJson({ cortex, file, log = () => {}, now = Date.now } = {}) {
  if (!fs.existsSync(file)) return { imported: 0, skipped: 0 };
  if (cortex.meta.get(MARKER)) {
    fs.renameSync(file, bakName(file, now));
    return { imported: 0, skipped: 0, already: true };
  }
  let facts;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || !Array.isArray(j.facts)) throw new Error('no facts list');
    facts = j.facts;
  } catch (err) {
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
  fs.renameSync(file, bakName(file, now));
  log(`memory: imported ${imported} fact(s) from memory.json (${skipped} skipped)`);
  return { imported, skipped };
}

module.exports = { importMemoryJson };
