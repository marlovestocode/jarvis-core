const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeNet } = require('./helpers/fakenet');
const { open } = require('../src/core/cortex');
const { createKnowledgeStore } = require('../src/core/knowledge/store');
const { createKnowledgeTools } = require('../src/core/tools/knowledge');
const { createToolRunner } = require('../src/core/tools/registry');
const { DEFAULTS } = require('../src/core/config');

const DAY = 864e5;
const T0 = Date.parse('2026-11-11T12:00:00Z');
const ROUTES = [
  [/rest\.php\/v1\/search\/page\?q=Peace/i, '{"pages":[{"title":"Peace of Westphalia","excerpt":"treaties"}]}'],
  [/rest\.php\/v1\/search\/page/, '{"pages":[]}'],
  [/rest_v1\/page\/html\/Peace_of_Westphalia$/, 'article-westphalia.html'],
];
const OFF = { ...DEFAULTS, online: { ...DEFAULTS.online, enabled: false } };
const noLibrary = () => ({ available: () => false, info: async () => ({}) });

// one cortex for the whole test (it survives "restarts"); each boot() is a new process: new fetcher, empty fetch cache
function world() {
  let t = T0;
  const clock = { now: () => t, skip: ms => { t += ms; } };
  const cortex = open({ now: clock.now });
  const busEvents = [];
  const bus = { emit: (name, ev) => busEvents.push({ name, ...ev }) };
  const knowledge = createKnowledgeStore({ cortex, now: clock.now, bus });
  function boot({ config = DEFAULTS, kiwix = noLibrary(), down = false } = {}) {
    const net = fakeNet(ROUTES, { config, start: clock.now() });
    net.setDown(down);
    const tools = createKnowledgeTools({ fetcher: net.fetcher, kiwix, getConfig: () => config, bus, knowledge });
    const runner = createToolRunner(tools);
    return { net, run: (name, args) => runner.run(name, args) };
  }
  return { cortex, clock, knowledge, boot, busEvents };
}
const reuses = cortex => cortex.event.query({ kind: 'lookup', limit: 1000 }).filter(e => e.payload.reused).length;

test('knowledge reuse: the first lookup goes online and stores one node per article', async () => {
  const w = world();
  const { run, net } = w.boot();
  const r = await run('lookup_knowledge', { query: 'Peace of Westphalia' });
  assert.match(r.text, /Wikipedia, online/);
  assert.ok(net.calls.length > 0);
  const n = w.cortex.node.find({ kind: 'knowledge', key: 'kn:wikipedia.org:peace-of-westphalia' });
  assert.ok(n);
  const flat = x => x.replace(/\s+/g, ' ');   // the cortex folds whitespace
  assert.ok(flat(r.text).includes(n.text), 'stored text is the passage text the tool returned');
  assert.equal(n.data.ttlClass, 'stable');
  assert.equal(n.data.url, 'https://en.wikipedia.org/wiki/Peace_of_Westphalia');
});

test('knowledge reuse: the same question after a restart makes no network call and says from memory and how old', async () => {
  const w = world();
  await w.boot().run('lookup_knowledge', { query: 'Peace of Westphalia' });
  w.clock.skip(2 * DAY);
  const { run, net } = w.boot();
  const r = await run('lookup_knowledge', { query: 'When was the Peace of Westphalia signed?' });
  assert.equal(net.calls.length, 0);
  assert.match(r.text, /SOURCE DATA \(Wikipedia, from memory, fetched 2 days ago\)/);
  assert.ok(r.text.includes(w.cortex.node.find({ kind: 'knowledge', key: 'kn:wikipedia.org:peace-of-westphalia' }).text));
  assert.equal(reuses(w.cortex), 1);
  assert.ok(w.busEvents.some(e => e.name === 'net' && e.source === 'cortex' && e.cached === true && e.ok === true));
});

test('knowledge reuse: a stale node is not served while online; the refetch updates the same key', async () => {
  const w = world();
  await w.boot().run('lookup_knowledge', { query: 'Peace of Westphalia' });
  const id = w.cortex.node.find({ kind: 'knowledge', key: 'kn:wikipedia.org:peace-of-westphalia' }).id;
  w.clock.skip(91 * DAY);
  const { run, net } = w.boot();
  const r = await run('lookup_knowledge', { query: 'Peace of Westphalia' });
  assert.ok(net.calls.length > 0);
  assert.match(r.text, /Wikipedia, online/);
  const n = w.cortex.node.find({ kind: 'knowledge', key: 'kn:wikipedia.org:peace-of-westphalia' });
  assert.equal(n.id, id);
  assert.equal(n.data.fetchedAt, new Date(T0 + 91 * DAY).toISOString());
  assert.equal(w.cortex.node.list({ kind: 'knowledge' }).length, 1);
});

