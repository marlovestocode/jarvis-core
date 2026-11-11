// Every PC action that ran: one `action` event in the cortex (W2 §2), payload { id, at, what, args, result, ok, undo?, undid? }
// exactly as the old <data>/actions.log lines. undo: the moves to reverse ([{ from, to }] or [{ created }]); undid: the id
// an undo_last reversed. The undo rule is a query: the newest successful move not yet undone. Write order is unchanged:
// the caller performs the action, then write(); a crash between them loses the log line, never the action.
// Each action's destinations become file/folder nodes linked `touched` to their folder (plan E9).
const fs = require('node:fs');
const path = require('node:path');
const { bakName } = require('../memory/import');

const CAP = 5000;          // retention: the newest CAP actions plus the undoable one, however old (W2 §3)
const MAX_PATHS = 20;      // nodes per action

// the newest successful move that has not been undone, from a newest-first list (an undo is always newer than its target)
function newestUndoable(newestFirst) {
  const undone = new Set();
  for (const ev of newestFirst) {
    const e = ev.payload;
    if (!e) continue;
    if (e.undid && e.ok) undone.add(e.undid);
    if (e.ok && Array.isArray(e.undo) && e.undo.length && !undone.has(e.id)) return ev;
  }
  return null;
}

const pathKey = p => 'path:' + String(p).toLowerCase();

function actionSource(cortex) {
  return cortex.source.find({ kind: 'tool', ref: 'pc-actions' }) ?? cortex.source.add({ kind: 'tool', ref: 'pc-actions', title: 'PC actions JARVIS ran' });
}

// file/folder nodes for an action's destinations → the first node id (or null). A path the cortex refuses is skipped.
function touch(cortex, e, source) {
  let first = null;
  const items = Array.isArray(e.undo) ? e.undo : [];
  for (const u of items.slice(0, MAX_PATHS)) {
    const p = u && (u.to || u.created);
    if (typeof p !== 'string' || !p) continue;
    try {
      const kind = e.what === 'make_folder' ? 'folder' : 'file';
      const id = cortex.node.upsert({ kind, key: pathKey(p), text: p, source }).id;
      const dir = path.win32.dirname(p);
      if (dir && dir !== p) {
        const fid = cortex.node.upsert({ kind: 'folder', key: pathKey(dir), text: dir, source }).id;
        if (fid !== id) cortex.link(id, fid, 'touched');
      }
      if (first === null) first = id;
    } catch { /* a path too long or odd: the event is still written */ }
  }
  return first;
}

function record(cortex, e, at, source) {
  return cortex.transaction(() => cortex.event.add({ kind: 'action', nodeId: touch(cortex, e, source), payload: e, at }));
}

function createActionLog({ cortex, now = Date.now, log = () => {} }) {
  let seq = 0, source = null;
  const src = () => (source ??= actionSource(cortex));
  const newestFirst = () => cortex.event.query({ kind: 'action', order: 'desc', limit: 1e6 });

  function write({ what, args = {}, result = '', ok, undo, undid }) {
    const e = { id: `a${now().toString(36)}${(seq++).toString(36)}`, at: new Date(now()).toISOString(), what, args, result: String(result).slice(0, 500), ok: !!ok };
    if (undo) e.undo = undo;
    if (undid) e.undid = undid;
    try { record(cortex, e, now(), src()); } catch (err) { log(`action log write failed: ${err.message}`); }
    return e;
  }

  const lastUndoable = () => newestUndoable(newestFirst())?.payload ?? null;

  function prune() {
    const keep = newestUndoable(newestFirst());
    return cortex.event.deleteWhere({ kind: 'action', keepNewest: CAP, except: keep ? [keep.id] : [] });
  }

  return {
    write, lastUndoable, prune,
    list: () => cortex.event.query({ kind: 'action', limit: 1e6 }).map(ev => ev.payload),
    stats: () => ({ entries: cortex.event.count({ kind: 'action' }), cap: CAP }),
  };
}

// one-time import of <data>/actions.log (W2 §5): one transaction, then the marker and the rename
function importActionsLog({ cortex, file, log = () => {}, now = Date.now }) {
  const rename = () => { try { if (fs.existsSync(file)) fs.renameSync(file, bakName(file, now)); } catch (err) { log('actions import: could not rename: ' + err.message); } };
  if (cortex.meta.get('import_actions')) { rename(); return { imported: 0, bad: 0, already: true }; }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { imported: 0, bad: 0 }; }
  let imported = 0, bad = 0;
  const source = actionSource(cortex);
  cortex.transaction(() => {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e = null;
      try { e = JSON.parse(line); } catch { /* counted */ }
      if (!e || typeof e !== 'object' || !e.id) { bad++; continue; }
      const at = Date.parse(e.at);
      record(cortex, e, Number.isFinite(at) ? at : now(), source);
      imported++;
    }
    cortex.meta.set('import_actions', String(now()));
  });
  log(`actions: imported ${imported} entries from actions.log (${bad} broken line${bad === 1 ? '' : 's'} skipped)`);
  rename();
  return { imported, bad };
}

module.exports = { createActionLog, importActionsLog, newestUndoable, CAP };
