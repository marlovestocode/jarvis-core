// Timers, alarms and reminders on disk: <data>/timers.json, atomic write (temp + rename).
// A corrupt file is moved to <data>/broken/timers.json and the store starts empty.
// Timer: { id, kind: 'timer'|'alarm'|'reminder', label, due (epoch ms), created }
const fs = require('node:fs');
const path = require('node:path');

const KINDS = ['timer', 'alarm', 'reminder'];
const valid = t => t && typeof t.id === 'string' && KINDS.includes(t.kind) && typeof t.label === 'string' && Number.isFinite(t.due) && Number.isFinite(t.created);
const clean = t => ({ id: t.id, kind: t.kind, label: t.label, due: t.due, created: t.created });

function createTimerStore({ file, log = () => {} }) {
  let timers = [];
  let seq = 0;
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  if (text !== null) {
    try {
      const j = JSON.parse(text);
      if (!j || !Array.isArray(j.timers)) throw new Error('bad shape');
      timers = j.timers.filter(valid).map(clean);
    } catch (err) {
      log(`timers file unreadable (${err.message}), moved to broken/`);
      try {
        const broken = path.join(path.dirname(file), 'broken');
        fs.mkdirSync(broken, { recursive: true });
        fs.renameSync(file, path.join(broken, path.basename(file)));
      } catch { /* best effort */ }
    }
  }

  function write(next) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ timers: next }, null, 2));
    fs.renameSync(tmp, file);
  }

  function nextId() {
    let id;
    do { id = 't' + Date.now().toString(36) + (seq++).toString(36); } while (timers.some(t => t.id === id));
    return id;
  }

  // add → the stored timer, only once a re-read of the file shows it (that is the "persisted" check)
  function add(t) {
    const rec = clean({ ...t, id: nextId() });
    if (!valid(rec)) throw new Error('Bad timer');
    const next = [...timers, rec];
    try {
      write(next);
      const back = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!back.timers.some(x => x.id === rec.id)) throw new Error('not in file after write');
    } catch (err) {
      throw new Error(`Could not save the timer: ${err.message}`);
    }
    timers = next;
    return { ...rec };
  }

  function remove(id) {
    const next = timers.filter(t => t.id !== id);
    if (next.length === timers.length) return false;
    write(next);
    timers = next;
    return true;
  }

  return {
    list: () => timers.map(t => ({ ...t })),
    get: id => { const t = timers.find(x => x.id === id); return t ? { ...t } : null; },
    add,
    remove,
  };
}

module.exports = { createTimerStore, KINDS };