test('knowledge reuse: a stale node is served as last known when online lookups are off', async () => {
  const w = world();
  await w.boot().run('lookup_knowledge', { query: 'Peace of Westphalia' });
  w.clock.skip(91 * DAY);
  const { run, net } = w.boot({ config: OFF });
  const r = await run('lookup_knowledge', { query: 'Peace of Westphalia' });
  assert.equal(net.calls.length, 0);
  assert.match(r.text, /last known, from 2026-11-11 \(could not refresh\)/);
});

test('knowledge reuse: a stale node is served as last known when the online lookup fails', async () => {
  const w = world();
  await w.boot().run('lookup_knowledge', { query: 'Peace of Westphalia' });
  w.clock.skip(91 * DAY);
  const r = await w.boot({ down: true }).run('lookup_knowledge', { query: 'Peace of Westphalia' });
  assert.match(r.text, /last known, from 2026-11-11/);
});

test('knowledge reuse: master switch off with a fresh node → served from memory, no network', async () => {
  const w = world();
  await w.boot().run('lookup_knowledge', { query: 'Peace of Westphalia' });
  const { run, net } = w.boot({ config: OFF });
  const r = await run('lookup_knowledge', { query: 'Peace of Westphalia' });
  assert.equal(net.calls.length, 0);
  assert.match(r.text, /from memory/);
});

test('knowledge reuse: switch off and nothing stored → today\'s message', async () => {
  const w = world();
  const r = await w.boot({ config: OFF }).run('lookup_knowledge', { query: 'Peace of Westphalia' });
  assert.match(r.text, /offline library is not installed and online lookups are off/i);
});

test('knowledge reuse: an offline library answer is not stored', async () => {
  const w = world();
  const { fixture } = require('./helpers/fakenet');
  const kiwix = { available: () => true, search: async () => [{ title: 'Middlemarch', path: '/A/Middlemarch' }], article: async () => fixture('article-middlemarch.html'), info: async () => ({ file: 'lib.zim' }) };
  const r = await w.boot({ kiwix }).run('lookup_knowledge', { query: 'Who wrote Middlemarch?' });
  assert.match(r.text, /offline library/);
  assert.equal(w.cortex.node.list({ kind: 'knowledge' }).length, 0);
});

test('knowledge reuse: read_article of the same section twice → the second read makes no network call', async () => {
  const w = world();
  const a = await w.boot().run('read_article', { title: 'Peace of Westphalia' });
  assert.match(a.text, /Wikipedia, online/);
  assert.ok(w.cortex.node.find({ kind: 'knowledge', key: 'kn:wikipedia.org:peace-of-westphalia#article' }));
  const { run, net } = w.boot();
  const b = await run('read_article', { title: 'Peace of Westphalia' });
  assert.equal(net.calls.length, 0);
  assert.match(b.text, /from memory/);
});

test('knowledge reuse: a volatile question is never served from memory', async () => {
  const w = world();
  await w.boot().run('lookup_knowledge', { query: 'Peace of Westphalia' });
  const { run, net } = w.boot();
  await run('lookup_knowledge', { query: 'Peace of Westphalia latest news' });
  assert.ok(net.calls.length > 0);
});

test('knowledge reuse: a conflict is told in the reused answer', async () => {
  const w = world();
  await w.boot().run('lookup_knowledge', { query: 'Peace of Westphalia' });
  w.knowledge.save({ key: 'kn:wikipedia.org:peace-of-westphalia', host: 'en.wikipedia.org', title: 'Peace of Westphalia', url: 'https://en.wikipedia.org/wiki/Peace_of_Westphalia', text: 'The Peace of Westphalia was signed in 1748.', sourceKind: 'web', ttlClass: 'news-ish', tool: 'web_open' });
  const r = await w.boot().run('lookup_knowledge', { query: 'Peace of Westphalia' });
  assert.match(r.text, /from memory/);
  assert.match(r.text, /Another source \(web, en\.wikipedia\.org\) says differently: "The Peace of Westphalia was signed in 1748\."/);
});

