const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeNet } = require('./helpers/fakenet');
const { getAlerts } = require('../src/core/knowledge/weather');
const { assessHome, getObservation, formatThreat } = require('../src/core/knowledge/weather-watch');
const { createSkillTracker } = require('../src/core/knowledge/weather-skill');

const HOME = { name: 'Abilene, TX', lat: 32.4487, lon: -99.7331, country: 'US' };

function forecast(gust, extra = {}) {
  const h = { time: Array.from({ length: 6 }, (_, i) => `2026-11-17T${String(10 + i)}:00`) };
  for (const m of ['gfs_seamless', 'ecmwf_ifs025', 'icon_seamless', 'gem_seamless']) {
    h[`wind_gusts_10m_${m}`] = gust; h[`precipitation_${m}`] = Array(6).fill(0); h[`cape_${m}`] = Array(6).fill(0);
    h[`pressure_msl_${m}`] = extra.pressure || Array(6).fill(1015); h[`weather_code_${m}`] = Array(6).fill(0); h[`temperature_2m_${m}`] = Array(6).fill(70);
  }
  return JSON.stringify({ hourly: h });
}
const nws = features => JSON.stringify({ features });

test('getAlerts: keeps warning outlines as [lat, lon] rings (GeoJSON is lon, lat) and tolerates alerts with no geometry', async () => {
  const n = fakeNet([[/api\.weather\.gov\/alerts\/active/, nws([
    { properties: { event: 'Severe Thunderstorm Warning', severity: 'Severe', ends: 'T1' }, geometry: { type: 'Polygon', coordinates: [[[-99.8, 32.5], [-99.7, 32.6], [-99.6, 32.4], [-99.8, 32.5]]] } },
    { properties: { event: 'Wind Advisory', severity: 'Minor' }, geometry: null },
    { properties: { event: 'Flash Flood Warning', severity: 'Severe' }, geometry: { type: 'MultiPolygon', coordinates: [[[[-99.5, 32.3], [-99.4, 32.4], [-99.5, 32.3]]], [[[-99.9, 32.1], [-99.8, 32.2], [-99.9, 32.1]]]] } },
  ])]]);
  const r = await getAlerts(n.fetcher, HOME);
  const sv = r.alerts.find(a => a.event === 'Severe Thunderstorm Warning');
  assert.deepEqual(sv.rings, [[[32.5, -99.8], [32.6, -99.7], [32.4, -99.6], [32.5, -99.8]]]);
  assert.deepEqual(r.alerts.find(a => a.event === 'Wind Advisory').rings, []);
  assert.equal(r.alerts.find(a => a.event === 'Flash Flood Warning').rings.length, 2);
});

test('getObservation: finds the nearest station then its latest temperature in °F; null when there is none', async () => {
  const n = fakeNet([
    [/api\.weather\.gov\/points\/32\.4487,-99\.7331/, JSON.stringify({ properties: { observationStations: 'https://api.weather.gov/gridpoints/SJT/1,2/stations' } })],
    [/gridpoints\/SJT\/1,2\/stations/, JSON.stringify({ features: [{ properties: { stationIdentifier: 'KABI' } }] })],
    [/stations\/KABI\/observations\/latest/, JSON.stringify({ properties: { temperature: { value: 20 } } })],
  ]);
  assert.equal(await getObservation(n.fetcher, HOME), 68);
  const none = fakeNet([[/api\.weather\.gov/, '{}']]);
  assert.equal(await getObservation(none.fetcher, HOME), null);
});

test('assessHome: four models agreeing on 65 mph gusts → severe wind with a level, kind and ETA; no alert polygons', async () => {
  const gust = [12, 12, 65, 12, 12, 12];
  const n = fakeNet([[/api\.open-meteo\.com\/v1\/forecast/, forecast(gust)], [/api\.weather\.gov\/alerts/, nws([])], [/api\.weather\.gov/, '{}']]);
  const r = await assessHome(n.fetcher, HOME, { tracker: createSkillTracker() });
  assert.equal(r.threat.level, 'severe');
  assert.equal(r.threat.kind, 'wind');
  assert.equal(r.threat.etaHours, 2);
  assert.deepEqual(r.polys, []);
  assert.equal(r.models, 4);
});

