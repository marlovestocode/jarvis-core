// Local metrics store: one JSON line per event in <data>/metrics/YYYY-MM-DD.jsonl. Nothing leaves this PC.
// Events are small facts about JARVIS's own behaviour (counts, timings, sizes), never what was said. Writes are batched
// (every flushMs, and on close) so a busy turn does not touch the disk per event; a torn or corrupt line is skipped on read;
// day files older than maxDays are removed. read(from, to) gives the events of a time range, oldest first.
const fs = require('node:fs');
const path = require('node:path');

const DAY = 864e5;
const dayKey = t => new Date(t).toISOString().slice(0, 10);
const FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

function createStore({ dir, now = Date.now, flushMs = 5000, maxDays = 90, maxBuffer = 5000, log = () => {} } = {}) {
  let buf = [];            // events waiting for the disk
  let timer = null;
  let written = 0, dropped = 0, lastPrune = 0;
  const cache = new Map(); // day key → parsed events of a finished day (today is never cached: it still grows)

  function ensure() { try { fs.mkdirSync(dir, { recursive: true }); return true; } catch (err) { log('metrics: cannot create ' + dir + ': ' + err.message); return false; } }

  function flush() {
    if (!buf.length) return;
    const batch = buf; buf = [];
    if (!ensure()) { dropped += batch.length; return; }
    const byDay = new Map();
    for (const e of batch) { const k = dayKey(e.t); (byDay.get(k) || byDay.set(k, []).get(k)).push(JSON.stringify(e)); }
    for (const [k, lines] of byDay) {
      try { fs.appendFileSync(path.join(dir, k + '.jsonl'), lines.join('\n') + '\n'); written += lines.length; cache.delete(k); } catch (err) { dropped += lines.length; log('metrics: write failed: ' + err.message); }
    }
    prune();
  }

  function prune() {
    if (now() - lastPrune < DAY / 2) return;
    lastPrune = now();
    try {
      const cutoff = dayKey(now() - maxDays * DAY);
      for (const f of fs.readdirSync(dir)) { const m = FILE.exec(f); if (m && m[1] < cutoff) { fs.rmSync(path.join(dir, f), { force: true }); cache.delete(m[1]); } }
    } catch { /* nothing to prune yet */ }
  }

  function add(ev) {
    if (!ev || typeof ev !== 'object') return;
    buf.push({ ...ev, t: Number.isFinite(ev.t) ? ev.t : now() });
    if (buf.length >= maxBuffer) flush();
    else if (!timer) { timer = setTimeout(() => { timer = null; flush(); }, flushMs); timer.unref?.(); }
  }

  function readDay(k, today) {
    if (!today && cache.has(k)) return cache.get(k);
    let out = [];
    try {
      for (const line of fs.readFileSync(path.join(dir, k + '.jsonl'), 'utf8').split('\n')) {
        if (!line) continue;
        try { const e = JSON.parse(line); if (e && Number.isFinite(e.t) && typeof e.k === 'string') out.push(e); } catch { /* a torn last line */ }
      }
    } catch { /* no file for that day */ }
    if (!today) { cache.set(k, out); if (cache.size > 14) cache.delete(cache.keys().next().value); }
    return out;
  }

  // events with from <= t <= to, oldest first; includes what is still waiting in the buffer
  function read(from, to = now()) {
    const out = [];
    const today = dayKey(now());
    for (let d = Math.floor(from / DAY) * DAY; d <= to; d += DAY) {
      const k = dayKey(d);
      for (const e of readDay(k, k >= today)) if (e.t >= from && e.t <= to) out.push(e);
    }
    for (const e of buf) if (e.t >= from && e.t <= to) out.push(e);
    // a day read from disk and the buffer can overlap only before a flush; the disk never holds buffered events
    return out.sort((a, b) => a.t - b.t);
  }

  function close() { clearTimeout(timer); timer = null; flush(); }
  function stats() {
    let files = 0, bytes = 0;
    try { for (const f of fs.readdirSync(dir)) if (FILE.test(f)) { files++; bytes += fs.statSync(path.join(dir, f)).size; } } catch { /* none yet */ }
    return { buffered: buf.length, written, dropped, files, bytes, cachedDays: cache.size };
  }

  return { add, read, flush, close, stats };
}

module.exports = { createStore, dayKey };
