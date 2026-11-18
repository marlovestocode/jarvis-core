// Home weather threat: several models blended (weighted by how well each did at home), NWS alerts, the forecast pressure trend → one threat.
// Hosts: api.open-meteo.com and api.weather.gov, both already allowed. Only the home coordinates go out.
const { getModelSeries, consensus } = require('./weather-models');
const { getAlerts } = require('./weather');
const { assessThreat } = require('./weather-threat');
const { getRadarCells } = require('./radar');

const OBS_TTL = 20 * 60000;
const SEV = { Extreme: 'extreme', Severe: 'severe' };
const coord = v => Number(Number(v).toFixed(4));

// Latest air temperature (°F) and sea-level pressure (hPa) at the nearest NWS station, or null. Used to score the models, so it is optional.
async function getObservationFull(fetcher, place) {
  try {
    const pt = await fetcher.getJson('weather', `https://api.weather.gov/points/${coord(place.lat)},${coord(place.lon)}`, { ttlMs: 24 * 3600000, headers: { Accept: 'application/geo+json' } });
    const list = pt.data?.properties?.observationStations;
    if (typeof list !== 'string' || !list.startsWith('https://api.weather.gov/')) return null;
    const st = await fetcher.getJson('weather', list, { ttlMs: 24 * 3600000, headers: { Accept: 'application/geo+json' } });
    const id = st.data?.features?.[0]?.properties?.stationIdentifier;
    if (!/^[A-Za-z0-9]{3,6}$/.test(id || '')) return null;
    const ob = await fetcher.getJson('weather', `https://api.weather.gov/stations/${id}/observations/latest`, { ttlMs: OBS_TTL, headers: { Accept: 'application/geo+json' } });
    const p = ob.data?.properties, c = p?.temperature?.value, pa = p?.seaLevelPressure?.value;
    if (!Number.isFinite(c) && !Number.isFinite(pa)) return null;
    return { tempF: Number.isFinite(c) ? Math.round(c * 9 / 5 + 32) : null, pressureHpa: Number.isFinite(pa) ? Math.round(pa / 10) / 10 : null };
  } catch { return null; }
}
// temperature only (°F), or null
async function getObservation(fetcher, place) { return (await getObservationFull(fetcher, place))?.tempF ?? null; }

async function assessHome(fetcher, place, { tracker = null, now = Date.now, radarSize = 256, radarHalfKm = 150 } = {}) {
  const series = await getModelSeries(fetcher, place);   // a forecast that cannot be had is an error the caller reports
  let alerts = [];
  if (!place.country || place.country === 'US') { try { alerts = (await getAlerts(fetcher, place)).alerts; } catch { /* alerts are a bonus on top of the models */ } }
  const names = Object.keys(series.models);
  if (tracker && series.time.length) {
    const obs = await getObservationFull(fetcher, place);
    if (obs?.tempF !== null && obs?.tempF !== undefined) tracker.observe(series.time[0], obs.tempF, 'temp');
    if (obs?.pressureHpa !== null && obs?.pressureHpa !== undefined) tracker.observe(series.time[0], obs.pressureHpa, 'pressure');
    for (let k = 1; k <= 3 && k < series.time.length; k++) for (const v of ['temp', 'pressure']) tracker.predict(series.time[k], Object.fromEntries(names.map(n => [n, series.models[n][v]?.[k]])), v);
  }
  const weights = tracker ? tracker.weights(names) : {};
  const hours = consensus(series, weights);
  const p0 = hours[0]?.pressure?.mean, p3 = hours[3]?.pressure?.mean;
  const pressureTrend = Number.isFinite(p0) && Number.isFinite(p3) ? { hPaPer3h: p3 - p0 } : null;
  let radar = null;   // US only; a radar service that is down or has nothing just leaves the forecast threat
  if (!place.country || place.country === 'US') { try { radar = await getRadarCells(fetcher, place, now(), { size: radarSize, halfKm: radarHalfKm }); } catch { /* optional */ } }
  const threat = assessThreat({ hours, alerts, pressureTrend, radar });
  const polys = [];
  for (const a of alerts) for (const ring of a.rings || []) if (SEV[a.severity] && polys.length < 8) polys.push({ sev: SEV[a.severity], ring });
  return {
    place: place.name, threat, polys, models: names.length, weights, ageMs: series.ageMs, stale: series.stale,
    alerts: alerts.filter(a => SEV[a.severity]).map(a => ({ event: a.event, severity: a.severity })),
  };
}

const KIND = { wind: 'damaging wind', flood: 'flooding rain', storm: 'thunderstorms', alert: 'a National Weather Service warning' };

// Short spoken phrase: what and when, from structural fields only.
function threatPhrase(t) {
  const eta = t.etaHours === null || t.etaHours === undefined ? '' : t.etaHours < 1 ? ' within the hour' : ` in about ${Math.round(t.etaHours)} hour${Math.round(t.etaHours) === 1 ? '' : 's'}`;
  return `${KIND[t.kind] || 'severe weather'}${eta}`;
}

function formatThreat(r) {
  const t = r.threat;
  if (t.level === 'none') return `No weather threat for ${r.place || 'home'}: ${r.models} forecast model${r.models === 1 ? '' : 's'} checked${t.reasons.length ? `. Note: ${t.reasons.join('; ')}` : ''}.`;
  const eta = t.etaHours === null ? '' : t.etaHours < 1 ? ' within the hour' : ` in about ${Math.round(t.etaHours)} hour${Math.round(t.etaHours) === 1 ? '' : 's'}`;
  return `Weather threat for ${r.place || 'home'}: ${t.level.toUpperCase()}, ${KIND[t.kind] || 'severe weather'}${eta}. ${t.reasons.join('; ')}.`;
}

// One shared, cached assessment of home for the monitor, the tool and the HUD. Each fresh one is sent on the bus as a 'weather' event (structure only).
function createHomeWatch({ fetcher, getConfig, bus, tracker = null, now = Date.now, ttlMs = 5 * 60000 }) {
  let cur = null, at = -Infinity, pending = null;
  async function refresh() {
    const l = getConfig().location || {};
    if (!Number.isFinite(l.lat) || !Number.isFinite(l.lon)) return null;
    if (cur && now() - at < ttlMs) return cur;
    if (!pending) pending = (async () => {
      try {
        cur = await assessHome(fetcher, { name: l.city || 'home', lat: l.lat, lon: l.lon, country: l.country }, { tracker });
        at = now();
        bus?.emit('weather', { level: cur.threat.level, kind: cur.threat.kind || undefined, etaHours: cur.threat.etaHours ?? undefined, polys: cur.polys });
        return cur;
      } finally { pending = null; }
    })();
    return pending;
  }
  return { refresh, last: () => cur };
}

module.exports = { assessHome, getObservation, getObservationFull, formatThreat, threatPhrase, createHomeWatch };
