// Where the wallpaper globe should look: a continent by name, or any place geocoded with Open-Meteo (same source and allowlist as weather).
// Only the place name goes out. The result is numbers and a short name; the wallpaper never gets words (see the bridge allowlist).
const { searchPlaces } = require('./location');

const CONTINENTS = new Set(['africa', 'asia', 'europe', 'north america', 'south america', 'oceania', 'antarctica']);
// Space: the wallpaper has the Moon, the Sun and every planet, at their real positions and distances for today. Names are checked before places
// (a bare "Mars" or "Venus" means the planet); "Mars, Texas" has a comma and is geocoded like any place.
const SPACE = { moon: 'moon', 'the moon': 'moon', luna: 'moon', sun: 'sun', 'the sun': 'sun', mercury: 'mercury', venus: 'venus', mars: 'mars', jupiter: 'jupiter', saturn: 'saturn', uranus: 'uranus', neptune: 'neptune',
  earth: 'earth', 'the earth': 'earth', 'planet earth': 'earth', 'solar system': 'solar', 'the solar system': 'solar', 'planets': 'solar', 'the planets': 'solar', 'outer space': 'solar', space: 'solar', 'comets': 'solar', 'the comets': 'solar',
  'earth sun and moon': 'system', 'sun earth moon': 'system', 'earth and moon': 'system', 'galilean moons': 'jupiter', 'the galilean moons': 'jupiter', 'jupiters moons': 'jupiter', 'moons of jupiter': 'jupiter', 'moons of saturn': 'saturn',
  io: 'io', europa: 'europa', ganymede: 'ganymede', callisto: 'callisto', mimas: 'mimas', enceladus: 'enceladus', tethys: 'tethys', dione: 'dione', rhea: 'rhea', titan: 'titan', iapetus: 'iapetus', miranda: 'miranda', ariel: 'ariel', umbriel: 'umbriel', titania: 'titania', oberon: 'oberon', triton: 'triton', phobos: 'phobos', deimos: 'deimos' };   // moons: each is its own destination, flown to at its real orbit
const SPACE_NAME = { moon: 'the Moon', sun: 'the Sun', earth: 'Earth', solar: 'the Solar System', system: 'the Sun, Earth and Moon',
  halley: "Halley's Comet", encke: 'Comet Encke', c67p: 'Comet 67P/Churyumov-Gerasimenko', swifttuttle: 'Comet Swift-Tuttle', halebopp: 'Comet Hale-Bopp' };
