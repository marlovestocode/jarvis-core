const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeNet } = require('./helpers/fakenet');
const { createKnowledgeTools } = require('../src/core/tools/knowledge');
const { createToolRunner } = require('../src/core/tools/registry');
const { findOnGlobe, spanFor } = require('../src/core/knowledge/globe');
const { createBus } = require('../src/core/bus');
const { DEFAULTS } = require('../src/core/config');

const geo = results => JSON.stringify({ results });
const ROUTES = [
  [/geocoding-api\.open-meteo\.com.*name=Kenya/, geo([{ name: 'Kenya', latitude: 1, longitude: 38, country: 'Kenya', country_code: 'KE', feature_code: 'PCLI', population: 54e6 }])],
  [/geocoding-api\.open-meteo\.com.*name=Kyoto/, geo([{ name: 'Kyoto', latitude: 35.01, longitude: 135.75, admin1: 'Kyoto', country: 'Japan', country_code: 'JP', feature_code: 'PPLA', population: 1.4e6 }])],
  [/geocoding-api\.open-meteo\.com.*name=Springfield/, geo([{ name: 'Springfield', latitude: 39.8, longitude: -89.6, admin1: 'Illinois', country: 'United States', feature_code: 'PPLA', population: 114e3 }, { name: 'Springfield', latitude: 37.2, longitude: -93.3, admin1: 'Missouri', country: 'United States', feature_code: 'PPL', population: 169e3 }])],
  [/geocoding-api\.open-meteo\.com/, JSON.stringify({})],
  [/rest\.php\/v1\/search\/page/, '{"pages":[]}'],
];
function setup() {
  const net = fakeNet(ROUTES, { config: DEFAULTS });
  const bus = createBus(), seen = [];
  bus.on('globe', ({ t, type, ...e }) => seen.push(e));
  const kiwix = { available: () => false, info: async () => ({}) };
  const tools = createKnowledgeTools({ fetcher: net.fetcher, kiwix, getConfig: () => DEFAULTS, bus });
  return { seen, run: (n, a) => createToolRunner(tools).run(n, a), net };
}

test('findOnGlobe: continents are local, a country is wide, a city is tight, close names ask', async () => {
  const { net } = setup();
  assert.deepEqual(await findOnGlobe(net.fetcher, 'Asia'), { target: 'asia', name: 'Asia' });
  const k = await findOnGlobe(net.fetcher, 'Kenya');
  assert.equal(k.lat, 1); assert.ok(k.span >= 10);
  const y = await findOnGlobe(net.fetcher, 'Kyoto');
  assert.ok(y.span < 3);
  assert.equal((await findOnGlobe(net.fetcher, 'Kyoto', { scale: 'region' })).span, 7);
  assert.equal((await findOnGlobe(net.fetcher, 'Springfield')).candidates.length, 2);
  assert.deepEqual((await findOnGlobe(net.fetcher, 'Nowhereville')).candidates, []);
  assert.ok(spanFor({ feature_code: 'ADM2' }) < spanFor({ feature_code: 'ADM1' }));
});

test('globe_focus: sends numbers to the globe and says what it moved to', async () => {
  const { run, seen } = setup();
  const r = await run('globe_focus', { place: 'Kyoto', describe: false });
  assert.equal(r.ok, true);
  assert.match(r.text, /flying to Kyoto, Japan/);
  assert.deepEqual(seen, [{ op: 'focus', lat: 35.01, lon: 135.75, span: seen[0].span }]);
  assert.equal((await run('globe_focus', { place: 'Africa', describe: false })).ok, true);
  assert.deepEqual(seen[1], { op: 'focus', target: 'africa' });
});

test('globe_focus: zoom and home need no place; an unclear place asks and does not move', async () => {
  const { run, seen } = setup();
  await run('globe_focus', { action: 'zoom_in' });
  await run('globe_focus', { action: 'home' });
  assert.deepEqual(seen, [{ op: 'zoom', dir: 1 }, { op: 'home', dir: 0 }]);
  const r = await run('globe_focus', { place: 'Springfield' });
  assert.match(r.text, /Which Springfield/);
  assert.match((await run('globe_focus', {})).text, /Name the place/);
  assert.equal(seen.length, 2);
});