// E5: labeled queries — a question that shares one word with a stored node is not answered from it
test('knowledge reuse: labeled queries are classified right (θ and word coverage)', async () => {
  const w = world();
  const docs = {
    'Eiffel Tower': 'The Eiffel Tower is a wrought-iron lattice tower in Paris. It is 330 metres tall.',
    'Peace of Westphalia': 'The Peace of Westphalia is the name for two peace treaties signed in October 1648.',
    'Mount Everest': 'Mount Everest is the highest mountain above sea level, 8,849 metres high, in the Himalayas.',
    'Python (programming language)': 'Python is a high-level, general-purpose programming language created by Guido van Rossum.',
    'Great Wall of China': 'The Great Wall of China is a series of fortifications in northern China, over 21,000 km in length.',
    'Marie Curie': 'Marie Curie was a Polish and French physicist and chemist who did pioneering research on radioactivity.',
  };
  for (const [title, text] of Object.entries(docs)) {
    const r = w.knowledge.save({ key: w.knowledge.keyFor({ host: 'wikipedia.org', title }), host: 'wikipedia.org', title, url: 'https://en.wikipedia.org/wiki/' + title.replace(/ /g, '_'), text, sourceKind: 'wiki', ttlClass: 'stable', tool: 'lookup_knowledge' });
    assert.ok(r.id, title);
  }
  const hit = { 'how tall is the eiffel tower': 'Eiffel Tower', 'peace of westphalia year': 'Peace of Westphalia', 'mount everest height': 'Mount Everest',
    'who was marie curie': 'Marie Curie', 'python programming language': 'Python (programming language)', 'great wall of china length': 'Great Wall of China' };
  for (const [q, title] of Object.entries(hit)) assert.equal((await w.knowledge.find(q))?.title, title, q);
  for (const q of ['tower of london', 'london bridge', 'who was pierre curie', 'everest college tuition', 'china population', 'monty python films']) {
    assert.equal(await w.knowledge.find(q), null, q);
  }
});

test('knowledge reuse: the knowledge skill group hands the store to its tools', async () => {
  const { createGroup } = require('../src/core/skills/knowledge');
  const w = world();
  await w.boot().run('lookup_knowledge', { query: 'Peace of Westphalia' });
  const net = fakeNet(ROUTES, { start: w.clock.now() });
  const g = createGroup({ fetcher: net.fetcher, kiwix: noLibrary(), getConfig: () => DEFAULTS, knowledge: w.knowledge });
  const r = await createToolRunner(g.tools).run('lookup_knowledge', { query: 'Peace of Westphalia' });
  assert.match(r.text, /from memory/);
  assert.equal(net.calls.length, 0);
});

// ---- web_search / web_open (Task 3) ----
const { createWebTools } = require('../src/core/tools/web');
const RESULTS = [
  { title: 'Eiffel Tower - Wikipedia', host: 'en.wikipedia.org', url: 'https://en.wikipedia.org/wiki/Eiffel_Tower', snippet: 'The Eiffel Tower is a wrought-iron lattice tower in Paris, 330 metres tall.' },
  { title: 'Eiffel Tower facts', host: 'example.com', url: 'https://example.com/eiffel', snippet: 'The tower was built for the 1889 World Fair.' },
];
function fakeWeb({ enabled = true, pageText = 'The Eiffel Tower is 300 metres tall and painted gold.' } = {}) {
  const w = { searches: 0, opens: 0, on: enabled, fail: null };
  w.enabled = () => w.on;
  w.search = async q => {
    if (!w.on) throw Object.assign(new Error('web search is switched off in settings'), { code: 'REFUSED' });
    if (/john smith/i.test(q)) throw Object.assign(new Error("the user's full name is never put in a web search"), { code: 'REFUSED' });
    if (w.fail) throw w.fail;
    w.searches++;
    return RESULTS;
  };
  w.open = async url => {
    if (!w.on) throw Object.assign(new Error('web access is switched off in settings'), { code: 'REFUSED' });
    if (w.fail) throw w.fail;
    w.opens++;
    const host = new URL(url).hostname.replace(/^www\./, '');
    return { title: 'Page', url, host, text: pageText, truncated: false };
  };
  return w;
}
function webWorld() {
  const w = world();
  const web = fakeWeb();
  const [search, open] = createWebTools({ web, knowledge: w.knowledge });
  return { ...w, web, search, open };
}

test('web reuse: a search is stored and the same search again makes no web call', async () => {
  const w = webWorld();
  const a = await w.search.run({ query: 'eiffel tower height' });
  assert.match(a, /web search: eiffel tower height/);
  const n = w.cortex.node.find({ kind: 'knowledge', key: 'kn:search:eiffel-tower-height' });
  assert.ok(n);
  assert.equal(n.data.ttlClass, 'news-ish');
  assert.equal(n.sources[0].kind, 'web');
  const b = await w.search.run({ query: 'eiffel tower height' });
  assert.equal(w.web.searches, 1);
  assert.match(b, /from memory, fetched just now/);
  assert.match(b, /Eiffel Tower - Wikipedia/);
});