// Comets are destinations too (the wallpaper flies to them and shows the coma and tail). Names arrive with possessives,
// hyphens, designations and the occasional misspelling ("Haley's Comet"), so normalise hard before matching.
const COMET_ALIAS = {
  halley: 'halley', haley: 'halley', halleys: 'halley', haleys: 'halley', '1p halley': 'halley', '1p': 'halley',
  encke: 'encke', '2p encke': 'encke', '2p': 'encke',
  '67p': 'c67p', 'churyumov gerasimenko': 'c67p', churyumov: 'c67p', gerasimenko: 'c67p', '67p churyumov gerasimenko': 'c67p',
  'swift tuttle': 'swifttuttle', swift: 'swifttuttle', tuttle: 'swifttuttle', '109p swift tuttle': 'swifttuttle', '109p': 'swifttuttle',
  'hale bopp': 'halebopp', hale: 'halebopp', bopp: 'halebopp', 'c 1995 o1': 'halebopp', '1995 o1': 'halebopp',
};
function cometTarget(text) {
  let s = String(text || '').toLowerCase().replace(/[’'`]/g, '').replace(/[-–—/]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^the /, '').replace(/^comet /, '').replace(/ comets?$/, '').trim();
  s = s.replace(/^\d+p /, '');
  for (const k of [s, s.replace(/s$/, '')]) if (COMET_ALIAS[k]) return COMET_ALIAS[k];
  return null;
}
const CONT_ALIAS = { australia: null, 'the americas': null };   // not a continent target: geocoded like any country

const AREA_KM2K = { AF: 652, AL: 29, DZ: 2382, AD: 0.5, AO: 1247, AR: 2780, AM: 30, AU: 7692, AT: 84, AZ: 87, BS: 14, BH: 0.8, BD: 148, BY: 208, BE: 31, BZ: 23, BJ: 115, BT: 38, BO: 1099, BA: 51, BW: 582, BR: 8516, BN: 6, BG: 111, BF: 274, BI: 28, KH: 181, CM: 475, CA: 9985, CV: 4, CF: 623, TD: 1284, CL: 756, CN: 9597, CO: 1142, KM: 2, CG: 342, CD: 2345, CR: 51, CI: 322, HR: 57, CU: 110, CY: 9, CZ: 79, DK: 43, DJ: 23, DO: 49, EC: 284, EG: 1002, SV: 21, GQ: 28, ER: 118, EE: 45, SZ: 17, ET: 1104, FJ: 18, FI: 338, FR: 551, GA: 268, GM: 11, GE: 70, DE: 357, GH: 239, GR: 132, GT: 109, GN: 246, GW: 36, GY: 215, HT: 28, HN: 112, HU: 93, IS: 103, IN: 3287, ID: 1905, IR: 1648, IQ: 438, IE: 70, IL: 22, IT: 301, JM: 11, JP: 378, JO: 89, KZ: 2725, KE: 580, KP: 121, KR: 100, KW: 18, KG: 200, LA: 237, LV: 65, LB: 10, LS: 30, LR: 111, LY: 1760, LT: 65, LU: 3, MG: 587, MW: 118, MY: 331, MV: 0.3, ML: 1240, MT: 0.3, MR: 1031, MU: 2, MX: 1964, MD: 34, MN: 1564, ME: 14, MA: 447, MZ: 802, MM: 677, NA: 824, NP: 148, NL: 42, NZ: 268, NI: 130, NE: 1267, NG: 924, MK: 26, NO: 385, OM: 310, PK: 882, PA: 76, PG: 463, PY: 407, PE: 1285, PH: 300, PL: 313, PT: 92, QA: 12, RO: 238, RU: 17098, RW: 26, SA: 2150, SN: 197, RS: 88, SL: 72, SG: 0.7, SK: 49, SI: 20, SB: 29, SO: 638, ZA: 1221, SS: 619, ES: 506, LK: 66, SD: 1886, SR: 164, SE: 450, CH: 41, SY: 185, TW: 36, TJ: 143, TZ: 947, TH: 513, TL: 15, TG: 57, TT: 5, TN: 164, TR: 784, TM: 488, UG: 241, UA: 604, AE: 84, GB: 244, US: 9834, UY: 176, UZ: 447, VE: 916, VN: 331, YE: 528, ZM: 753, ZW: 391, PS: 6, XK: 11, GL: 2166, PR: 9 };   // country area, thousand km² (rounded): sizes the view of a country
const countrySpan = r => { const a = AREA_KM2K[r.country_code]; return a ? Math.max(2.5, Math.min(60, 1.7 * Math.sqrt(a * 1000) / 111)) : null; };

// Open-Meteo feature codes (GeoNames): the size of the view that suits the kind of place, as degrees of arc.
function spanFor(r) {
  const c = String(r.feature_code || '');
  if (/^PCL/.test(c)) return countrySpan(r) ?? ((r.population || 0) > 100e6 ? 38 : (r.population || 0) > 20e6 ? 24 : 14);   // a country, sized by its area
  if (c === 'ADM1') return 9;                                                                          // state, province, region
  if (c === 'ADM2') return 4;                                                                          // county, district
  if (/^ADM/.test(c)) return 2;
  if (/^PPL/.test(c)) return (r.population || 0) > 1e6 ? 1.6 : 0.9;                                    // city, town
  if (/^(SEA|OCN|GULF|BAY|STRT)/.test(c)) return 40;
  if (/^(MT|MTS|ISL|ISLS|DSRT|LK|RGN|AREA)/.test(c)) return 6;
  return 3;
}
const SCALE = { continent: 55, country: 16, region: 7, county: 3.5, city: 1.2, street: 0.25 };

const label = r => [r.name, r.admin1 && r.admin1 !== r.name ? r.admin1 : '', r.country && r.country !== r.name ? r.country : ''].filter(Boolean).join(', ');

// → { target } (a continent), { lat, lon, span, name } or { candidates: [names] } (several close matches: ask which)
async function findOnGlobe(fetcher, text, { scale } = {}) {
  const q = String(text || '').trim().replace(/[.?!]+$/, '');
  if (!q) return { candidates: [] };
  const low = q.toLowerCase();
  if (SPACE[low]) { const t = SPACE[low]; return { target: t, space: true, name: SPACE_NAME[t] || t[0].toUpperCase() + t.slice(1) }; }
  const ct = cometTarget(q);
  if (ct) return { target: ct, space: true, name: SPACE_NAME[ct] };
  if (CONTINENTS.has(low) && !(low in CONT_ALIAS)) return { target: low, name: q };
  const list = await searchPlaces(fetcher, q);
  if (!list.length) return { candidates: [] };
  const [a, b] = list;
  if (b && !q.includes(',') && (a.population || 0) < 5 * (b.population || 0) && !/^PCL/.test(a.feature_code || '')) {
    return { candidates: [...new Set(list.slice(0, 5).map(label))] };
  }
  return { lat: a.latitude, lon: a.longitude, span: SCALE[scale] || spanFor(a), name: label(a), kind: a.feature_code || '' };
}

// A moment in time for the solar view, from what the user said: a year ("2100", "year 1066", "500 BC"), a date ("1969-07-20", "July 20, 1969"),
// or a span from now ("in 50 years", "3 centuries ago"). Returns epoch milliseconds, or null when it is not a date (nothing leaves this machine: it is arithmetic).
// Nothing is sent to the wallpaper but this one number. The planet maths is a fit to 1800-2050; outside it the positions are approximate (see timeNote).
const UNIT_YEARS = { day: 1 / 365.25, week: 7 / 365.25, month: 1 / 12, year: 1, decade: 10, century: 100, centurie: 100, millennium: 1000, millennia: 1000 };
const MAX_YEAR = 90000;
function yearToMs(y, month = 0, day = 1) { const d = new Date(0); d.setUTCFullYear(y, month, day); d.setUTCHours(0, 0, 0, 0); return d.getTime(); }
function parseSimTime(text, now = Date.now()) {
  const q = String(text ?? '').trim().toLowerCase().replace(/[.,!?]+$/g, '').replace(/^(?:the )?(?:year|in|around|about|circa|c\.)\s+/g, '').replace(/^(?:the )?year\s+/, '');
  if (!q || /^(?:now|today|the present|present|current|right now)$/.test(q)) return null;
  let m = q.match(/^(\d+(?:\.\d+)?|a|an|one)\s+(day|week|month|year|decade|century|centuries|millennium|millennia)s?\s*(from now|ahead|later|ago|in the future|in the past|back|earlier)?$/);
  if (m && (m[3] || /^in /.test(String(text).trim().toLowerCase()))) {
    const n = /^(a|an|one)$/.test(m[1]) ? 1 : +m[1], u = UNIT_YEARS[m[2].replace(/ies$/, 'ie').replace(/s$/, '')] ?? UNIT_YEARS[m[2]];
    const back = /ago|past|back|earlier/.test(m[3] || '');
    if (!u || !Number.isFinite(n)) return null;
    const ms = now + (back ? -1 : 1) * n * u * 365.25 * 864e5;
    return Math.abs(ms) < 3e15 ? ms : null;
  }
  m = q.match(/^(-?\d{1,6})\s*(bc|bce|b\.c\.|ad|ce|a\.d\.)?$/);
  if (m) {
    let y = +m[1]; if (/^b/.test(m[2] || '')) y = 1 - y;               // 1 BC is year 0, 500 BC is -499
    return Math.abs(y) <= MAX_YEAR ? yearToMs(y) : null;
  }
  m = q.match(/^(-?\d{1,6})-(\d{1,2})-(\d{1,2})$/);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return yearToMs(+m[1], +m[2] - 1, +m[3]);
  const t = Date.parse(q + ' utc'), r = Number.isFinite(t) ? t : Date.parse(q);
  return Number.isFinite(r) && Math.abs(new Date(r).getUTCFullYear()) <= MAX_YEAR ? r : null;
}
// the planet maths (JPL elements) is good for 1800-2050; outside it the planets are still on sensible orbits but their exact places drift
const timeNote = ms => { const y = new Date(ms).getUTCFullYear(); return y >= 1800 && y <= 2050 ? '' : ' That date is outside 1800 to 2050, where the planet positions are only approximate: tell the user so, in one short clause.'; };

module.exports = { SPACE, SPACE_NAME, cometTarget, findOnGlobe, spanFor, SCALE, CONTINENTS, parseSimTime, timeNote };
