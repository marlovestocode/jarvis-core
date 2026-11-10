// Listening tracker (pure logic, no browser APIs). Fed one sample per second from the YouTube Music page,
// it turns "what the player says right now" into one finished play record per track.
// Runs as a plain content script (logger-main.js is concatenated by the manifest: tracker.js loads first)
// and in Node for tests (module.exports at the bottom).
//
// sample: { videoId, title, artist, album, state, time, duration, list, like } | null
//   state: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
// emitted play: { id, videoId, title, artist, album, startedAt, endedAt, listenedMs, maxPos, duration,
//                 seeks, reason, list, like }   reason: track-change | ended | repeat | idle | closed
function createTracker({ emit, idleMs = 10 * 60 * 1000, minMs = 1000 } = {}) {
  let cur = null;

  function finalize(reason, now) {
    const c = cur; cur = null;
    if (!c || c.listenedMs < minMs) return;
    emit({
      id: `${c.startedAt}-${c.videoId}`, videoId: c.videoId, title: c.title, artist: c.artist, album: c.album,
      startedAt: c.startedAt, endedAt: c.lastAt || now, listenedMs: Math.round(c.listenedMs), maxPos: Math.round(c.maxPos * 10) / 10,
      duration: Math.round(c.duration * 10) / 10, seeks: c.seeks, reason, list: c.list || null, like: c.like || null,
    });
  }

  function start(s, now) {
    cur = {
      videoId: s.videoId, title: s.title || '', artist: s.artist || '', album: s.album || '', startedAt: now,
      listenedMs: 0, maxPos: s.time || 0, duration: s.duration || 0, seeks: 0, lastAt: now, lastPos: s.time || 0, lastState: s.state,
      pausedSince: null, list: s.list || null, like: s.like || null,
    };
  }

  function tick(s, now = Date.now()) {
    if (!s || !s.videoId) { if (cur) finalize('closed', now); return; }
    // a different track, or the same track started over (repeat one / replay): close the old play
    if (cur && cur.videoId !== s.videoId) finalize('track-change', now);
    else if (cur && s.state === 1 && cur.lastPos - s.time > 15 && s.time < 5) finalize('repeat', now);
    if (!cur) {
      if (s.state === 1 || s.state === 3) start(s, now);   // a play begins when sound is (about to be) playing
      return;
    }
    const dt = now - cur.lastAt;
    if (s.state === 1 && cur.lastState === 1) {
      cur.listenedMs += Math.min(dt, 3000);
      // position should advance by about dt; a bigger jump is a seek
      if (Math.abs(s.time - cur.lastPos - dt / 1000) > 4) cur.seeks++;
    }
    if (s.time > cur.maxPos) cur.maxPos = s.time;
    if (s.duration) cur.duration = s.duration;
    if (s.title) cur.title = s.title;
    if (s.artist) cur.artist = s.artist;
    if (s.album) cur.album = s.album;
    if (s.list) cur.list = s.list;
    if (s.like) cur.like = s.like;
    cur.lastAt = now; cur.lastPos = s.time || 0; cur.lastState = s.state;
    if (s.state === 0) { finalize('ended', now); return; }
    if (s.state === 2) {
      cur.pausedSince ??= now;
      if (now - cur.pausedSince > idleMs) finalize('idle', cur.pausedSince);
    } else cur.pausedSince = null;
  }

  return { tick, flush: (now = Date.now()) => finalize('closed', now), get current() { return cur; } };
}

if (typeof module !== 'undefined') module.exports = { createTracker };
