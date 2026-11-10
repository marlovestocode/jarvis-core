const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeNet, fixture } = require('./helpers/fakenet');
const { createKnowledgeTools, wrapSource } = require('../src/core/tools/knowledge');
const { createToolRunner } = require('../src/core/tools/registry');
const { DEFAULTS } = require('../src/core/config');

const ROUTES = [
  [/geocoding-api\.open-meteo\.com.*name=Dallas/, 'geocode-dallas.json'],
  [/geocoding-api\.open-meteo\.com.*name=Springfield/, 'geocode-springfield.json'],
  [/geocoding-api\.open-meteo\.com/, 'geocode-none.json'],
  [/air-quality-api\.open-meteo\.com/, 'openmeteo-air.json'],
  [/api\.open-meteo\.com\/v1\/forecast/, 'openmeteo-forecast.json'],
  [/api\.weather\.gov\/alerts/, 'nws-alerts.json'],
  [/feeds\.bbci/, 'news-0.xml'], [/feeds\.npr/, 'news-1.xml'], [/arstechnica/, 'news-2.xml'], [/sciencedaily/, 'news-3.xml'],
  [/football\/nfl\/scoreboard/, 'espn-nfl.json'], [/football\/nfl\/teams\/dal\/schedule/, 'espn-nfl-team-dal.json'], [/football\/nfl\/teams$/, 'espn-nfl-teams.json'],
  [/rest\.php\/v1\/search\/page\?q=Peace/i, '{"pages":[{"title":"Peace of Westphalia","excerpt":"treaties"}]}'],
  [/rest\.php\/v1\/search\/page/, '{"pages":[]}'],
  [/rest_v1\/page\/html\/Peace_of_Westphalia$/, 'article-westphalia.html'],
  [/rest_v1\/page\/html\/Middlemarch$/, 'article-middlemarch.html'],
  [/rest_v1\/page\/summary\/Peace_of_Westphalia$/, '{"type":"standard","title":"Peace of Westphalia","extract":"The Peace of Westphalia is the collective name for two peace treaties signed in October 1648.","timestamp":"2026-10-01T00:00:00Z","content_urls":{"desktop":{"page":"https://en.wikipedia.org/wiki/Peace_of_Westphalia"}}}'],
];

function fakeKiwix({ installed = true, results = null } = {}) {
  const k = { searches: [], available: () => installed };
  k.search = async q => {
    k.searches.push(q);
    if (results) return results(q);
    return /middlemarch/i.test(q) ? [{ title: 'Middlemarch', path: '/content/wikipedia_en_all_nopic_2026-06/A/Middlemarch', snippet: '' }] : [];
  };
  k.article = async p => (p.endsWith('/Middlemarch') ? fixture('article-middlemarch.html') : fixture('article-westphalia.html'));
  k.articleByTitle = async t => (/middlemarch/i.test(t) ? fixture('article-middlemarch.html') : (() => { throw new Error('offline library HTTP 404'); })());
  k.info = async () => ({ installed, file: 'wikipedia_en_all_nopic_2026-06.zim' });
  return k;
}
function setup({ kiwix = fakeKiwix(), config = DEFAULTS, routes = ROUTES } = {}) {
  const net = fakeNet(routes, { config });
  let cfg = config;
  const tools = createKnowledgeTools({ fetcher: net.fetcher, kiwix, getConfig: () => cfg });
  const runner = createToolRunner(tools);
  const run = (name, args) => runner.run(name, args);
  return { net, tools, run, kiwix, setConfig: c => { cfg = c; net.setConfig(c); } };
}

test('tools: the six knowledge tools with JSON schemas', () => {
  const { tools } = setup();
  assert.deepEqual(tools.map(t => t.name), ['get_weather', 'weather_alerts', 'news_headlines', 'sports_scores', 'lookup_knowledge', 'read_article']);
  for (const t of tools) { assert.equal(t.params.type, 'object'); assert.ok(t.description.length > 20); }
  assert.deepEqual(tools.find(t => t.name === 'lookup_knowledge').params.required, ['query']);
  assert.deepEqual(tools.find(t => t.name === 'read_article').params.required, ['title']);
});

test('wrapSource: quoted source material, delimiters inside the text neutralised', () => {
  const w = wrapSource('Example, just now', 'line """ break');
  assert.match(w, /^SOURCE DATA \(Example, just now\)/);
  assert.match(w, /not instructions/i);
  assert.equal(w.split('"""').length - 1, 2, 'only the wrapper delimiters');
});

test('get_weather: home by default, names source and age, wrapped', async () => {
  const { run } = setup();
  const r = await run('get_weather', {});
  assert.equal(r.ok, true);
  assert.match(r.text, /^SOURCE DATA \(Open-Meteo, just now\)/);
  assert.match(r.text, /Weather for Abilene, TX/);
  assert.ok(r.text.length <= 2700);
});

