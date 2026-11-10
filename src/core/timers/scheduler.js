// One setTimeout to the next due timer, re-armed on add/cancel. Fired items leave the store first,
// then `timer { id, label, kind, due, missed }` goes on the bus (speaking is the proactive engine's job).
// start() on boot: items already past due fire once with missed:true, the rest are armed.
const MAX_DELAY = 2 ** 31 - 1;   // setTimeout limit; longer waits are re-armed in chunks

const labelKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\b(?:the|my|a|an|for|timer|timers|alarm|alarms|reminder|reminders)\b/g, ' ').replace(/\s+/g, ' ').trim();

function createScheduler({ store, bus, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, maxDelayMs = MAX_DELAY, log = () => {} }) {
  let handle = null;
  let running = false;

  function emit(t, missed) {
    bus.emit('timer', { id: t.id, label: t.label, kind: t.kind, due: t.due, missed });
  }

  // fire everything due; missed = it came due while the app was not running
  function fireDue(missed) {
    let n = 0;
    for (const t of store.list().filter(x => x.due <= now()).sort((a, b) => a.due - b.due)) {
      try { store.remove(t.id); } catch (err) { log(`timer ${t.id} could not be removed: ${err.message}`); }
      emit(t, missed);
      n++;
    }
    return n;
  }

  function arm() {
    if (handle !== null) { clearTimer(handle); handle = null; }
    if (!running) return;
    const list = store.list();
    if (!list.length) return;
    const next = Math.min(...list.map(t => t.due));
    handle = setTimer(() => { handle = null; fireDue(false); arm(); }, Math.min(Math.max(0, next - now()), maxDelayMs));
  }

  function start() {
    running = true;
    const fired = fireDue(true);
    arm();
    return { fired, armed: store.list().length };
  }

  function add({ kind, label = '', due }) {
    const t = store.add({ kind, label: String(label || '').trim(), due, created: now() });
    arm();
    return t;
  }

  // cancel({ id } | { label } | { all: true }) → the removed timers
  function cancel({ id, label, all } = {}) {
    const list = store.list();
    let hit = [];
    if (all) hit = list;
    else if (id) hit = list.filter(t => t.id === id);
    else if (label !== undefined) {
      const k = labelKey(label);
      hit = list.filter(t => labelKey(t.label) === k && k);
      if (!hit.length && k) hit = list.filter(t => { const l = labelKey(t.label); return l && (l.includes(k) || k.includes(l)); });
    }
    for (const t of hit) store.remove(t.id);
    arm();
    return hit;
  }

  function stop() {
    running = false;
    if (handle !== null) { clearTimer(handle); handle = null; }
  }

  return { start, add, cancel, list: () => store.list().sort((a, b) => a.due - b.due), stop };
}

module.exports = { createScheduler };
