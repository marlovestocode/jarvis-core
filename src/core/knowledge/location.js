// Where a weather question is about: the configured home, or a place geocoded with Open-Meteo.
// Only the place name goes out. Ambiguous names return candidates so the model can ask which one.
const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const TTL = 7 * 24 * 3600 * 1000;

const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};
const HOME = /^(?:|here|home|my area|my location|local|nearby|outside|current location)$/i;

function home(config) {
  const l = config.location;
  return { name: l.city, lat: l.lat, lon: l.lon, country: 'US', admin1: '', home: true };
}
const label = r => `${r.name}, ${r.admin1 || r.country || r.country_code}`;
const toPlace = r => ({ name: label(r), lat: r.latitude, lon: r.longitude, country: r.country_code, admin1: r.admin1 || '', timezone: r.timezone });

async function resolvePlace(fetcher, text, config) {
  const q = String(text || '').trim().replace(/[.?!]+$/, '');
  if (HOME.test(q) || q.toLowerCase() === String(config.location.city).toLowerCase()) return home(config);
  const [city, ...rest] = q.split(',').map(s => s.trim()).filter(Boolean);
  const region = rest.join(' ').toLowerCase();
  const url = `${GEO}?name=${encodeURIComponent(city)}&count=10&language=en&format=json`;
  const { data } = await fetcher.getJson('weather', url, { ttlMs: TTL });
  let list = Array.isArray(data?.results) ? data.results : [];
  if (region) {
    const full = (STATES[region.toUpperCase()] || region).toLowerCase();
    list = list.filter(r => [r.admin1, r.country, r.country_code].some(v => String(v || '').toLowerCase() === full || String(v || '').toLowerCase() === region));
  }
  if (!list.length) return { candidates: [] };
  const [a, b] = list;
  // one clear winner: only result, or far bigger than the next one with the same name
  if (!b || region || (a.population || 0) >= 5 * (b.population || 0)) return toPlace(a);
  return { candidates: list.slice(0, 5).map(label) };
}

module.exports = { resolvePlace, STATES };