test('findOnGlobe: comets are space destinations, possessives and misspellings included', async () => {
  const { net } = setup();
  const cases = [["Halley's Comet", 'halley'], ["Haley's Comet", 'halley'], ['halleys comet', 'halley'], ['comet halley', 'halley'], ['1P/Halley', 'halley'],
    ['Encke', 'encke'], ['Comet Encke', 'encke'], ['67P', 'c67p'], ['Churyumov-Gerasimenko', 'c67p'], ['Swift-Tuttle', 'swifttuttle'], ['comet swift tuttle', 'swifttuttle'],
    ['Hale-Bopp', 'halebopp'], ['C/1995 O1', 'halebopp']];
  for (const [said, id] of cases) { const r = await findOnGlobe(net.fetcher, said); assert.equal(r.target, id, said); assert.equal(r.space, true, said); }
  assert.equal((await findOnGlobe(net.fetcher, 'comets')).target, 'solar');
});

test('globe_focus: flying to a comet sends a space target, not a geocode', async () => {
  const { run, seen } = setup();
  const r = await run('globe_focus', { place: "Haley's Comet" });
  assert.equal(r.ok, true);
  assert.match(r.text, /flying to Halley's Comet/);
  assert.deepEqual(seen, [{ op: 'focus', target: 'halley' }]);
});

test('router: short globe requests need tools, so voice never gets the no-tools "did not catch that" reply', () => {
  const { route } = require('../src/core/brain/router');
  for (const t of ['take me to Israel', 'zoom into Kenya', 'show me Kyoto on the globe', 'fly to Japan', 'zoom out', "fly to Halley's Comet", 'show me Hale-Bopp', 'go to comet Encke']) {
    for (const source of ['voice', 'text']) { const r = route(t, { source }); assert.equal(r.tools, true, `${source}: ${t}`); }
  }
  assert.equal(route('tell me a joke', { source: 'voice' }).tools, false);
});

test('globe_focus: a repeat is never "already done", and it says so when the wallpaper is not connected', async () => {
  const { toolContract } = require('../src/core/skills/toolcards');
  const { createLedger } = require('../src/core/tools/ledger');
  const net = fakeNet(ROUTES, { config: DEFAULTS });
  const bus = createBus();
  let clients = 1;
  const tools = createKnowledgeTools({ fetcher: net.fetcher, kiwix: { available: () => false, info: async () => ({}) }, getConfig: () => DEFAULTS, bus, wallpaperClients: () => clients });
  const tool = tools.find(t => t.name === 'globe_focus');
  const c = toolContract(tool);
  assert.equal(c.effect, 'read'); assert.equal(c.volatile, true);
  // the ledger answers a repeat from an earlier turn only for writes; a volatile read runs again on the next turn
  const ledger = createLedger();
  ledger.record('s', 'globe_focus', { place: 'Israel' }, { effect: c.effect, text: 'x', turnId: 1 });
  assert.equal(ledger.check('s', 'globe_focus', { place: 'Israel' }, { effect: c.effect, volatile: c.volatile, turnId: 2 }), null);
  assert.match(await tool.run({ place: 'Kyoto', describe: false }), /is flying to Kyoto/);
  clients = 0;
  assert.match(await tool.run({ place: 'Kyoto', describe: false }), /did NOT move/);
  assert.match(await tool.run({ action: 'zoom_in' }), /did NOT move/);
});

test('space: the Moon, the Sun, every planet and the whole solar system are destinations, checked before places', async () => {
  const { findOnGlobe } = require('../src/core/knowledge/globe');
  const { run, seen, net } = setup();
  assert.deepEqual(await findOnGlobe(net.fetcher, 'the Moon'), { target: 'moon', space: true, name: 'the Moon' });
  for (const [say, id] of [['Mercury', 'mercury'], ['Venus', 'venus'], ['Mars', 'mars'], ['Jupiter', 'jupiter'], ['Saturn', 'saturn'], ['Uranus', 'uranus'], ['Neptune', 'neptune'], ['the Sun', 'sun'], ['the solar system', 'solar'], ['Earth', 'earth']]) {
    assert.equal((await findOnGlobe(net.fetcher, say)).target, id, say);
  }
  const r = await run('globe_focus', { place: 'Saturn', describe: false });
  assert.match(r.text, /flying to Saturn\./);
  assert.deepEqual(seen.at(-1), { op: 'focus', target: 'saturn' });
});

test('router: space requests need tools too', () => {
  const { route } = require('../src/core/brain/router');
  for (const t of ['take me to the moon', 'show me Mars', 'go to the sun', 'zoom into Jupiter', 'show me the solar system']) assert.equal(route(t, { source: 'voice' }).tools, true, t);
});

test('moons: every major moon is its own destination, and "the Galilean moons" goes to Jupiter', async () => {
  const { findOnGlobe } = require('../src/core/knowledge/globe');
  const { net, run, seen } = setup();
  for (const id of ['io', 'europa', 'ganymede', 'callisto', 'mimas', 'enceladus', 'tethys', 'dione', 'rhea', 'titan', 'iapetus', 'miranda', 'ariel', 'umbriel', 'titania', 'oberon', 'triton', 'phobos', 'deimos']) {
    assert.equal((await findOnGlobe(net.fetcher, id)).target, id, id);
  }
  assert.equal((await findOnGlobe(net.fetcher, 'the Galilean moons')).target, 'jupiter');
  assert.match((await run('globe_focus', { place: 'Titan', describe: false })).text, /flying to Titan\./);
  assert.deepEqual(seen.at(-1), { op: 'focus', target: 'titan' });
  const { route } = require('../src/core/brain/router');
  for (const t of ['show me Titan', 'take me to Io', 'fly to Triton', 'zoom into Ganymede']) assert.equal(route(t, { source: 'voice' }).tools, true, t);
});

test('globe_focus is trusted (its confirmation can back "I took you there") and carries no outside text', async () => {
  const { run } = setup();
  const net = fakeNet(ROUTES, { config: DEFAULTS });
  const tools = createKnowledgeTools({ fetcher: net.fetcher, kiwix: { available: () => false, info: async () => ({}) }, getConfig: () => DEFAULTS, bus: createBus(), wallpaperClients: () => 1 });
  assert.notEqual(tools.find(t => t.name === 'globe_focus').untrusted, true);
  assert.equal(tools.find(t => t.name === 'lookup_knowledge').untrusted, true);
  const r = await run('globe_focus', { place: 'Saturn' });
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.text, /SOURCE DATA/);
  assert.match(r.text, /flying to Saturn\./);
  assert.match(r.text, /call lookup_knowledge with the query "Saturn"/);
  const group = require('../src/core/skills/knowledge').createGroup({ fetcher: net.fetcher, kiwix: { available: () => false, info: async () => ({}) }, getConfig: () => DEFAULTS, bus: createBus(), wallpaperClients: () => 1 });
  assert.notEqual(group.tools.find(t => t.name === 'globe_focus').untrusted, true, 'the skill group must not force the flag back on');
  assert.equal(group.tools.find(t => t.name === 'get_weather').untrusted, true);
});

