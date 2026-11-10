// Typed event bus. Every event is { type, t, ...payload }. on('*') sees all.
function createBus({ onError = () => {} } = {}) {
  const subs = new Map(); // type -> Set<fn>

  function on(type, fn) {
    if (!subs.has(type)) subs.set(type, new Set());
    subs.get(type).add(fn);
    return () => subs.get(type)?.delete(fn);
  }

  function deliver(set, ev) {
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(ev); } catch (err) { onError(err, ev); }
    }
  }

  function emit(type, payload = {}) {
    const ev = { ...payload, type, t: Date.now() };
    deliver(subs.get(type), ev);
    deliver(subs.get('*'), ev);
  }

  return { emit, on };
}

module.exports = { createBus };
