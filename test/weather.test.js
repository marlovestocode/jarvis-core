const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeNet } = require('./helpers/fakenet');
const { resolvePlace } = require('../src/core/knowledge/location');
const { getWeather, getAlerts, formatWeather, formatAlerts, weatherWords } = require('../src/core/knowledge/weather');
const { describeAge } = require('../src/core/knowledge/age');
const { DEFAULTS } = require('../src/core/config');

const ROUTES = [
  [/geocoding-api\.open-meteo\.com.*name=Dallas/, 'geocode-dallas.json'],
  [/geocoding-api\.open-meteo\.com.*name=Springfield/, 'geocode-springfield.json'],
  [/geocoding-api\.open-meteo\.com/, 'geocode-none.json'],
  [/air-quality-api\.open-meteo\.com/, 'openmeteo-air.json'],
  [/api\.open-meteo\.com\/v1\/forecast/, 'openmeteo-forecast.json'],
  [/api\.weather\.gov\/alerts\/active\?point=32\.4487,-99\.7331/, 'nws-alerts-point.json'],
  [/api\.weather\.gov\/alerts\/active\?point=/, 'nws-alerts.json'],
];

test('location: no place → config location, no network', async () => {
  const n = fakeNet(ROUTES);
  const p = await resolvePlace(n.fetcher, '', DEFAULTS);
  assert.deepEqual([p.name, p.lat, p.lon, p.country], ['Abilene, TX', 32.4487, -99.7331, 'US']);
  assert.equal(n.calls.length, 0);
  const p2 = await resolvePlace(n.fetcher, 'here', DEFAULTS);
  assert.equal(p2.name, 'Abilene, TX');
});

test('location: "Dallas" geocodes to Dallas, Texas (by far the biggest)', async () => {
  const n = fakeNet(ROUTES);
  const p = await resolvePlace(n.fetcher, 'Dallas', DEFAULTS);
  assert.equal(p.name, 'Dallas, Texas');
  assert.equal(p.country, 'US');
  assert.ok(Math.abs(p.lat - 32.78) < 0.01);
  assert.match(n.calls[0], /name=Dallas&/);
});

test('location: ambiguous "Springfield" → candidates; "Springfield, IL" picks Illinois', async () => {
  const n = fakeNet(ROUTES);
  const c = await resolvePlace(n.fetcher, 'Springfield', DEFAULTS);
  assert.ok(Array.isArray(c.candidates));
  assert.ok(c.candidates.length >= 3);
  assert.ok(c.candidates.includes('Springfield, Illinois'));
  const il = await resolvePlace(n.fetcher, 'Springfield, IL', DEFAULTS);
  assert.equal(il.name, 'Springfield, Illinois');
  const oregon = await resolvePlace(n.fetcher, 'Dallas, Oregon', DEFAULTS);
  assert.equal(oregon.name, 'Dallas, Oregon');
});

test('location: unknown place → empty candidates', async () => {
  const n = fakeNet(ROUTES);
  const c = await resolvePlace(n.fetcher, 'Qwxzzyplk', DEFAULTS);
  assert.deepEqual(c.candidates, []);
});

test('weather: code → words', () => {
  assert.equal(weatherWords(0), 'clear');
  assert.equal(weatherWords(3), 'overcast');
  assert.equal(weatherWords(63), 'rain');
  assert.equal(weatherWords(95), 'thunderstorm');
  assert.equal(weatherWords(999), 'unknown conditions');
});

test('weather: current + 7-day shape in °F and mph, AQI included', async () => {
  const n = fakeNet(ROUTES);
  const place = await resolvePlace(n.fetcher, '', DEFAULTS);
  const w = await getWeather(n.fetcher, place, { days: 7, units: 'F' });
  assert.equal(w.source, 'Open-Meteo');
  assert.equal(w.units.temp, '°F');
  assert.equal(w.units.wind, 'mph');
  assert.equal(w.current.temp, 57);
  assert.equal(w.current.conditions, 'overcast');
  assert.equal(w.current.humidity, 95);
  assert.equal(w.current.windDir, 'SSW');   // 199°
  assert.equal(w.days.length, 7);
  for (const d of w.days) for (const k of ['date', 'high', 'low', 'conditions', 'rainChance', 'uv']) assert.ok(k in d, k);
  assert.equal(w.aqi.value, 28);
  assert.equal(w.aqi.category, 'good');
  const q = n.calls.find(u => u.includes('/v1/forecast'));
  assert.match(q, /temperature_unit=fahrenheit/);
  assert.match(q, /wind_speed_unit=mph/);
  assert.match(q, /latitude=32\.4487&longitude=-99\.7331/);
});

