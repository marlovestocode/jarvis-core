// Monitor runner: every 30 s, one live snapshot, then each enabled monitor may hand the engine one item of text.
function createMonitors({ engine, live, getConfig, monitors, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = 30000, log = () => {} }) {
  const states = new Map(), logged = new Set();
  let running = false, handle = null, stopped = true;
  const cfgOf = () => getConfig()?.proactive?.monitors || {};
  const warn = (id, e) => { if (logged.has(id)) return; logged.add(id); log(`[proactive] monitor ${id} failed: ${e?.message || e}`); };

  async function tick() {
    if (running) return;
    running = true;
    try {
      const cfg = cfgOf();
      const on = monitors.filter(m => { try { return m.enabled(cfg); } catch (e) { warn(m.id, e); return false; } });
      if (!on.length) return;
      const snap = live.snapshot();
      for (const m of on) {
        try {
          if (!states.has(m.id)) states.set(m.id, {});
          const item = await m.check(snap, cfg, states.get(m.id), now());
          if (item) engine.push({ ...item, monitor: true });
        } catch (e) { warn(m.id, e); }
      }
    } catch (e) { warn('runner', e); }
    finally { running = false; }
  }

  const arm = () => { handle = setTimer(async () => { await tick(); if (!stopped) arm(); }, intervalMs); handle?.unref?.(); };
  return {
    tick,
    start() { if (!stopped) return; stopped = false; arm(); },
    stop() { stopped = true; if (handle != null) clearTimer(handle); handle = null; },
  };
}

module.exports = { createMonitors };
