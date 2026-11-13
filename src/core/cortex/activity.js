// The cortex firing, as events for the wallpaper (bus type "brain"). Ids only, never text.
//   recall  a lookup: the seeds it started from and the links the spreading activation followed (the real path)
//   write   something was learned or changed (batched: an import of thousands is one event)
//   use     items used together after a turn, so their links grew
// Rate-limited and capped: the wallpaper wants a pulse, not a log.
const MAX_IDS = 48;
const MAX_TRAIL = 120;
const MIN_GAP_MS = 120;     // per op
const WRITE_BATCH_MS = 150;

function createActivity({ bus = null, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const lastAt = {};
  let writes = new Set(), writeTimer = null;

  function emit(op, payload) {
    if (!bus) return;
    try { bus.emit('brain', { op, ...payload }); } catch { /* a listener must not break the cortex */ }
  }
  const gap = op => { const t = now(); if (t - (lastAt[op] ?? -Infinity) < MIN_GAP_MS) return false; lastAt[op] = t; return true; };
  const ids = list => [...new Set((list || []).filter(Number.isInteger))].slice(0, MAX_IDS);

  // a = { seeds: [ids], trail: [[from, to, hop], ...], items: [ids packed into the answer] }
  function recall(a = {}) {
    const items = ids(a.items), seeds = ids(a.seeds);
    if (!gap('recall') || (!items.length && !seeds.length)) return;
    const trail = (a.trail || []).filter(p => Array.isArray(p) && Number.isInteger(p[0]) && Number.isInteger(p[1])).slice(0, MAX_TRAIL).map(p => [p[0], p[1], p[2] | 0]);
    emit('recall', { seeds, items, trail });
  }

  function flushWrites() {
    writeTimer = null;
    const list = ids([...writes]);
    const n = writes.size;
    writes = new Set();
    if (list.length && gap('write')) emit('write', { ids: list, count: n });
  }
  function write(id) {
    if (!bus || !Number.isInteger(id)) return;
    writes.add(id);
    if (!writeTimer) { writeTimer = setTimer(flushWrites, WRITE_BATCH_MS); writeTimer.unref?.(); }
  }

  function use(list, pairs = 0) {
    const l = ids(list);
    if (l.length && gap('use')) emit('use', { ids: l, links: pairs | 0 });
  }

  function close() { if (writeTimer) { clearTimer(writeTimer); writeTimer = null; } writes = new Set(); }

  return { recall, write, use, close };
}

module.exports = { createActivity };