test('assessHome: a Severe warning with an outline gives the HUD a ring; a failing alerts lookup still yields a forecast-only threat', async () => {
  const ring = [[[-99.8, 32.5], [-99.7, 32.6], [-99.6, 32.4], [-99.8, 32.5]]];
  const withAlert = fakeNet([[/api\.open-meteo\.com\/v1\/forecast/, forecast(Array(6).fill(10))],
    [/api\.weather\.gov\/alerts/, nws([{ properties: { event: 'Tornado Warning', severity: 'Extreme' }, geometry: { type: 'Polygon', coordinates: ring } }])], [/api\.weather\.gov/, '{}']]);
  const a = await assessHome(withAlert.fetcher, HOME, {});
  assert.equal(a.threat.level, 'extreme');
  assert.deepEqual(a.polys, [{ sev: 'extreme', ring: [[32.5, -99.8], [32.6, -99.7], [32.4, -99.6], [32.5, -99.8]] }]);
  const noAlerts = fakeNet([[/api\.open-meteo\.com\/v1\/forecast/, forecast([12, 12, 65, 12, 12, 12])]]);
  const b = await assessHome(noAlerts.fetcher, HOME, {});
  assert.equal(b.threat.level, 'severe');
});

test('assessHome: a forecast that cannot be fetched throws so the caller can say so', async () => {
  const n = fakeNet([]);
  await assert.rejects(assessHome(n.fetcher, HOME, {}));
});

test('assessHome: feeds the skill tracker: predictions now, scored against the station reading next time', async () => {
  const n = fakeNet([[/api\.open-meteo\.com\/v1\/forecast/, forecast(Array(6).fill(10))],
    [/api\.weather\.gov\/points/, JSON.stringify({ properties: { observationStations: 'https://api.weather.gov/gridpoints/X/1,1/stations' } })],
    [/gridpoints\/X\/1,1\/stations/, JSON.stringify({ features: [{ properties: { stationIdentifier: 'KABI' } }] })],
    [/observations\/latest/, JSON.stringify({ properties: { temperature: { value: 21.1 } } })],   // 70 F
    [/api\.weather\.gov\/alerts/, nws([])]]);
  let saved = null;
  const tracker = createSkillTracker({ load: () => saved, save: s => { saved = JSON.parse(JSON.stringify(s)); } });
  await assessHome(n.fetcher, HOME, { tracker });
  assert.ok(Object.keys(saved.pred).length >= 1, 'future hours were recorded');
  const first = Object.keys(saved.pred).sort()[0];
  tracker.observe(first, 70);
  assert.ok(Object.keys(saved.err).length > 0);
});

test('formatThreat: one calm line when nothing is coming; level, kind, ETA and reasons otherwise; no alert free text', () => {
  assert.match(formatThreat({ threat: { level: 'none', kind: null, etaHours: null, reasons: [] }, models: 4 }), /no weather threat/i);
  const s = formatThreat({ threat: { level: 'severe', kind: 'wind', etaHours: 2, reasons: ['4 of 4 models forecast gusts of 58 mph or more'] }, models: 4 });
  assert.match(s, /severe/i); assert.match(s, /wind/i); assert.match(s, /2 hours/); assert.match(s, /4 of 4 models/);
});

