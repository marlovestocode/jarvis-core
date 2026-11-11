const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/core/cortex');
const { createKnowledgeStore } = require('../src/core/knowledge/store');
const { entityKey } = require('../src/core/memory/facts');

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const PASSAGE = '[Eiffel Tower › Summary] The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris, France. It is 330 metres tall.';

function setup() {
  let t = T0;
  const clock = { now: () => t, skip: ms => { t += ms; } };
  const cortex = open({ now: clock.now });
  const bus = { events: [], emit(name, ev) { this.events.push([name, ev]); } };
  const k = createKnowledgeStore({ cortex, now: clock.now, bus });
  return { cortex, k, clock, bus };
}
const wiki = (o = {}) => ({ key: 'kn:wikipedia.org:eiffel-tower', host: 'wikipedia.org', title: 'Eiffel Tower', url: 'https://en.wikipedia.org/wiki/Eiffel_Tower', text: PASSAGE, sourceKind: 'wiki', ttlClass: 'stable', tool: 'lookup_knowledge', query: 'how tall is the eiffel tower', ...o });
const knowledgeNodes = (cortex, status = 'active') => cortex.node.list({ kind: 'knowledge', status, limit: 100 });

test('knowledge save: stores the exact passage text and a quote of at most 240 chars', () => {
  const { cortex, k } = setup();
  const r = k.save(wiki());
  assert.ok(r.id);
  const n = cortex.node.get(r.id);
  assert.equal(n.text, PASSAGE);
  assert.equal(n.key, 'kn:wikipedia.org:eiffel-tower');
  assert.equal(n.sources[0].kind, 'wiki');
  assert.equal(n.sources[0].ref, 'https://en.wikipedia.org/wiki/Eiffel_Tower');
  assert.ok(n.sources[0].quote.length <= 240);
  assert.ok(PASSAGE.startsWith(n.sources[0].quote));
});

test('knowledge save: text over 2,000 chars is cut on a word boundary', () => {
  const { cortex, k } = setup();
  const long = Array.from({ length: 400 }, (_, i) => 'word' + i).join(' ');
  const n = cortex.node.get(k.save(wiki({ text: long })).id);
  assert.ok(n.text.length <= 2000);
  assert.ok(long.startsWith(n.text));
  assert.match(long.slice(n.text.length), /^ /);
});

test('knowledge save: data holds url, title, fetchedAt as ISO text and the ttl class', () => {
  const { cortex, k } = setup();
  const n = cortex.node.get(k.save(wiki()).id);
  assert.equal(n.data.url, 'https://en.wikipedia.org/wiki/Eiffel_Tower');
  assert.equal(n.data.title, 'Eiffel Tower');
  assert.equal(n.data.fetchedAt, new Date(T0).toISOString());
  assert.equal(n.data.ttlClass, 'stable');
});

test('knowledge save: a volatile query stores nothing and logs one lookup event', () => {
  const { cortex, k } = setup();
  const r = k.save(wiki({ query: 'latest price of bitcoin' }));
  assert.deepEqual(r, { skipped: 'volatile' });
  assert.equal(knowledgeNodes(cortex).length, 0);
  const ev = cortex.event.query({ kind: 'lookup' });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.volatile, true);
  assert.equal(k.classify('who is the current pope'), 'volatile');
  assert.equal(k.classify('treaty of westphalia'), null);
});

test('knowledge save: the same key from the same source is updated in place, no archived copy', () => {
  const { cortex, k, clock } = setup();
  const a = k.save(wiki());
  clock.skip(864e5);
  const b = k.save(wiki({ text: PASSAGE + ' It was finished in 1889.' }));
  assert.equal(b.id, a.id);
  assert.equal(b.refreshed, true);
  assert.equal(knowledgeNodes(cortex).length, 1);
  assert.equal(knowledgeNodes(cortex, 'archived').length, 0);
  const n = cortex.node.get(a.id);
  assert.match(n.text, /1889/);
  assert.equal(n.data.fetchedAt, new Date(T0 + 864e5).toISOString());
});

