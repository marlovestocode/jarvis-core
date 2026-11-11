// Every PC action that ran: one JSON line in <data>/actions.log { id, at, what, args, result, ok, undo?, undid? }.
// undo: the moves to reverse ([{ from, to }]); undid: the id an undo_last reversed.
const fs = require('node:fs');
const path = require('node:path');

// Kept in memory and on disk: the newest KEEP entries once there are LIMIT; the file is rewritten then, so it
// holds between KEEP and LIMIT lines. The newest undoable move is always kept, however old.
const KEEP = 500, LIMIT = 1000;

// the newest successful move that has not been undone
function newestUndoable(list) {
  const undone = new Set(list.filter(e => e.undid && e.ok).map(e => e.undid));
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e.ok && Array.isArray(e.undo) && e.undo.length && !undone.has(e.id)) return e;
  }
  return null;
}

function createActionLog({ file, now = Date.now, log = () => {} }) {
  const entries = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e && e.id) entries.push(e); } catch { /* skip a broken line */ }
    }
  } catch { /* no log yet */ }
  let seq = 0;

  function compact() {
    if (entries.length < LIMIT) return;
    const keep = entries.slice(-KEEP);
    const old = newestUndoable(entries);
    if (old && !keep.includes(old)) keep.unshift(old);
    entries.splice(0, entries.length, ...keep);
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, entries.map(e => JSON.stringify(e) + '\n').join(''));
      fs.renameSync(tmp, file);
    } catch (err) { log(`action log trim failed: ${err.message}`); }
  }
  compact();   // a log that grew before this cap existed

  function write({ what, args = {}, result = '', ok, undo, undid }) {
    const e = { id: `a${now().toString(36)}${(seq++).toString(36)}`, at: new Date(now()).toISOString(), what, args, result: String(result).slice(0, 500), ok: !!ok };
    if (undo) e.undo = undo;
    if (undid) e.undid = undid;
    entries.push(e);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(e) + '\n');
    } catch (err) { log(`action log write failed: ${err.message}`); }
    compact();
    return e;
  }

  return { write, lastUndoable: () => newestUndoable(entries), list: () => entries.slice(), stats: () => ({ entries: entries.length, cap: LIMIT }) };
}

module.exports = { createActionLog };
