// lowBattery monitor: says so once when the battery drops to cfg.lowBattery.percent while not charging. Armed again after
// charging starts or the level climbs 5 points above the limit; at most once per 15 min. getBattery() → { percent, charging, minutes? } | null
// (pc host battery; null = a desktop, nothing to say).
const COOLDOWN = 15 * 60000, HYST = 5;

function createLowBatteryMonitor({ getBattery }) {
  return {
    id: 'lowBattery',
    enabled: cfg => !!cfg?.lowBattery?.enabled,
    async check(_snap, cfg, state, now) {
      const b = await getBattery();
      if (!b || !Number.isFinite(b.percent)) return null;
      const limit = cfg?.lowBattery?.percent ?? 20;
      if (b.charging || b.percent >= limit + HYST) state.armed = true;
      if (b.charging || b.percent > limit || state.armed === false || now - (state.lastAt ?? -Infinity) < COOLDOWN) return null;
      state.armed = false; state.lastAt = now;
      const left = Number.isFinite(b.minutes) && b.minutes > 0 ? `, about ${b.minutes >= 60 ? `${Math.floor(b.minutes / 60)} h${b.minutes % 60 ? ` ${b.minutes % 60} min` : ''}` : `${b.minutes} min`} left` : '';
      return { kind: 'info', key: 'battery:low', cooldownMs: COOLDOWN, text: `Battery is at ${Math.round(b.percent)}% and not charging${left}.` };
    },
  };
}

module.exports = { createLowBatteryMonitor };
