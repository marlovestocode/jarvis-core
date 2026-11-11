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
