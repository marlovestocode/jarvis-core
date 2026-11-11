// Memory watch: one timer reads this process's memory and the numbers of every part that has a budget.
// The convention for such a part: stats() → plain numbers (its use and its cap), and trim() when it can
// give memory back without losing data (the fetcher drops its memory cache; the disk copies still answer).
// Levels by resident memory: ok, warn (≥ warnMB), critical (≥ criticalMB). While not ok every check asks
// the parts to trim. A change of level is logged with all numbers and put on the bus as 'memory'.
const MB = 1024 * 1024;
const WARN_MB = 400;       // the main process measured 139 MB right after boot and 57 MB after a day idle (2026-11-11)
const CRITICAL_MB = 800;

function createMemWatch({ sources = {}, bus = null, log = () => {}, usage = () => process.memoryUsage(), warnMB = WARN_MB, criticalMB = CRITICAL_MB, intervalMs = 60000 } = {}) {
  let level = 'ok', peakMB = 0, timer = null;
  const mb = n => Math.round(n / MB);

  function components() {
    const out = {};
    for (const [name, s] of Object.entries(sources)) { try { out[name] = s.stats?.() ?? null; } catch { out[name] = null; } }
    return out;
  }

  function snapshot() {
    const u = usage();
    peakMB = Math.max(peakMB, mb(u.rss));
    return { level, rssMB: mb(u.rss), heapMB: mb(u.heapUsed), externalMB: mb(u.external), peakMB, warnMB, criticalMB, components: components() };
  }

  function check() {
    const rssMB = mb(usage().rss);
    const next = rssMB >= criticalMB ? 'critical' : rssMB >= warnMB ? 'warn' : 'ok';
    if (next !== 'ok') for (const s of Object.values(sources)) { try { s.trim?.(); } catch { /* one part must not stop the others */ } }
    const changed = next !== level;
    level = next;
    const snap = snapshot();
    if (changed) {
      log(`memory ${level === 'ok' ? 'ok' : 'warn: ' + level}: ${JSON.stringify(snap)}`);
      try { bus?.emit('memory', snap); } catch { /* listeners */ }
    }
    return snap;
  }

  function start() {
    if (timer) return;
    timer = setInterval(check, intervalMs);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); timer = null; }

  return { check, snapshot, start, stop, get level() { return level; } };
}

module.exports = { createMemWatch, WARN_MB, CRITICAL_MB };
