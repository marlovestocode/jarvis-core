// Every PC action that ran: one JSON line in <data>/actions.log { id, at, what, args, result, ok, undo?, undid? }.
// undo: the moves to reverse ([{ from, to }]); undid: the id an undo_last reversed.
const fs = require('node:fs');
const path = require('node:path');

function createActionLog({ file, now = Date.now, log = () => {} }) {
  const entries = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e && e.id) entries.push(e); } catch { /* skip a broken line */ }
    }
  } catch { /* no log yet */ }
  let seq = 0;

  function write({ what, args = {}, result = '', ok, undo, undid }) {
    const e = { id: `a${now().toString(36)}${(seq++).toString(36)}`, at: new Date(now()).toISOString(), what, args, result: String(result).slice(0, 500), ok: !!ok };
    if (undo) e.undo = undo;
    if (undid) e.undid = undid;
    entries.push(e);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(e) + '\n');
    } catch (err) { log(`action log write failed: ${err.message}`); }
    return e;
  }

  // the newest successful move that has not been undone
  function lastUndoable() {
    const undone = new Set(entries.filter(e => e.undid && e.ok).map(e => e.undid));
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.ok && Array.isArray(e.undo) && e.undo.length && !undone.has(e.id)) return e;
    }
    return null;
  }

  return { write, lastUndoable, list: () => entries.slice() };
}

module.exports = { createActionLog };
