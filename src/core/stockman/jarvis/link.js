// The jarvis link port: everything StockMan says to jarvis goes through here, so jarvis can be swapped for a test double.
//   JarvisLink = { name, publish(topic, payload?), subscribe(topic, fn) → unsubscribe }
// Verified against the code: jarvis's bus (src/core/bus.js) is emit(type, payload) / on(type, fn) and stamps { type, t } on every event.
// StockMan uses one bus event type, 'stockman', with { topic, ...payload }. Keep payloads small and plain: the app forwards every
// bus event to its windows (src/main/main.js, bus.on('*')).
// Direction: StockMan → jarvis by events; jarvis → StockMan by reading through the tools in ./tools.js (vault D16: the engine owns
// stockman.db, jarvis reads). Nothing here lets jarvis write to the database.
const EVENT_TYPE = 'stockman';
const TOPIC = /^[a-z][a-z0-9._-]{0,63}$/;

function createBusLink({ bus }) {
  if (!bus || typeof bus.emit !== 'function' || typeof bus.on !== 'function') throw new TypeError('createBusLink needs a jarvis bus: { emit, on }');
  return {
    name: 'jarvis-bus',
    publish(topic, payload = {}) {
      if (!TOPIC.test(topic)) throw new TypeError(`bad topic: ${topic}`);
      bus.emit(EVENT_TYPE, { ...payload, topic });
    },
    subscribe(topic, fn) { return bus.on(EVENT_TYPE, ev => { if (ev.topic === topic) fn(ev); }); },
  };
}

// In-memory link: used when running outside jarvis (the CLI) and as the test double. Keeps what was published.
function createMemoryLink() {
  const subs = new Map(), events = [];
  return {
    name: 'memory',
    events,
    publish(topic, payload = {}) {
      if (!TOPIC.test(topic)) throw new TypeError(`bad topic: ${topic}`);
      const ev = { ...payload, topic, type: EVENT_TYPE, t: Date.now() };
      events.push(ev);
      for (const fn of [...(subs.get(topic) || [])]) { try { fn(ev); } catch { /* a listener must not stop the sender */ } }
    },
    subscribe(topic, fn) {
      if (!subs.has(topic)) subs.set(topic, new Set());
      subs.get(topic).add(fn);
      return () => subs.get(topic)?.delete(fn);
    },
  };
}

module.exports = { createBusLink, createMemoryLink, EVENT_TYPE };
