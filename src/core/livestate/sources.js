// Pull sources for LiveState that need more than a one-liner.
const MAX_UPCOMING = 5;

// list() returns timers sorted by due. A throwing list() propagates; livestate catches it.
function timersSource({ list, now = Date.now }) {
  return () => {
    const l = list() || [];
    if (!l.length) return null;
    const t = now();
    const upcoming = l
      .filter((x) => x.due > t)
      .sort((a, b) => a.due - b.due)
      .slice(0, MAX_UPCOMING)
      .map(({ id, label, kind, due }) => ({ id, label, kind, due }));
    return { count: l.length, nextInMs: Math.max(0, Math.min(...l.map((x) => x.due)) - t), upcoming };
  };
}

module.exports = { timersSource, MAX_UPCOMING };