test('web reuse: a volatile search is not stored and goes online every time', async () => {
  const w = webWorld();
  await w.search.run({ query: 'latest iPhone price' });
  await w.search.run({ query: 'latest iPhone price' });
  assert.equal(w.web.searches, 2);
  assert.equal(w.cortex.node.list({ kind: 'knowledge' }).length, 0);
});

test('web reuse: a refused personal query stores nothing and keeps the refusal', async () => {
  const w = webWorld();
  await assert.rejects(w.search.run({ query: 'john smith address' }), /full name is never put in a web search/);
  assert.equal(w.cortex.node.list({ kind: 'knowledge' }).length, 0);
});

test('web reuse: a page opened twice is read from the web once', async () => {
  const w = webWorld();
  await w.open.run({ url: 'https://example.com/eiffel' });
  const b = await w.open.run({ url: 'https://example.com/eiffel' });
  assert.equal(w.web.opens, 1);
  assert.match(b, /web: example\.com, from memory/);
  assert.match(b, /Name example\.com as the source/);
});

test('web reuse: a page longer than 2,000 chars is stored cut', async () => {
  const w = world();
  const web = fakeWeb({ pageText: Array.from({ length: 600 }, (_, i) => 'w' + i).join(' ') });
  const [, open] = createWebTools({ web, knowledge: w.knowledge });
  await open.run({ url: 'https://example.com/long' });
  const n = w.cortex.node.find({ kind: 'knowledge', key: 'kn:example.com:long' });
  assert.ok(n.text.length <= 2000 && n.text.length > 1500);
});

test('web reuse: a Wikipedia page opened on the web after a wiki lookup contradicts it, and says so', async () => {
  const w = webWorld();
  w.knowledge.save({ key: 'kn:wikipedia.org:eiffel-tower', host: 'wikipedia.org', title: 'Eiffel Tower', url: 'https://en.wikipedia.org/wiki/Eiffel_Tower', text: 'The Eiffel Tower is 330 metres tall.', sourceKind: 'wiki', ttlClass: 'stable', tool: 'lookup_knowledge' });
  w.clock.skip(100 * DAY);   // the wiki node is stale, so the page is read from the web
  const r = await w.open.run({ url: 'https://en.wikipedia.org/wiki/Eiffel_Tower' });
  assert.equal(w.web.opens, 1);
  const wiki = w.cortex.node.find({ kind: 'knowledge', key: 'kn:wikipedia.org:eiffel-tower' });
  assert.equal(wiki.text, 'The Eiffel Tower is 330 metres tall.');
  assert.equal(w.cortex.neighbors(wiki.id, { types: ['contradicts'] }).length, 1);
  assert.match(r, /Another source \(wikipedia, en\.wikipedia\.org\) says differently: "The Eiffel Tower is 330 metres tall\."/);
});

test('web reuse: web switched off with a stale stored search → last known', async () => {
  const w = webWorld();
  await w.search.run({ query: 'eiffel tower height' });
  w.clock.skip(4 * DAY);
  w.web.on = false;
  const r = await w.search.run({ query: 'eiffel tower height' });
  assert.match(r, /last known, from 2026-11-11/);
});

test('web reuse: a network failure with a stale stored page → last known; with nothing stored the error stands', async () => {
  const w = webWorld();
  await w.open.run({ url: 'https://example.com/eiffel' });
  w.clock.skip(4 * DAY);
  w.web.fail = Object.assign(new Error('fetch failed'), { code: 'NETWORK' });
  assert.match(await w.open.run({ url: 'https://example.com/eiffel' }), /last known/);
  await assert.rejects(w.open.run({ url: 'https://example.com/other' }), /fetch failed/);
});

test('web reuse: the web skill group hands the store to its tools', async () => {
  const { createGroup } = require('../src/core/skills/web');
  const w = world();
  const web = fakeWeb();
  const g = createGroup({ web, knowledge: w.knowledge });
  const runner = createToolRunner(g.tools);
  await runner.run('web_search', { query: 'eiffel tower height' });
  await runner.run('web_search', { query: 'eiffel tower height' });
  assert.equal(web.searches, 1);
});

test('knowledge reuse: an answer from memory tells the model to say so and how old it is', async () => {
  const w = webWorld();
  await w.search.run({ query: 'eiffel tower height' });
  assert.match(await w.search.run({ query: 'eiffel tower height' }), /From memory: tell the user it comes from what you looked up earlier, and how old it is\./);
  await w.boot().run('lookup_knowledge', { query: 'Peace of Westphalia' });
  assert.match((await w.boot().run('lookup_knowledge', { query: 'Peace of Westphalia' })).text, /From memory: tell the user/);
});
