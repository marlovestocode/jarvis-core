// One-time import of <data>/timers.json into the cortex (cortex wave 3 §4, plan E17). The file is read with the old
// file store (valid entries only; a corrupt file goes to broken/ as before), every timer becomes a pending reminder node
// with the same id, and the meta.import_timers marker is set in the same transaction. Only after it commits is the file
// renamed timers.json.imported.bak; a crash in between leaves the marker, so the next boot only renames. Overdue
// timers are imported as pending, so the scheduler's start fires them once as missed (the behavior before the move).
const fs = require('node:fs');
const { createTimerStore } = require('./store');
const { toNode } = require('./cortex-store');

const MARKER = 'import_timers';
const MAX_LABEL = 200;   // the cortex cap for reminder text
const NEUTRAL = '(label not kept)';
const cutLabel = s => {
  const t = String(s ?? '');
  if (t.length <= MAX_LABEL) return t;
  const c = t.slice(0, MAX_LABEL + 1).replace(/\s+\S*$/, '').trim();
  return c || t.slice(0, MAX_LABEL);
};
const bakName = (file, now) => (fs.existsSync(file + '.imported.bak') ? `${file}.${now()}.imported.bak` : file + '.imported.bak');

function importTimersJson({ cortex, file, log = () => {}, now = Date.now } = {}) {
  // a cortex running in memory (or read-only) would lose them: leave the file for a later boot
  if (!cortex.health().ok) return { imported: 0, skipped: 0, unavailable: true };
  if (!fs.existsSync(file)) return { imported: 0, skipped: 0 };
  if (cortex.meta.get(MARKER)) {
    fs.renameSync(file, bakName(file, now));
    return { imported: 0, skipped: 0, already: true };
  }
  let total = 0;
  try { total = JSON.parse(fs.readFileSync(file, 'utf8'))?.timers?.length || 0; } catch { /* the file store reports and moves it */ }
  const timers = createTimerStore({ file, log }).list();
  if (!fs.existsSync(file)) return { imported: 0, skipped: 0, broken: true };   // unreadable: moved to broken/

  let imported = 0;
  cortex.transaction(() => {
    const source = cortex.source.find({ kind: 'user', ref: 'timers' }) ?? cortex.source.add({ kind: 'user', ref: 'timers', title: 'timers and reminders' });
    // the old file had no secret guard and no length cap: a long label is cut, and a label the guard refuses is replaced,
    // so every pending reminder still fires (review fix: they were dropped without a word)
    for (const t of timers) {
      try {
        if (cortex.node.find({ kind: 'reminder', key: 'reminder:' + t.id })) continue;
        const label = cutLabel(t.label);
        try { cortex.node.upsert({ ...toNode({ ...t, label }), source, created: t.created }); } catch (err) {
          if (err.code !== 'secret') throw err;
          cortex.node.upsert({ ...toNode({ ...t, label: NEUTRAL }), source, created: t.created });
          log(`timer ${t.id}: its label looked like a secret, kept as "${NEUTRAL}"`);
        }
        imported++;
      } catch (err) { log(`timer ${t.id} not imported: ${err.code || err.message}`); }
    }
    cortex.meta.set(MARKER, new Date(now()).toISOString());
  });
  fs.renameSync(file, bakName(file, now));
  return { imported, skipped: total - imported };
}

module.exports = { importTimersJson };
