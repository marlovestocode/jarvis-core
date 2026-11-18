const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeNet } = require('./helpers/fakenet');
const { createKnowledgeTools } = require('../src/core/tools/knowledge');
const { createToolRunner } = require('../src/core/tools/registry');
const { createHomeWatch } = require('../src/core/knowledge/weather-watch');
const { DEFAULTS } = require('../src/core/config');

const fc = gust => JSON.stringify({ hourly: { time: Array.from({ length: 6 }, (_, i) => `2026-11-17T${10 + i}:00`), ...Object.fromEntries(['gfs_seamless', 'ecmwf_ifs025', 'icon_seamless', 'gem_seamless'].flatMap(m => [
  [`wind_gusts_10m_${m}`, gust], [`precipitation_${m}`, Array(6).fill(0)], [`cape_${m}`, Array(6).fill(0)], [`pressure_msl_${m}`, Array(6).fill(1015)], [`weather_code_${m}`, Array(6).fill(0)]])) } });
const ROUTES = gust => [[/geocoding-api\.open-meteo\.com.*name=Dallas/, 'geocode-dallas.json'], [/api\.open-meteo\.com\/v1\/forecast/, fc(gust)], [/api\.weather\.gov\/alerts/, '{"features":[]}'], [/api\.weather\.gov/, '{}']];

function setup(gust, withWatch) {
  const net = fakeNet(ROUTES(gust));
  const homeWatch = withWatch ? createHomeWatch({ fetcher: net.fetcher, getConfig: () => DEFAULTS, bus: { emit() {} } }) : null;
  const tools = createKnowledgeTools({ fetcher: net.fetcher, kiwix: { available: () => false }, getConfig: () => DEFAULTS, homeWatch });
  return { net, tools, run: (n, a) => createToolRunner(tools).run(n, a) };
}

test('weather_threat: "is a storm coming" for home answers with level, kind, ETA, as quoted source data', async () => {
  const { run, tools } = setup([12, 12, 65, 12, 12, 12], true);
  assert.ok(tools.some(t => t.name === 'weather_threat'));
  const r = await run('weather_threat', {});
  assert.equal(r.ok, true);
  assert.match(r.text, /SOURCE DATA/);
  assert.match(r.text, /SEVERE/); assert.match(r.text, /damaging wind/);
});

test('weather_threat: calm weather says so; another place uses the same models without the home tracker', async () => {
  const calm = setup(Array(6).fill(10), false);
  assert.match((await calm.run('weather_threat', {})).text, /No weather threat/);
  const dallas = await calm.run('weather_threat', { place: 'Dallas' });
  assert.match(dallas.text, /Dallas/);
});
