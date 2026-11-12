// sysmon monitor: speaks when CPU, RAM, disk or temperature crosses its limit (5 point hysteresis, 15 min per metric).
const { SYSMON } = require('../../net/services');

const COOLDOWN = 15 * 60000, HYST = 5, CACHE_MS = 30000;
const NAMES = { ram: 'RAM', cpu: 'CPU', disk: 'Disk', temp: 'Temperature' };
const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
const maxOf = a => { const n = a.map(num).filter(v => v !== null); return n.length ? Math.max(...n) : null; };

function createSysmonStats({ fetch = globalThis.fetch, timeoutMs = 3000, now = Date.now } = {}) {
  let cached = null, at = -Infinity;
  return async function getStats() {
    if (cached && now() - at < CACHE_MS) return cached;
    try {
      const r = await fetch(`${SYSMON}/snapshot`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return null;
      const s = await r.json();
      if (!s || typeof s !== 'object' || !s.t) return null;
      cached = {
        cpu: num(s.cpu?.load), ram: num(s.mem?.pct),
        disk: maxOf(Array.isArray(s.disk?.volumes) ? s.disk.volumes.map(v => v?.pct) : []),
        temp: maxOf([s.cpu?.temp, s.gpu?.temp]),
      };
      at = now();
      return cached;
    } catch { return null; }
  };
}

function createSysmonMonitor({ getStats, log = () => {} }) {
  let failing = false;
  return {
    id: 'sysmon',
    enabled: cfg => !!cfg?.sysmon?.enabled,
    async check(_snap, cfg, state, now) {
      let stats = null;
      try { stats = await getStats(); } catch {}
      if (!stats) { if (!failing) { failing = true; log('[proactive] sysmon stats unavailable'); } return null; }
      failing = false;
      let best = null;
      for (const m of Object.keys(NAMES)) {
        const limit = cfg?.sysmon?.[m], v = stats[m];
        if (typeof limit !== 'number' || v == null) continue;
        const st = state[m] || (state[m] = { armed: true, lastAt: -Infinity });
        if (v <= limit - HYST) st.armed = true;
        if (v >= limit && st.armed !== false && now - st.lastAt >= COOLDOWN && (!best || v - limit > best.over)) best = { m, v, limit, over: v - limit };
      }
      if (!best) return null;
      const st = state[best.m]; st.armed = false; st.lastAt = now;
      const u = best.m === 'temp' ? '°C' : '%';
      return { kind: 'info', key: `sysmon:${best.m}`, cooldownMs: COOLDOWN, text: `${NAMES[best.m]} is at ${Math.round(best.v)}${u}, over your ${best.limit}${u} limit.` };
    },
  };
}

module.exports = { createSysmonMonitor, createSysmonStats };
