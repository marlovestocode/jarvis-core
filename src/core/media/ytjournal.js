// The YouTube Music undo journal (every playlist change JARVIS made, so it can be taken back), W2 §2, plan E10.
// On the cortex each change is a `playlist_edit` event whose payload is the journal entry; an undo appends
// { undid: id }. An entry is undone when its payload says so (imported from the old file) or a later event names it.
// Only the newest 20 entries can be undone, as before. memoryJournal() is the default when no cortex is wired.
const fs = require('node:fs');
const { bakName } = require('../memory/import');

const MAX = 20;

function memoryJournal() {
  return { load: () => [], append() {}, markUndone() {} };
}

function createJournalStore({ cortex }) {
  function load() {
    const evs = cortex.event.query({ kind: 'playlist_edit', order: 'desc', limit: 1000 });
    const undid = new Set(evs.filter(e => e.payload && e.payload.undid !== undefined).map(e => e.payload.undid));
    const entries = evs.filter(e => e.payload && e.payload.undid === undefined).slice(0, MAX).reverse();
    return entries.map(e => ({ ...e.payload, undone: !!e.payload.undone || undid.has(e.payload.id) }));
  }
  const append = entry => { cortex.event.add({ kind: 'playlist_edit', payload: entry, at: Number.isFinite(entry.at) ? entry.at : undefined }); };
  const markUndone = entry => { cortex.event.add({ kind: 'playlist_edit', payload: { undid: entry.id } }); };
  return { load, append, markUndone };
}

// one-time import of <data>/ytm-undo.json (W2 §5)
function importYtmUndo({ cortex, file, log = () => {}, now = Date.now }) {
  const rename = () => { try { if (fs.existsSync(file)) fs.renameSync(file, bakName(file, now)); } catch (err) { log('ytm undo import: could not rename: ' + err.message); } };
  if (cortex.meta.get('import_ytm_undo')) { rename(); return { imported: 0, already: true }; }
  let list;
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    if (err.code === 'ENOENT') return { imported: 0 };
    log('ytm undo import: ' + file + ' is not valid JSON, left as it is');
    return { imported: 0, broken: true };
  }
  const entries = Array.isArray(list) ? list.filter(e => e && typeof e === 'object' && Number.isFinite(e.id)) : [];
  const store = createJournalStore({ cortex });
  cortex.transaction(() => {
    for (const e of entries) store.append(e);
    cortex.meta.set('import_ytm_undo', String(now()));
  });
  log(`ytmusic: imported ${entries.length} playlist edits from ytm-undo.json`);
  rename();
  return { imported: entries.length };
}

module.exports = { createJournalStore, memoryJournal, importYtmUndo };
