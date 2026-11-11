// One-time import of <data>/music-plays.jsonl into the cortex (W2 §5, plan E5). It never blocks boot: step() does at
// most one slice of work, and each chunk of lines commits with the byte offset reached (meta import_music_pos), so a
// quit mid-way resumes exactly there with no duplicates. After the last line: the marker, the log line, the rename.
const fs = require('node:fs');
const { recordPlay, musicSource } = require('./adapter');
const { bakName } = require('../memory/import');

const READ = 1 << 20;
const valid = p => p && typeof p === 'object' && /^[\w-]{6,20}$/.test(String(p.videoId)) && Number.isFinite(p.at) && p.at > 0
  && Number.isFinite(p.listenedSec) && typeof p.outcome === 'string' && Array.isArray(p.artists);

function createMusicImport({ cortex, file, playLog = null, log = () => {}, now = Date.now, chunkLines = 2000 }) {
  let done = false, fd = null, size = 0, pos = 0, bad = 0, imported = 0, prev = null, source = null;
  let carry = Buffer.alloc(0), carryAt = 0;
  const ids = new Map();   // videoId → track node id, for this import only   // bytes read past the last full line, and the offset they start at

  const pct = () => (size ? Math.min(100, Math.round((100 * pos) / size)) : 100);
  const state = () => ({ done, pct: pct(), imported, bad });
  function setImporting(active) { if (playLog) { playLog.importing.active = active; playLog.importing.pct = pct(); } }

  function rename() {
    try { if (fs.existsSync(file)) fs.renameSync(file, bakName(file, now)); } catch (err) { log('music import: could not rename ' + file + ': ' + err.message); }
  }
  function finish() {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } fd = null; }
    done = true; setImporting(false);
    playLog?.reload();
  }

  function begin() {
    if (cortex.meta.get('import_music')) { rename(); finish(); return false; }
    if (!fs.existsSync(file)) { finish(); return false; }
    fd = fs.openSync(file, 'r');
    size = fs.fstatSync(fd).size;
    pos = Number(cortex.meta.get('import_music_pos')) || 0;
    bad = Number(cortex.meta.get('import_music_bad')) || 0;
    carryAt = pos;
    source = musicSource(cortex);
    setImporting(true);
    return true;
  }

  // the next complete line at the read position → { text, end } (end = byte offset after its newline), or null at EOF
  function nextLine() {
    for (;;) {
      const nl = carry.indexOf(10);
      if (nl >= 0) {
        const text = carry.subarray(0, nl).toString('utf8');
        carry = carry.subarray(nl + 1); carryAt += nl + 1;
        return { text, end: carryAt };
      }
      const buf = Buffer.alloc(READ);
      const n = fs.readSync(fd, buf, 0, READ, carryAt + carry.length);
      if (n === 0) {
        if (!carry.length) return null;
        const text = carry.toString('utf8'); carryAt += carry.length; carry = Buffer.alloc(0);   // a last line with no newline
        return { text, end: carryAt };
      }
      carry = Buffer.concat([carry, buf.subarray(0, n)]);
    }
  }

  function chunk(deadline) {
    let lines = 0, eof = false;
    cortex.transaction(() => {
      while (lines < chunkLines && (lines === 0 || Date.now() < deadline)) {
        const l = nextLine();
        if (!l) { eof = true; break; }
        lines++; pos = l.end;
        if (!l.text.trim()) continue;
        let p = null;
        try { p = JSON.parse(l.text); } catch { /* counted below */ }
        if (!valid(p)) { bad++; continue; }
        // a line the cortex refuses (too big, odd data) rolls back alone and counts as bad, so it cannot stall the import
        try { if (recordPlay(cortex, p, { prev, source, ids })) imported++; } catch { bad++; ids.delete(p.videoId); continue; }
        prev = p;
      }
      cortex.meta.set('import_music_pos', String(pos));
      cortex.meta.set('import_music_bad', String(bad));
      if (eof) cortex.meta.set('import_music', String(now()));
    });
    return eof;
  }

  function step({ deadlineMs = 50 } = {}) {
    if (done) return state();
    try {
      if (fd === null && !begin()) return state();
      const deadline = Date.now() + Math.max(0, deadlineMs);
      let eof = false;
      do { eof = chunk(deadline); } while (!eof && Date.now() < deadline);
      setImporting(!eof);
      if (eof) {
        log(`music: imported ${imported} plays from music-plays.jsonl (${bad} malformed line${bad === 1 ? '' : 's'} skipped)`);
        finish(); rename();
      }
    } catch (err) {
      log('music import failed: ' + err.message);   // stays where the last chunk committed; the next boot resumes
      finish();
    }
    return state();
  }

  return { step, state };
}

module.exports = { createMusicImport };
