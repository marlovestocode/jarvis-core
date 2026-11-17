// weatherAlerts monitor: says once when a Severe or Extreme National Weather Service alert is active for home.
// getAlerts() → { alerts: [{ event, severity, ends }] } (knowledge/weather.getAlerts for the home place). Text is built from the
// alert's event name only, never its headline or description. Checked every 10 min; throws (not US, lookups off) are logged once by the runner.
const { clip } = require('./clip');

const EVERY = 10 * 60000, LOUD = new Set(['Extreme', 'Severe']);

function createWeatherAlertsMonitor({ getAlerts }) {
  return {
    id: 'weatherAlerts',
    enabled: cfg => !!cfg?.weatherAlerts?.enabled,
    async check(_snap, _cfg, state, now) {
      if (now < (state.nextAt || 0)) return null;
      state.nextAt = now + EVERY;
      const r = await getAlerts();
      const live = (Array.isArray(r?.alerts) ? r.alerts : []).filter(a => LOUD.has(a?.severity) && clip(a.event));
      const told = state.told || (state.told = new Set());
      const keys = new Set(live.map(a => `${clip(a.event)}|${a.ends || ''}`));
      for (const k of told) if (!keys.has(k)) told.delete(k);   // an alert that ended can be announced again if it returns
      for (const a of live) {
        const key = `${clip(a.event)}|${a.ends || ''}`;
        if (told.has(key)) continue;
        told.add(key);
        return { kind: 'info', key: `weather:${key}`, text: `Weather alert: ${clip(a.event)} (${a.severity.toLowerCase()}) for your area.` };
      }
      return null;
    },
  };
}

module.exports = { createWeatherAlertsMonitor };
