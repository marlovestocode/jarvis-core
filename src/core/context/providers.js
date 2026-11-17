// Provider adapters for the context assembler: read-only views over LiveState, the task runner and the Cortex memory block.
// Each factory returns { name, fetch(request) } and emits items in the assembler's exact shape; none of them ever throws, a missing or
// failing dependency yields []. Live items are observed at call time (now()); the window title is only emitted when the snapshot carries
// it and is private + untrusted (it is outside text). The pending confirm summary is never included. Task text is clipped to 160 chars.
// Memory lines come from block.forTurn: one item per recalled line after the header, ids aligned to line order, no timestamp (null).
const TEXT_MAX = 160;
const clip = (s, n = TEXT_MAX) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} sec`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

function liveProvider({ live, now = Date.now } = {}) {
  function fetch(request) {
    try {
      // the turn's own snapshot when the caller passes one (one snapshot per turn), else read it here
      const snap = request && isObj(request.snap) ? request.snap : live && typeof live.snapshot === 'function' ? live.snapshot() : null;
      if (!isObj(snap)) return [];
      const t = now();
      const base = { source: 'livestate', kind: 'state', observedAt: t, confidence: 0.9, trust: 'owner', sensitivity: 'personal' };
      const out = [];
      const w = snap.activeWindow;
      if (isObj(w) && typeof w.app === 'string' && w.app.trim()) {
        out.push({ ...base, id: 'live:window', text: clip(`Active window: ${w.app}`), topic: 'window', query: clip(w.app, 80) });
        if (typeof w.title === 'string' && w.title.trim()) {
          out.push({ ...base, id: 'live:title', text: clip(`Window title: ${w.title}`), topic: 'window-title', sensitivity: 'private', trust: 'untrusted' });
        }
      }
      const tm = snap.timers;
      if (isObj(tm) && typeof tm.count === 'number' && tm.count > 0) {
        let s = `${tm.count} timer${tm.count === 1 ? '' : 's'} running`;
        if (typeof tm.nextInMs === 'number' && Number.isFinite(tm.nextInMs)) s += `, next in ${dur(tm.nextInMs)}`;
        out.push({ ...base, id: 'live:timers', text: s, topic: 'timers' });
      }
      if (isObj(snap.media) && snap.media.playing === true) out.push({ ...base, id: 'live:media', text: 'Media is playing', topic: 'media' });
      return out;
    } catch { return []; }
  }
  return { name: 'livestate', fetch };
}

function taskProvider({ tasks, now = Date.now } = {}) {
  function fetch(request) {
    try {
      const a = request && isObj(request.snap) ? request.snap.task : tasks && typeof tasks.active === 'function' ? tasks.active() : null;
      if (!isObj(a) || a.id === undefined || a.id === null || a.id === '') return [];
      const steps = typeof a.done === 'number' && typeof a.total === 'number' ? ` (${a.done}/${a.total} steps done)` : '';
      const title = typeof a.title === 'string' ? clip(a.title) : '';
      const status = typeof a.status === 'string' && a.status.trim() ? a.status.trim() : 'running';
      const text = clip(`Task ${title ? `"${title}" ` : ''}is ${status}${steps}`);
      return [{ id: `task:${a.id}`, text, source: 'tasks', kind: 'task', observedAt: null, confidence: 0.8, trust: 'owner', sensitivity: 'personal', topic: 'task', ...(title ? { query: title } : {}) }];
    } catch { return []; }
  }
  return { name: 'tasks', fetch };
}

function memoryProvider({ block, getSessionId } = {}) {
  async function fetch(request) {
    try {
      if (!block || typeof block.forTurn !== 'function') return [];
      const req = isObj(request) ? request : {};
      let sessionId = req.sessionId;
      if (sessionId === undefined && typeof getSessionId === 'function') { try { sessionId = getSessionId(); } catch { sessionId = undefined; } }
      const args = { text: typeof req.text === 'string' ? req.text : '', sessionId, brief: req.brief === true };
      if (typeof req.context === 'string' && req.context) args.context = req.context;
      const r = await block.forTurn(args);
      const memo = r && typeof r.memo === 'string' ? r.memo : '';
      const ids = r && Array.isArray(r.ids) ? r.ids : [];
      if (!memo) return [];
      const lines = memo.split('\n').slice(1);
      const out = [];
      lines.forEach((raw, n) => {
        const text = clip(raw.replace(/^\s*-\s*/, '').replace(/\s*\[[^\]]*\]\s*$/, ''), 300);
        if (!text) return;
        const id = ids[n] !== undefined && ids[n] !== null && ids[n] !== '' ? ids[n] : `${n}`;
        out.push({ id: `mem:${id}`, text, source: 'cortex', kind: 'memory', observedAt: null, confidence: 0.6, trust: 'owner', sensitivity: 'personal' });
      });
      return out;
    } catch { return []; }
  }
  return { name: 'cortex', fetch };
}

module.exports = { liveProvider, taskProvider, memoryProvider };
