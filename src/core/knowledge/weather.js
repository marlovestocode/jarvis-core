// Weather from Open-Meteo (current, hourly, up to 7 days, air quality) and US alerts from the NWS.
// Only coordinates go out. Results carry their source and age; cached "last known" data says so.
const { describeAge } = require('./age');

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const ALERTS = 'https://api.weather.gov/alerts/active';
const TTL = 10 * 60000;
const ALERT_TTL = 5 * 60000;
const MAX_CHARS = 2500;

const WMO = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'heavy showers', 85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
};
const weatherWords = code => WMO[code] || 'unknown conditions';
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = deg => (Number.isFinite(deg) ? COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16] : '');
function aqiCategory(v) {
  if (!Number.isFinite(v)) return '';
  return v <= 50 ? 'good' : v <= 100 ? 'moderate' : v <= 150 ? 'unhealthy for sensitive groups' : v <= 200 ? 'unhealthy' : v <= 300 ? 'very unhealthy' : 'hazardous';
}
const r0 = v => (Number.isFinite(v) ? Math.round(v) : null);
const coord = v => Number(Number(v).toFixed(4));

async function getWeather(fetcher, place, { days = 2, hourly = false, units = 'F' } = {}) {
  const C = String(units).toUpperCase() === 'C';
  const n = Math.max(1, Math.min(7, Math.round(Number(days) || 2)));
  const url = `${FORECAST}?latitude=${coord(place.lat)}&longitude=${coord(place.lon)}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day' +
    '&hourly=temperature_2m,precipitation_probability,weather_code' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,uv_index_max,sunrise,sunset' +
    `&temperature_unit=${C ? 'celsius' : 'fahrenheit'}&wind_speed_unit=${C ? 'kmh' : 'mph'}&precipitation_unit=${C ? 'mm' : 'inch'}&timezone=auto&forecast_days=7`;
  const r = await fetcher.getJson('weather', url, { ttlMs: TTL });
  const f = r.data || {};
  const c = f.current || {};
  const d = f.daily || {};
  const out = {
    place: place.name, source: 'Open-Meteo', ageMs: r.ageMs, stale: !!r.stale,
    units: { temp: C ? '°C' : '°F', wind: C ? 'km/h' : 'mph', rain: C ? 'mm' : 'in' },
    observed: c.time || '',
    current: {
      temp: r0(c.temperature_2m), feels: r0(c.apparent_temperature), humidity: r0(c.relative_humidity_2m),
      wind: r0(c.wind_speed_10m), gusts: r0(c.wind_gusts_10m), windDir: compass(c.wind_direction_10m),
      conditions: weatherWords(c.weather_code), isDay: c.is_day === 1,
    },
    days: (d.time || []).slice(0, n).map((date, i) => ({
      date, high: r0(d.temperature_2m_max?.[i]), low: r0(d.temperature_2m_min?.[i]), conditions: weatherWords(d.weather_code?.[i]),
      rainChance: r0(d.precipitation_probability_max?.[i]), rain: d.precipitation_sum?.[i] ?? null, windMax: r0(d.wind_speed_10m_max?.[i]),
      uv: d.uv_index_max?.[i] ?? null, sunrise: (d.sunrise?.[i] || '').slice(11), sunset: (d.sunset?.[i] || '').slice(11),
    })),
    aqi: null,
  };
  if (hourly) {
    const h = f.hourly || {};
    const from = (c.time || '').slice(0, 13);
    let i0 = (h.time || []).findIndex(t => t.slice(0, 13) >= from);
    if (i0 < 0) i0 = 0;
    out.hourly = (h.time || []).slice(i0, i0 + 12).map((time, k) => ({
      time, temp: r0(h.temperature_2m?.[i0 + k]), rainChance: r0(h.precipitation_probability?.[i0 + k]), conditions: weatherWords(h.weather_code?.[i0 + k]),
    }));
  }
  try {
    const a = await fetcher.getJson('weather', `${AIR}?latitude=${coord(place.lat)}&longitude=${coord(place.lon)}&current=us_aqi,pm2_5`, { ttlMs: TTL });
    const v = a.data?.current?.us_aqi;
    if (Number.isFinite(v)) out.aqi = { value: Math.round(v), category: aqiCategory(v) };
  } catch { /* air quality is a bonus */ }
  return out;
}

const dayName = (iso, i) => (i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }));

function formatWeather(w) {
  const u = w.units;
  const c = w.current;
  const lines = [`Weather for ${w.place} (source: ${w.source}, ${describeAge(w.ageMs, w.stale)}${w.observed ? `, observed ${w.observed.replace('T', ' ')} local` : ''}):`];
  lines.push(`Now: ${c.temp}${u.temp}, ${c.conditions}, feels like ${c.feels}${u.temp}, humidity ${c.humidity}%, wind ${c.windDir} ${c.wind} ${u.wind}${c.gusts ? ` gusting ${c.gusts}` : ''}.`);
  if (w.aqi) lines.push(`Air quality: AQI ${w.aqi.value} (${w.aqi.category}).`);
  w.days.forEach((d, i) => lines.push(`${dayName(d.date, i)} (${d.date}): high ${d.high}${u.temp}, low ${d.low}${u.temp}, ${d.conditions}, ${d.rainChance ?? '?'}% chance of rain${d.rain ? ` (${d.rain} ${u.rain})` : ''}, wind up to ${d.windMax} ${u.wind}, UV ${d.uv ?? '?'}${d.sunrise ? `, sunrise ${d.sunrise}, sunset ${d.sunset}` : ''}.`));
  if (w.hourly) lines.push('Next hours: ' + w.hourly.map(h => `${h.time.slice(11)} ${h.temp}${u.temp} ${h.rainChance ?? '?'}% ${h.conditions}`).join('; ') + '.');
  return lines.join('\n').slice(0, MAX_CHARS);
}

const SEV = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };

async function getAlerts(fetcher, place) {
  if (place.country && place.country !== 'US') throw new Error('weather alerts are only available for the US');
  const r = await fetcher.getJson('weather', `${ALERTS}?point=${coord(place.lat)},${coord(place.lon)}`, { ttlMs: ALERT_TTL, headers: { Accept: 'application/geo+json' } });
  const alerts = (r.data?.features || []).map(x => x.properties || {}).map(p => ({
    event: p.event || 'Alert', severity: p.severity in SEV ? p.severity : 'Unknown', headline: p.headline || '', ends: p.ends || p.expires || '',
  })).sort((a, b) => SEV[a.severity] - SEV[b.severity]);
  return { place: place.name, source: 'National Weather Service', ageMs: r.ageMs, stale: !!r.stale, alerts };
}

function formatAlerts(a) {
  const head = `Weather alerts for ${a.place} (source: ${a.source}, ${describeAge(a.ageMs, a.stale)}):`;
  if (!a.alerts.length) return `${head}\nNo active weather alerts (watches, warnings or advisories).`;
  const lines = [head];
  for (const x of a.alerts) {
    const line = `- ${x.event} [${x.severity}]${x.ends ? `, until ${x.ends}` : ''}: ${x.headline}`;
    if (lines.join('\n').length + line.length > MAX_CHARS - 40) { lines.push(`(+${a.alerts.length - lines.length + 1} more)`); break; }
    lines.push(line);
  }
  return lines.join('\n');
}

module.exports = { getWeather, getAlerts, formatWeather, formatAlerts, weatherWords, compass, aqiCategory };
