// LiveState source: the app in front of the user. read() is synchronous and never touches the host: it serves a
// short-lived cache and, when that is stale, starts ONE background refresh (foreground + windows from the PC host).
// A missing or failing host just leaves the source empty (livestate skips a source that returns null).
//
// PRIVACY: a window title can hold private text (a bank page, a document name), so it is kept only when
// includeTitle() is true (config livestate.windowTitle, default false). Even then it is untrusted outside text:
// it is never put in the prompt (liveLine ignores it), never emitted on the bus and never persisted.
const MAX_TITLE = 200;

function createActiveWindow({ host, includeTitle = () => false, now = Date.now, ttlMs = 2000, maxAgeMs = 15000 } = {}) {
  let cache = null; // { app, title?, at }
  let inflight = false;
  let lastTry = -Infinity;

  async function refresh() {
    try {
      const h = await host.foreground();
      const ws = await host.windows();
      const w = h ? (Array.isArray(ws) ? ws : []).find(x => x && x.hwnd === h) : null;
      cache = w && typeof w.app === 'string' && w.app
        ? { app: w.app.slice(0, 80), title: typeof w.title === 'string' ? w.title.slice(0, MAX_TITLE) : '', at: now() }
        : null;
    } catch { cache = null; } finally { inflight = false; }
  }

  function read() {
    if (!host || typeof host.foreground !== 'function' || typeof host.windows !== 'function') return null;
    const t = now();
    if (!inflight && t - lastTry >= ttlMs) {
      inflight = true;
      lastTry = t;
      refresh();
    }
    if (!cache || t - cache.at > maxAgeMs) return null;
    let withTitle = false;
    try { withTitle = includeTitle() === true; } catch { /* off */ }
    return withTitle && cache.title ? { app: cache.app, title: cache.title } : { app: cache.app };
  }

  return { name: 'activeWindow', read };
}

module.exports = { createActiveWindow };