test('weather: °C asks for celsius and km/h', async () => {
  const n = fakeNet(ROUTES);
  const w = await getWeather(n.fetcher, { name: 'X', lat: 1, lon: 2, country: 'FR' }, { units: 'C' });
  assert.equal(w.units.temp, '°C');
  assert.match(n.calls.find(u => u.includes('/v1/forecast')), /temperature_unit=celsius&wind_speed_unit=kmh/);
});

test('weather: hourly gives the next 12 hours from now; AQI failure is not fatal', async () => {
  const n = fakeNet(ROUTES.filter(r => !String(r[0]).includes('air-quality')));
  const w = await getWeather(n.fetcher, { name: 'Abilene, TX', lat: 32.4487, lon: -99.7331, country: 'US' }, { hourly: true });
  assert.equal(w.aqi, null);
  assert.equal(w.hourly.length, 12);
  assert.equal(w.hourly[0].time, '2026-11-10T00:00');
});

test('weather: text names the source and age; days capped', async () => {
  const n = fakeNet(ROUTES);
  const w = await getWeather(n.fetcher, { name: 'Abilene, TX', lat: 32.4487, lon: -99.7331, country: 'US' }, { days: 2 });
  const t = formatWeather(w);
  assert.match(t, /Abilene, TX/);
  assert.match(t, /Open-Meteo, just now/);
  assert.match(t, /57°F/);
  assert.equal(w.days.length, 2);
  assert.ok(t.length < 2500);
});

test('weather: stale cache is worded as last known', async () => {
  const n = fakeNet(ROUTES);
  const place = { name: 'Abilene, TX', lat: 32.4487, lon: -99.7331, country: 'US' };
  await getWeather(n.fetcher, place, {});
  n.clock.t += 3 * 3600000;     // network goes down, 3 hours later
  n.setDown(true);
  const w = await getWeather(n.fetcher, place, {});
  assert.equal(w.stale, true);
  assert.match(formatWeather(w), /last known.*3 h/i);
});

test('age wording', () => {
  assert.equal(describeAge(0), 'just now');
  assert.equal(describeAge(3 * 60000), '3 min ago');
  assert.equal(describeAge(2 * 3600000), '2 h ago');
  assert.equal(describeAge(3 * 86400000), '3 days ago');
  assert.match(describeAge(2 * 3600000, true), /last known, 2 h old/);
});

test('alerts: parsed with severity and end time; none → empty', async () => {
  const n = fakeNet(ROUTES);
  const none = await getAlerts(n.fetcher, { name: 'Abilene, TX', lat: 32.4487, lon: -99.7331, country: 'US' });
  assert.deepEqual(none.alerts, []);
  const some = await getAlerts(n.fetcher, { name: 'Midland, TX', lat: 32, lon: -102, country: 'US' });
  assert.equal(some.alerts.length, 8);
  const a = some.alerts.find(x => x.event === 'Dense Fog Advisory');
  assert.deepEqual(Object.keys(a).sort(), ['ends', 'event', 'headline', 'severity'].sort());
  assert.equal(a.severity, 'Moderate');
  assert.match(formatAlerts(none), /no active.*alerts/i);
  assert.match(formatAlerts(some), /National Weather Service/);
  assert.ok(formatAlerts(some).length <= 2500);
});

test('alerts: severe alerts come first', async () => {
  const n = fakeNet(ROUTES);
  const some = await getAlerts(n.fetcher, { name: 'Midland, TX', lat: 32, lon: -102, country: 'US' });
  const rank = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };
  for (let i = 1; i < some.alerts.length; i++) assert.ok(rank[some.alerts[i - 1].severity] <= rank[some.alerts[i].severity]);
});

test('alerts: non-US → US only', async () => {
  const n = fakeNet(ROUTES);
  await assert.rejects(getAlerts(n.fetcher, { name: 'Paris, France', lat: 48.85, lon: 2.35, country: 'FR' }), /only available for the US/);
  assert.equal(n.calls.length, 0);
});
