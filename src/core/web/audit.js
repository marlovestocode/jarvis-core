// The record of everything JARVIS does on the open web: one JSON line per search or page, including the ones that were
// refused and why. It is for you to read (tray menu → Web activity log); the model cannot edit or read it.
// It keeps the last ~1 MB (the file is moved aside once, then replaced) and also goes out on the bus as 'web' events.
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 1024 * 1024;

function createWebAudit({ file, bus, now = Date.now, log = () => {}, maxBytes = MAX_BYTES } = {}) {
  let ready = false;
  const recent = [];   // newest last, for the limits and the tests
  function rotate() {
    try { if (fs.statSync(file).size > maxBytes) fs.renameSync(file, file + '.1'); } catch { /* no file yet */ }
  }
  function record(entry) {
    const e = { at: new Date(now()).toISOString(), ...entry };
    for (const k of Object.keys(e)) if (typeof e[k] === 'string' && e[k].length > 300) e[k] = e[k].slice(0, 300) + '…';
    recent.push(e);
    if (recent.length > 200) recent.shift();
    if (file) {
      try {
        if (!ready) { fs.mkdirSync(path.dirname(file), { recursive: true }); ready = true; }
        rotate();
        fs.appendFileSync(file, JSON.stringify(e) + '\n');
      } catch (err) { log('web activity log failed: ' + err.message); }
    }
    try { bus?.emit('web', e); } catch { /* listeners */ }
    return e;
  }
  return { record, recent: () => recent.slice(), file };
}

module.exports = { createWebAudit };
