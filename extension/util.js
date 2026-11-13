// Small pure helpers for the background worker (ES module; tested in Node, see test/ext-util.test.js).

// Reconnect delay: base * 2^attempt, capped, with jitter so many tabs/profiles do not retry in step.
export function backoff(attempt, { baseMs = 2000, maxMs = 30000, jitter = 0.5, random = Math.random } = {}) {
  const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(raw * (1 - jitter) + raw * jitter * random());
}

// Runs async functions one at a time, in order. chrome.storage reads and writes are not atomic as a pair, so two plays arriving
// together used to read the same list and one write erased the other.
export function createQueue() {
  let tail = Promise.resolve();
  return fn => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

// A short, safe description of a command for the activity list. Never includes keys, page text or long values.
export function describeArgs(args) {
  const a = args && typeof args === 'object' ? args : {};
  const pick = [a.query, a.title, a.name, a.url, a.id, a.mode, a.value, a.index].find(v => v !== undefined && v !== null && v !== '');
  if (pick === undefined) return '';
  let s = String(pick).replace(/\s+/g, ' ');
  try { const u = new URL(s); s = `${u.protocol}//${u.host}` + (u.pathname.length > 1 ? u.pathname.slice(0, 30) : ''); } catch { /* not a URL */ }   // never the query string
  return s.slice(0, 60);
}

// Newest last, at most max entries.
export function pushRing(list, item, max = 100) {
  const out = [...list, item];
  return out.length > max ? out.slice(out.length - max) : out;
}
