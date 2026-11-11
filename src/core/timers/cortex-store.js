// Timers, alarms and reminders in the cortex (cortex wave 3 §4): the same surface as timers/store.js, so scheduler.js,
// proactive/engine.js and tools/timers.js do not change. Each one is a `reminder` node, key reminder:<id>, source user;
// state changes are node updates (pending = active; fired / cancelled = archived), each firing adds a reminder_fired
// event. add() returns only once a re-read finds the node committed: that is the "persisted before we say it is set" check.
// A reminder whose label names a known person, pet, place or project (wave 1 entities) is linked about it. No model call.
const { KINDS } = require('./store');
const { isTainted } = require('./taint');

const LATE_MS = 60e3;
const PAGE = 1000;
const iso = ms => new Date(ms).toISOString();
const valid = t => t && typeof t.id === 'string' && KINDS.includes(t.kind) && typeof t.label === 'string' && Number.isFinite(t.due) && Number.isFinite(t.created);
const clean = t => ({ id: t.id, kind: t.kind, label: t.label, due: t.due, created: t.created });
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// one timer → the node fields (also used by the timers.json import). Times are ISO text: the cortex reads any
// 13+ digit run in data as a card number (plan E7).
function toNode(t, state = 'pending') {
  const label = String(t.label ?? '');
  const text = label.trim().length >= 3 ? label : label.trim() ? `${t.kind} ${label.trim()}` : t.kind;
  return { kind: 'reminder', key: 'reminder:' + t.id, text, data: { type: t.kind, label, at: iso(t.due), created: iso(t.created), state }, importance: 0.5 };
}
function fromNode(n) {
  const d = n.data || {};
  const t = { id: String(n.key).slice('reminder:'.length), kind: d.type, label: typeof d.label === 'string' ? d.label : n.text, due: Date.parse(d.at), created: Date.parse(d.created) };
  return valid(t) ? t : null;
}
function userSource(cortex) {
  return cortex.source.find({ kind: 'user', ref: 'timers' }) ?? cortex.source.add({ kind: 'user', ref: 'timers', title: 'timers and reminders' });
}
// a reminder set in a tainted turn (it read outside text) gets web trust, never the user's (cortex wave 3 review)
function taintedSource(cortex) {
  return cortex.source.find({ kind: 'web', ref: 'timers:read-text' }) ?? cortex.source.add({ kind: 'web', ref: 'timers:read-text', title: 'reminders set after reading outside text' });
}
function listAll(cortex, kind, status) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = cortex.node.list({ kind, status, limit: PAGE, offset, order: 'created' });
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

function createCortexTimerStore({ cortex, now = Date.now, log = () => {} }) {
  let timers = [];
  try { timers = listAll(cortex, 'reminder', 'active').map(fromNode).filter(Boolean); } catch (err) { log(`timers could not be read from the cortex: ${err.message}`); }
  let seq = 0;

  function nextId() {
    let id;
    do { id = 't' + Date.now().toString(36) + (seq++).toString(36); } while (timers.some(t => t.id === id) || cortex.node.find({ kind: 'reminder', key: 'reminder:' + id }));
    return id;
  }

  // reminder —about→ entity for every known entity named in the label (whole words, any case)
  function linkEntities(nodeId, label) {
    try {
      for (const e of listAll(cortex, 'entity', 'active')) {
        const name = String(e.text || '').trim();
        if (name.length < 2) continue;
        if (new RegExp(`(^|[^\\p{L}\\p{N}])${escape(name)}($|[^\\p{L}\\p{N}])`, 'iu').test(label)) cortex.link(nodeId, e.id, 'about', { weight: 0.5 });
      }
    } catch (err) { log(`reminder links: ${err.message}`); }
  }

  function add(t) {
    const rec = clean({ ...t, id: nextId() });
    if (!valid(rec)) throw new Error('Bad timer');
    let id;
    try {
      if (!cortex.health().ok) throw new Error('the memory store is not available (it is running in memory or read-only)');
      const n = toNode(rec);
      const tainted = isTainted();
      cortex.node.upsert({ ...n, source: tainted ? taintedSource(cortex) : userSource(cortex), tainted });
      const back = cortex.node.find({ kind: 'reminder', key: n.key });
      if (!back || back.status !== 'active') throw new Error('not in the store after write');
      id = back.id;
    } catch (err) {
      if (err.code === 'secret') throw new Error('Could not save the timer: its label looks like a password, key or long number. Say it another way');
      throw new Error(`Could not save the timer: ${err.message}`);
    }
    timers = [...timers, rec];
    linkEntities(id, rec.label);
    return { ...rec };
  }

  // the scheduler removes a timer both when it fires and when it is cancelled: due ≤ now means it fired (plan E14)
  function remove(id) {
    const t = timers.find(x => x.id === id);
    if (!t) return false;
    // dropped from the list first: a write that fails (read-only cortex) must not make the scheduler fire it again and again
    timers = timers.filter(x => x.id !== id);
    try {
      const n = cortex.node.find({ kind: 'reminder', key: 'reminder:' + id });
      if (n && n.status === 'active') {
        const at = now(), fired = t.due <= at;
        const data = { ...(n.data || {}), state: fired ? 'fired' : 'cancelled', ...(fired ? { firedAt: iso(at) } : {}) };
        cortex.node.update(n.id, { data, status: 'archived' }, { source: userSource(cortex) });
        if (fired) cortex.event.add({ kind: 'reminder_fired', nodeId: n.id, payload: { timerId: id, late: at - t.due > LATE_MS } });
      }
    } catch (err) { log(`timer ${id} left the list but its node could not be updated: ${err.message}`); }
    return true;
  }

  return {
    list: () => timers.map(t => ({ ...t })),
    get: id => { const t = timers.find(x => x.id === id); return t ? { ...t } : null; },
    add,
    remove,
  };
}

module.exports = { createCortexTimerStore, toNode, fromNode };
