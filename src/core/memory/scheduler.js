// When to capture (W1 §5, memory spec §5): a chat is summarized and its facts proposed after the user switches
// away from it, after 10 minutes without a new message, or in the startup sweep (newest first, at most 5).
// Only while JARVIS is idle, one job at a time; a turn starting aborts the job and the chat is retried later.
// After a batch that proposed facts: one quiet notification.
const MIN_MESSAGES = 4, MIN_USER = 2;

function createCaptureScheduler({ sessions, extractor, chats, isIdle = () => true, getConfig = () => ({}), notify = () => {}, log = () => {},
  now = Date.now, idleMs = 600000, sweepMax = 5 }) {
  const queue = [];   // session ids, oldest request first
  let current = null; // { id, ac }
  let batch = 0;      // facts proposed since the queue was last empty
  const counts = { done: 0, failed: 0, aborted: 0 };

  const on = () => getConfig()?.memory?.autoCapture !== false;
  const enqueue = id => { if (id && !queue.includes(id) && current?.id !== id) queue.push(String(id)); };

  // ≥ 4 messages, ≥ 2 from the user, and no summary (or stub) newer than the chat
  function ready(s) {
    if (!s || !Array.isArray(s.messages) || s.messages.length < MIN_MESSAGES) return false;
    if (s.messages.filter(m => m.role === 'user').length < MIN_USER) return false;
    const node = chats.find(s.id);
    return !node || node.updated < (s.updated || 0);
  }

  function onSwitch(prevSessionId) { if (on() && prevSessionId) enqueue(prevSessionId); }

  function sweep() {
    if (!on()) return 0;
    let n = 0;
    for (const meta of sessions.list()) {
      if (n >= sweepMax) break;
      if (ready(sessions.load(meta.id))) { enqueue(meta.id); n++; }
    }
    return n;
  }

  function forget(id) { const i = queue.indexOf(String(id)); if (i >= 0) queue.splice(i, 1); }

  async function tick() {
    if (!on() || current) return;
    const newest = sessions.list()[0];
    if (newest && now() - newest.updated >= idleMs && !queue.includes(newest.id)) {
      const s = sessions.load(newest.id);
      if (ready(s)) enqueue(newest.id);
    }
    if (!queue.length || !isIdle()) return;
    const id = queue.shift();
    const s = sessions.load(id);
    if (ready(s)) {
      const ac = new AbortController();
      current = { id, ac };
      try {
        const r = await extractor.run(s, { signal: ac.signal, alive: () => !!sessions.load(id) });
        counts.done++;
        batch += r?.proposed || 0;
      } catch (err) {
        if (err?.name === 'AbortError' || ac.signal.aborted) { counts.aborted++; queue.unshift(id); }
        else { counts.failed++; log('memory capture failed: ' + (err?.message || err)); }
      } finally { current = null; }
    }
    if (!queue.length && batch > 0) {
      const n = batch; batch = 0;
      try { notify('JARVIS', `${n} new thing${n === 1 ? '' : 's'} to review in Memory`); } catch { /* best effort */ }
    }
  }

  function abort() { if (current && !current.ac.signal.aborted) current.ac.abort('turn'); }

  const stats = () => ({ queued: queue.length, running: current?.id ?? null, ...counts });

  return { ready, onSwitch, sweep, tick, abort, forget, stats };
}

module.exports = { createCaptureScheduler };