const { createHomeWatch } = require('../src/core/knowledge/weather-watch');
test('createHomeWatch: caches for 5 min, emits one bus weather event per refresh with only structure, home unset → null', async () => {
  const n = fakeNet([[/api\.open-meteo\.com\/v1\/forecast/, forecast([12, 12, 65, 12, 12, 12])], [/api\.weather\.gov/, '{}']]);
  const events = []; let t = 1e9;
  const w = createHomeWatch({ fetcher: n.fetcher, getConfig: () => ({ location: { lat: 32.4487, lon: -99.7331, country: 'US', city: 'Abilene, TX' } }), bus: { emit: (type, p) => events.push({ type, ...p }) }, now: () => t });
  const a = await w.refresh();
  assert.equal(a.threat.level, 'severe');
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), ['etaHours', 'kind', 'level', 'polys', 'type']);
  t += 60000;
  await w.refresh();
  assert.equal(events.length, 1, 'cached');
  t += 6 * 60000;
  await w.refresh();
  assert.equal(events.length, 2);
  assert.equal(w.last().threat.level, 'severe');
  const none = createHomeWatch({ fetcher: n.fetcher, getConfig: () => ({ location: {} }), bus: { emit() {} } });
  assert.equal(await none.refresh(), null);
});

// ---- radar cells feed the threat ----
const zlibR = require('node:zlib');
function pngBlob(bx) {   // 64x64 RGBA, a red 6x6 blob at column bx, row 29
  const w = 64, h = 64, rows = [];
  for (let y = 0; y < h; y++) { const r = Buffer.alloc(1 + w * 4); for (let x = bx; x < bx + 6; x++) if (y >= 29 && y < 35) r.set([200, 20, 20, 255], 1 + x * 4); rows.push(r); }
  const crc = buf => { let c, k, crc = ~0; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; };
  const chunk = (t, d) => { const a = Buffer.from(t), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(d.length); c.writeUInt32BE(crc(Buffer.concat([a, d]))); return Buffer.concat([l, a, d, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlibR.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

test('assessHome: a strong radar cell closing on home raises a storm threat even when the models are calm; no radar service means forecast-only', async () => {
  let n = 0;
  const net = fakeNet([[/mapservices\.weather\.noaa\.gov/, () => new Response(pngBlob(n++ === 0 ? 50 : 40), { status: 200 })],
    [/api\.open-meteo\.com\/v1\/forecast/, forecast(Array(6).fill(10))], [/api\.weather\.gov/, '{"features":[]}']]);
  const r = await assessHome(net.fetcher, HOME, { radarSize: 64, radarHalfKm: 64 });
  assert.equal(r.threat.kind, 'storm');
  assert.ok(['watch', 'warning'].includes(r.threat.level), r.threat.level);
  assert.ok(r.threat.etaHours < 1);
  assert.match(r.threat.reasons.join(' '), /radar/);
  const none = fakeNet([[/api\.open-meteo\.com\/v1\/forecast/, forecast(Array(6).fill(10))], [/api\.weather\.gov/, '{"features":[]}']]);
  assert.equal((await assessHome(none.fetcher, HOME, {})).threat.level, 'none');
});

test('getObservation: also returns the station pressure in hPa when it reports one', async () => {
  const n = fakeNet([
    [/api\.weather\.gov\/points/, JSON.stringify({ properties: { observationStations: 'https://api.weather.gov/gridpoints/SJT/1,2/stations' } })],
    [/gridpoints\/SJT\/1,2\/stations/, JSON.stringify({ features: [{ properties: { stationIdentifier: 'KABI' } }] })],
    [/observations\/latest/, JSON.stringify({ properties: { temperature: { value: 20 }, seaLevelPressure: { value: 101500 }, barometricPressure: { value: 95000 } } })],
  ]);
  const { getObservationFull } = require('../src/core/knowledge/weather-watch');
  const o = await getObservationFull(n.fetcher, HOME);
  assert.equal(o.tempF, 68); assert.equal(o.pressureHpa, 1015);   // sea-level pressure, to match the models' pressure_msl
  assert.equal(await getObservation(n.fetcher, HOME), 68, 'the temperature-only helper still works');
});
