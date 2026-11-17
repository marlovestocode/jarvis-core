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
  return { name: l.city, lat: l.lat, lon: l.lon, country: l.country || 'US', admin1: '', home: true };
}
const label = r => `${r.name}, ${r.admin1 || r.country || r.country_code}`;
const toPlace = r => ({ name: label(r), lat: r.latitude, lon: r.longitude, country: r.country_code, admin1: r.admin1 || '', timezone: r.timezone });

async function resolvePlace(fetcher, text, config) {
  const q = String(text || '').trim().replace(/[.?!]+$/, '');
  if (HOME.test(q) || q.toLowerCase() === String(config.location.city).toLowerCase()) return home(config);
  const list = await searchPlaces(fetcher, q);
  if (list.length) return pick(list, q);
  return fuzzy(fetcher, q);
}

// one clear match → the place; several close ones → candidates to ask about
function pick(list, q) {
  const [a, b] = list;
  if (!b || q.includes(',') || (a.population || 0) >= 5 * (b.population || 0)) return toPlace(a);
  return { candidates: list.slice(0, 5).map(label) };
}

const plain = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function distance(a, b) {   // Levenshtein
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}
const similarity = (a, b) => 1 - distance(a, b) / Math.max(a.length, b.length, 1);

// Nothing matched the name as typed. Try, in order: a trailing state/country word ("Springfield Illinois", "Springfield MO"), the city
// alone when the region matched nothing, the name without accents/capitals and with doubled letters collapsed, then a prefix search ranked
// by spelling. A guess is never returned as the place: only an exact-name retry resolves, a spelling guess comes back as candidates to ask about.
async function fuzzy(fetcher, q) {
  if (q.includes(',')) {
    const found = await searchPlaces(fetcher, q.split(',')[0].trim());
    if (found.length) return { candidates: [...new Set(found.slice(0, 5).map(label))] };
  } else {
    const words = q.split(/\s+/);
    for (const k of [1, 2]) {
      if (words.length <= k) continue;
      const qq = `${words.slice(0, -k).join(' ')}, ${words.slice(-k).join(' ')}`;
      const found = await searchPlaces(fetcher, qq);
      if (found.length) return pick(found, '');   // the region was a guess at a word, so several matches still ask
    }
  }
  const tried = new Set([q]);
  for (const qq of [plain(q), plain(q).replace(/([a-z])\1+/g, '$1')]) {
    if (!qq || tried.has(qq)) continue;
    tried.add(qq);
    const found = await searchPlaces(fetcher, qq);
    if (found.length) return pick(found, qq);
  }
  const city = q.split(',')[0].trim();
  if (city.length < 4) return { candidates: [] };
  const found = await searchPlaces(fetcher, city.slice(0, 3));
  const want = plain(city);
  const ranked = found.map(r => ({ r, s: similarity(want, plain(r.name)) })).filter(x => x.s >= 0.6).sort((x, y) => y.s - x.s);
  return { candidates: [...new Set(ranked.slice(0, 5).map(x => label(x.r)))] };
}

async function searchPlaces(fetcher, text) {
  const [city, ...rest] = String(text).trim().split(',').map(s => s.trim()).filter(Boolean);
  if (!city) return [];
  const region = rest.join(' ').toLowerCase();
  const url = `${GEO}?name=${encodeURIComponent(city)}&count=10&language=en&format=json`;
  const { data } = await fetcher.getJson('weather', url, { ttlMs: TTL });
  let list = Array.isArray(data?.results) ? data.results : [];
  if (region) {
    const full = (STATES[region.toUpperCase()] || region).toLowerCase();
    list = list.filter(r => [r.admin1, r.country, r.country_code].some(v => String(v || '').toLowerCase() === full || String(v || '').toLowerCase() === region));
  }
  return list;
}

module.exports = { resolvePlace, searchPlaces, toPlace, STATES };