test('knowledge save: a web write on a wiki key contradicts it and leaves the wiki text', () => {
  const { cortex, k } = setup();
  const w = k.save(wiki());
  const web = k.save(wiki({ sourceKind: 'web', ttlClass: 'news-ish', tool: 'web_open', text: 'The Eiffel Tower is 300 metres tall and painted gold.' }));
  assert.equal(web.conflict, 'contradicts');
  assert.notEqual(web.id, w.id);
  assert.equal(cortex.node.get(w.id).text, PASSAGE);
  assert.ok(cortex.neighbors(w.id, { types: ['contradicts'] }).some(n => n.id === web.id));
  // the same web page again does not add a second contradicting node
  const again = k.save(wiki({ sourceKind: 'web', ttlClass: 'news-ish', tool: 'web_open', text: 'The Eiffel Tower is 301 metres tall.' }));
  assert.equal(again.id, web.id);
  assert.equal(knowledgeNodes(cortex).length, 2);
  const hit = k.get('kn:wikipedia.org:eiffel-tower');
  assert.equal(hit.sourceKind, 'wiki');
  assert.match(k.conflictNote(hit), /says differently/);
  assert.match(k.conflictNote(hit), /web, en\.wikipedia\.org/);
});

test('knowledge save: a wiki write on a web key replaces it (supersedes)', () => {
  const { cortex, k } = setup();
  const web = k.save(wiki({ sourceKind: 'web', ttlClass: 'news-ish', text: 'The Eiffel Tower is 300 metres tall.' }));
  const w = k.save(wiki());
  assert.equal(w.id, web.id);
  assert.equal(w.conflict, 'replaced');
  assert.equal(cortex.node.get(w.id).text, PASSAGE);
  assert.ok(cortex.neighbors(w.id, { types: ['supersedes'] }).length);
});

test('knowledge save: a title naming a known entity links knowledge about it', () => {
  const { cortex, k } = setup();
  const src = cortex.source.add({ kind: 'user', ref: 's1' });
  const ent = cortex.node.upsert({ kind: 'entity', key: entityKey('Eiffel Tower'), text: 'Eiffel Tower', source: src });
  const r = k.save(wiki());
  assert.ok(cortex.neighbors(r.id, { types: ['about'] }).some(n => n.id === ent.id));
});

test('knowledge save: a passage the cortex refuses (a 16-digit number) is skipped, never thrown', () => {
  const { cortex, k } = setup();
  const logs = [];
  const k2 = createKnowledgeStore({ cortex, log: m => logs.push(m) });
  const r = k2.save(wiki({ text: 'Card 4111 1111 1111 1111 appears on the page about the Eiffel Tower.' }));
  assert.equal(r.skipped, 'refused');
  assert.equal(knowledgeNodes(cortex).length, 0);
  assert.ok(logs.length);
  assert.equal(k.save(wiki({ url: 'https://example.com/a?id=12345678901234567' })).skipped, 'refused');
});

test('knowledge save: no knowledge node ever carries a model source', () => {
  const { cortex, k } = setup();
  k.save(wiki());
  k.save(wiki({ key: 'kn:example.com:page', host: 'example.com', url: 'https://example.com/page', sourceKind: 'web', ttlClass: 'news-ish' }));
  for (const n of knowledgeNodes(cortex)) for (const s of cortex.node.get(n.id).sources) assert.ok(['wiki', 'web'].includes(s.kind));
});

test('knowledge keys: titles, sections and URLs (a wikipedia page maps to the article key)', () => {
  const { k } = setup();
  assert.equal(k.keyFor({ host: 'wikipedia.org', title: 'Eiffel Tower' }), 'kn:wikipedia.org:eiffel-tower');
  assert.equal(k.keyFor({ host: 'wikipedia.org', title: 'Eiffel Tower', section: 'History' }), 'kn:wikipedia.org:eiffel-tower#history');
  assert.deepEqual(k.keyForUrl('https://en.wikipedia.org/wiki/Eiffel_Tower'), { key: 'kn:wikipedia.org:eiffel-tower', host: 'en.wikipedia.org', title: 'Eiffel Tower' });
  assert.equal(k.keyForUrl('https://www.Example.com/News/Item?id=7').key, 'kn:example.com:news-item-id-7');
  assert.equal(k.keyForUrl('not a url'), null);
});