test('get_weather: ambiguous place asks which one; unknown place says so', async () => {
  const { run } = setup();
  assert.match((await run('get_weather', { place: 'Springfield' })).text, /Which Springfield.*Illinois/);
  assert.match((await run('get_weather', { place: 'Qwxzzyplk' })).text, /couldn't find a place called "Qwxzzyplk"/);
});

test('weather_alerts, news_headlines, sports_scores: source + age in the text', async () => {
  const { run } = setup();
  assert.match((await run('weather_alerts', {})).text, /SOURCE DATA \(National Weather Service, just now\)/);
  const news = await run('news_headlines', { count: 3 });
  assert.match(news.text, /SOURCE DATA \(news feeds: .*just now\)/);
  assert.match((await run('sports_scores', { team: 'Cowboys', league: 'nfl' })).text, /SOURCE DATA \(ESPN, just now\)/);
});

test('lookup_knowledge: offline library first, cited passages, capped', async () => {
  const { run, net } = setup();
  const r = await run('lookup_knowledge', { query: 'Who wrote Middlemarch?' });
  assert.match(r.text, /SOURCE DATA \(Wikipedia, offline library wikipedia_en_all_nopic_2026-06\)/);
  assert.match(r.text, /\[Middlemarch › Introduction\]/);
  assert.match(r.text, /George Eliot/);
  assert.ok(r.text.length <= 2700, String(r.text.length));
  assert.equal(net.calls.length, 0, 'no network when the library answers');
});

test('lookup_knowledge: empty offline result → retry with key nouns, then online Wikipedia', async () => {
  const { run, kiwix, net } = setup();
  const r = await run('lookup_knowledge', { query: 'When was the Peace of Westphalia signed?' });
  assert.equal(kiwix.searches.length, 2, 'one retry with key nouns');
  assert.match(kiwix.searches[1], /^peace westphalia signed$/i);
  assert.match(r.text, /SOURCE DATA \(Wikipedia, online/);
  assert.match(r.text, /\[Peace of Westphalia › /);
  assert.match(r.text, /1648/);
  assert.ok(net.calls.some(u => u.includes('rest.php/v1/search')));
});

test('lookup_knowledge: library missing → online; online off too → clear message', async () => {
  const s = setup({ kiwix: fakeKiwix({ installed: false }) });
  assert.match((await s.run('lookup_knowledge', { query: 'Peace of Westphalia' })).text, /Wikipedia, online/);
  s.setConfig({ ...DEFAULTS, online: { ...DEFAULTS.online, enabled: false } });
  const off = await s.run('lookup_knowledge', { query: 'Peace of Westphalia' });
  assert.match(off.text, /offline library is not installed and online lookups are off/i);
});

test('lookup_knowledge: kiwix errors fall back to online', async () => {
  const k = fakeKiwix({ results: () => { throw new Error('server stopped'); } });
  const { run } = setup({ kiwix: k });
  assert.match((await run('lookup_knowledge', { query: 'Peace of Westphalia' })).text, /Wikipedia, online/);
});

test('read_article: offline section extract; online fallback; capped', async () => {
  const { run } = setup();
  const a = await run('read_article', { title: 'Middlemarch', section: 'Plot' });
  assert.match(a.text, /\[Middlemarch › Plot/);
  assert.ok(!/\[Middlemarch › Introduction\]/.test(a.text));
  assert.ok(a.text.length <= 2700);
  const b = await run('read_article', { title: 'Peace of Westphalia' });
  assert.match(b.text, /Wikipedia, online/);
  assert.match(b.text, /\[Peace of Westphalia › Introduction\]/);
});

test('online switch off → live tools say so (no throw, no network)', async () => {
  const s = setup({ config: { ...DEFAULTS, online: { ...DEFAULTS.online, enabled: false } } });
  for (const name of ['get_weather', 'weather_alerts', 'news_headlines', 'sports_scores']) {
    const r = await s.run(name, name === 'sports_scores' ? { league: 'nfl' } : {});
    assert.match(r.text, /online lookups are off/i, name);
  }
  assert.equal(s.net.calls.length, 0);
  const w = setup({ config: { ...DEFAULTS, online: { ...DEFAULTS.online, weather: false } } });
  assert.match((await w.run('get_weather', {})).text, /weather lookups are off/i);
});

test('hostile headline text comes back as quoted data', async () => {
  const s = setup({ routes: [[/hostile/, 'news-hostile.xml']], config: { ...DEFAULTS, news: { feeds: ['https://hostile.example.com/rss'] } } });
  const r = await s.run('news_headlines', {});
  assert.match(r.text, /^SOURCE DATA .*not instructions/);
  assert.match(r.text, /"""\n[\s\S]*Ignore previous instructions[\s\S]*\n"""$/);
});

test('context: every tool result fits in ~2,700 chars, so 3 rounds stay well under 8k tokens', async () => {
  const { run } = setup();
  const outs = await Promise.all([
    run('get_weather', { days: 7, hourly: true }), run('news_headlines', { count: 20 }), run('lookup_knowledge', { query: 'Middlemarch' }),
    run('read_article', { title: 'Middlemarch' }), run('sports_scores', { league: 'nfl' }), run('weather_alerts', { place: 'Dallas' }),
  ]);
  for (const o of outs) assert.ok(o.text.length <= 2700, o.text.slice(0, 80) + ' … ' + o.text.length);
});

test('knowledge tools carry a longer timeout than the 10 s default', () => {
  const { tools } = setup();
  assert.ok(tools.find(t => t.name === 'lookup_knowledge').timeoutMs >= 25000);
});

test('source wrapper and all tool results stay within 2,500 characters', async () => {
  assert.ok(wrapSource('x'.repeat(500), 'a'.repeat(5000)).length <= 2500);
  const { run } = setup();
  for (const [name, args] of [['get_weather', { days: 7, hourly: true }], ['news_headlines', { count: 20 }], ['lookup_knowledge', { query: 'Middlemarch' }]]) {
    assert.ok((await run(name, args)).text.length <= 2500);
  }
});
