// Per-turn voice timing. mark(name) records the first time each name is hit; summary() reports ms
// offsets from the first mark plus the deltas the latency work cares about (null when a mark is missing).
// Pure: no fs, no bus. The controller owns when to mark and where the summary goes.
function createTrace({ now = () => performance.now() } = {}) {
  let marks = {};
  let t0 = null;

  const off = k => (k in marks ? marks[k] : null);
  const gap = (a, b) => (off(a) === null || off(b) === null ? null : Math.round(marks[b] - marks[a]));

  return {
    now,
    // `at` lets a caller back-date a mark (e.g. the VAD end that happened before the wake was confirmed)
    mark(name, at = now()) {
      if (name in marks) return;
      if (t0 === null || at < t0) {
        const shift = t0 === null ? 0 : t0 - at;
        for (const k of Object.keys(marks)) marks[k] += shift;
        t0 = at;
      }
      marks[name] = Math.round(at - t0);
    },
    reset() { marks = {}; t0 = null; },
    get empty() { return t0 === null; },
    summary() {
      return {
        marks: { ...marks },
        speech_end_to_stt: gap('speech_end', 'stt_done'),
        stt_to_first_token: gap('stt_done', 'first_token'),
        speech_end_to_first_audio: gap('speech_end', 'first_audio'),
        total: t0 === null ? null : Math.max(0, ...Object.values(marks)),
      };
    },
  };
}

module.exports = { createTrace };
