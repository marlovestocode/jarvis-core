// Several forecast models for home in ONE Open-Meteo call (an already-allowed host; only coordinates go out), blended into a consensus.
// The series is hourly from now: gust (mph), precip (in), cape (J/kg), pressure (hPa), code (WMO). A model with no data (HRRR outside the US) is left out.
const MODELS = Object.freeze(['gfs_seamless', 'ecmwf_ifs025', 'icon_seamless', 'gem_seamless', 'ncep_hrrr_conus']);
const VARS = Object.freeze({ gust: 'wind_gusts_10m', precip: 'precipitation', cape: 'cape', pressure: 'pressure_msl', code: 'weather_code', temp: 'temperature_2m' });
const TTL = 15 * 60000;
const HOURS = 48;
const coord = v => Number(Number(v).toFixed(4));

function parseModelSeries(json) {
  const h = json?.hourly || {};
  const time = Array.isArray(h.time) ? h.time : [];
  const models = {};
  for (const m of MODELS) {
    const o = {};
    for (const [k, v] of Object.entries(VARS)) o[k] = Array.isArray(h[`${v}_${m}`]) ? h[`${v}_${m}`] : [];
    if (o.gust.some(Number.isFinite) || o.precip.some(Number.isFinite)) models[m] = o;
  }
  return { time, models };
}

async function getModelSeries(fetcher, place) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${coord(place.lat)}&longitude=${coord(place.lon)}` +
    `&hourly=${Object.values(VARS).join(',')}&models=${MODELS.join(',')}` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&forecast_hours=${HOURS}&timezone=auto`;
  const r = await fetcher.getJson('weather', url, { ttlMs: TTL });
  return { ...parseModelSeries(r.data), ageMs: r.ageMs, stale: !!r.stale };
}

const fin = Number.isFinite;
function stat(vals) {
  const v = vals.filter(x => fin(x.v));
  if (!v.length) return { mean: null, max: null, spread: null, values: [] };
  const wsum = v.reduce((s, x) => s + x.w, 0);
  const mean = v.reduce((s, x) => s + x.v * x.w, 0) / wsum;
  const spread = Math.sqrt(v.reduce((s, x) => s + x.w * (x.v - mean) ** 2, 0) / wsum);
  return { mean: +mean.toFixed(2), max: Math.max(...v.map(x => x.v)), spread: +spread.toFixed(2), values: v.map(x => x.v) };
}

// weights: { model: number } (missing = 1). Per hour and field: weighted mean, max and spread (small spread = the models agree).
function consensus(series, weights = {}) {
  const names = Object.keys(series.models || {});
  return (series.time || []).map((time, i) => {
    const out = { time, models: names.length };
    for (const f of Object.keys(VARS)) out[f] = stat(names.map(n => ({ v: series.models[n][f]?.[i], w: Math.max(0.01, Number(weights[n]) || 1) })));
    return out;
  });
}

module.exports = { MODELS, getModelSeries, parseModelSeries, consensus };