test('parseSimTime: years, dates and spans from now become one epoch number; junk is null', () => {
  const { parseSimTime, timeNote } = require('../src/core/knowledge/globe');
  const now = Date.UTC(2026, 10, 14), iso = t => new Date(parseSimTime(t, now)).toISOString();
  assert.equal(iso('2100'), '2100-01-01T00:00:00.000Z');
  assert.equal(iso('the year 1066'), '1066-01-01T00:00:00.000Z');
  assert.equal(iso('1969-07-20'), '1969-07-20T00:00:00.000Z');
  assert.equal(iso('July 20, 1969'), '1969-07-20T00:00:00.000Z');
  assert.equal(new Date(parseSimTime('500 BC', now)).getUTCFullYear(), -499);
  assert.equal(new Date(parseSimTime('in 50 years', now)).getUTCFullYear(), 2076);
  assert.equal(new Date(parseSimTime('300 years ago', now)).getUTCFullYear(), 1726);
  for (const bad of ['garbage', 'today', 'now', '', '50 years', '99999999']) assert.equal(parseSimTime(bad, now), null, bad);
  assert.equal(timeNote(Date.UTC(2026, 0, 1)), '');
  assert.match(timeNote(Date.UTC(2300, 0, 1)), /approximate/);
});

test('globe_focus time: sends a mode and numbers only, and warns when the date is outside the planet maths', async () => {
  const { seen, run } = setup();
  const a = await run('globe_focus', { action: 'time', when: '2100' });
  assert.deepEqual(seen.pop(), { op: 'time', mode: 'jump', ts: Date.UTC(2100, 0, 1) });
  assert.match(a.text, /approximate/);
  await run('globe_focus', { action: 'time', time_mode: 'run', speed: 99999 });
  assert.deepEqual(seen.pop(), { op: 'time', mode: 'run', rate: 3660 });
  await run('globe_focus', { action: 'time', time_mode: 'run', when: '1900', speed: -30 });
  assert.deepEqual(seen.pop(), { op: 'time', mode: 'run', ts: Date.UTC(1900, 0, 1), rate: -30 });
  await run('globe_focus', { action: 'time', time_mode: 'pause' });
  assert.deepEqual(seen.pop(), { op: 'time', mode: 'pause' });
  await run('globe_focus', { action: 'time', time_mode: 'now' });
  assert.deepEqual(seen.pop(), { op: 'time', mode: 'now' });
  const bad = await run('globe_focus', { action: 'time', when: 'sometime soon' });
  assert.equal(seen.length, 0);
  assert.match(bad.text, /couldn't read/);
});
