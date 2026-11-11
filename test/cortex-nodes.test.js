const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/core/cortex/db');
const { createSources, TRUST } = require('../src/core/cortex/sources');
const { createNodes } = require('../src/core/cortex/nodes');

function setup() {
  let t = 1_700_000_000_000;
  const now = () => t;
  const db = openDb({ file: ':memory:' });
  const sources = createSources(db, { now });
  const written = [];
  const nodes = createNodes(db, { now, sources, onWrite: (id, kind) => written.push([id, kind]) });
  const src = (kind, ref = kind + '-ref') => sources.add({ kind, ref });
  return { db, sources, nodes, src, written, advance: ms => { t += ms; }, now };
}
const code = fn => { try { fn(); return null; } catch (e) { return e.code; } };
const count = (db, sql, ...a) => db.raw.prepare(sql).get(...a).n;

test('cortex-nodes: source trust defaults per kind', () => {
  const { sources } = setup();
  assert.deepEqual(TRUST, { user: 100, tool: 90, import: 100, wiki: 70, web: 40, model: 20 });
  assert.equal(sources.get(sources.add({ kind: 'web', ref: 'https://x.org' })).trust, 40);
  assert.equal(sources.get(sources.add({ kind: 'import', ref: 'memory.json', trust: 80 })).trust, 80);
  assert.equal(code(() => sources.add({ kind: 'alien', ref: 'x' })), 'source_kind');
});

test('cortex-nodes: upsert a new fact', () => {
  const { nodes, src, written } = setup();
  const r = nodes.upsert({ kind: 'fact', text: 'Rex is my dog', source: src('user'), quote: 'my dog Rex' });
  assert.equal(r.created, true);
  assert.equal(r.conflict, undefined);
  const n = nodes.get(r.id);
  assert.equal(n.text, 'Rex is my dog');
  assert.equal(n.confidence, 100);
  assert.equal(n.status, 'active');
  assert.equal(n.sources[0].kind, 'user');
  assert.equal(n.sources[0].quote, 'my dog Rex');
  assert.deepEqual(written, [[r.id, 'fact']]);
});

test('cortex-nodes: provenance required', () => {
  const { nodes } = setup();
  assert.equal(code(() => nodes.upsert({ kind: 'fact', text: 'Rex is my dog' })), 'no_source');
  assert.equal(code(() => nodes.upsert({ kind: 'fact', text: 'Rex is my dog', source: 999 })), 'no_source');
});

test('cortex-nodes: quote cut to 240 chars', () => {
  const { nodes, src } = setup();
  const { id } = nodes.upsert({ kind: 'fact', text: 'Rex is my dog', source: src('user'), quote: 'q'.repeat(500) });
  assert.equal(nodes.get(id).sources[0].quote.length, 240);
});

test('cortex-nodes: refusals write nothing', () => {
  const { db, nodes, src } = setup();
  const s = src('user');
  assert.equal(code(() => nodes.upsert({ kind: 'fact', text: 'my password is hunter2', source: s })), 'secret');
  assert.equal(code(() => nodes.upsert({ kind: 'fact', text: 'x'.repeat(301), source: s })), 'too_long');
  assert.equal(code(() => nodes.upsert({ kind: 'fact', text: 'fine text', data: { s: 'x'.repeat(5000) }, source: s })), 'data_too_big');
  assert.equal(code(() => nodes.upsert({ kind: 'mystery', text: 'fine text', source: s })), 'kind');
  assert.equal(code(() => nodes.upsert({ kind: 'fact', text: 'fine text', status: 'deleted', source: s })), 'status');
  assert.equal(count(db, 'SELECT count(*) n FROM node'), 0);
});

test('cortex-nodes: higher trust replaces the slot and archives the old text', () => {
  const { db, nodes, src, advance } = setup();
  const a = nodes.upsert({ kind: 'entity', key: 'entity:rex', text: 'Rex the cat', source: src('web') });
  advance(1000);
  const b = nodes.upsert({ kind: 'entity', key: 'entity:rex', text: 'Rex the dog', source: src('user') });
  assert.equal(b.id, a.id);
  assert.equal(b.conflict, 'replaced');
  const slot = nodes.find({ kind: 'entity', key: 'entity:rex' });
  assert.equal(slot.text, 'Rex the dog');
  assert.equal(slot.confidence, 100);
  const old = db.raw.prepare("SELECT n.* FROM edge e JOIN node n ON n.id = e.dst WHERE e.src = ? AND e.type = 'supersedes'").get(a.id);
  assert.equal(old.text, 'Rex the cat');
  assert.equal(old.status, 'archived');
  assert.equal(old.key, null);
  assert.equal(JSON.parse(old.data)._slot, 'entity:rex');
  assert.equal(nodes.get(old.id).sources[0].kind, 'web');
});

test('cortex-nodes: equal trust, newer wins', () => {
  const { nodes, src } = setup();
  nodes.upsert({ kind: 'fact', key: 'pref:units', text: 'uses Celsius', source: src('user', 's1') });
  const r = nodes.upsert({ kind: 'fact', key: 'pref:units', text: 'uses Fahrenheit', source: src('user', 's2') });
  assert.equal(r.conflict, 'replaced');
  assert.equal(nodes.find({ kind: 'fact', key: 'pref:units' }).text, 'uses Fahrenheit');
});

test('cortex-nodes: lower trust contradicts and the slot keeps its value', () => {
  const { db, nodes, src } = setup();
  const a = nodes.upsert({ kind: 'entity', key: 'entity:rex', text: 'Rex the dog', source: src('user') });
  const b = nodes.upsert({ kind: 'entity', key: 'entity:rex', text: 'Rex the cat', source: src('web') });
  assert.equal(b.conflict, 'contradicts');
  assert.notEqual(b.id, a.id);
  assert.equal(nodes.find({ kind: 'entity', key: 'entity:rex' }).text, 'Rex the dog');
  const n = nodes.get(b.id);
  assert.equal(n.key, null);
  assert.equal(n.data._slot, 'entity:rex');
  assert.equal(n.status, 'active');
  assert.equal(count(db, "SELECT count(*) n FROM edge WHERE src = ? AND dst = ? AND type = 'contradicts'", b.id, a.id), 1);
});

test('cortex-nodes: same text on a slot adds provenance and raises confidence', () => {
  const { nodes, src } = setup();
  const a = nodes.upsert({ kind: 'knowledge', key: 'kn:x', text: 'Paris is the capital of France', source: src('wiki', 'https://en.wikipedia.org/wiki/Paris') });
  const b = nodes.upsert({ kind: 'knowledge', key: 'kn:x', text: 'paris is the capital of france.', source: src('web', 'https://example.org/p') });
  assert.equal(b.id, a.id);
  assert.equal(b.created, false);
  assert.equal(b.conflict, undefined);
  assert.equal(nodes.get(a.id).confidence, 75);
  const c = nodes.upsert({ kind: 'fact', key: 'pref:x', text: 'likes tea', source: src('user', 'a') });
  nodes.upsert({ kind: 'fact', key: 'pref:x', text: 'likes tea', source: src('import', 'b') });
  assert.equal(nodes.get(c.id).confidence, 100);
});

test('cortex-nodes: same source twice is not independent', () => {
  const { nodes, sources } = setup();
  const s1 = sources.add({ kind: 'wiki', ref: 'https://en.wikipedia.org/wiki/Paris' });
  const s2 = sources.add({ kind: 'wiki', ref: 'https://en.wikipedia.org/wiki/Paris' });
  const a = nodes.upsert({ kind: 'knowledge', key: 'kn:p', text: 'Paris is in France', source: s1 });
  nodes.upsert({ kind: 'knowledge', key: 'kn:p', text: 'Paris is in France', source: s2 });
  assert.equal(nodes.get(a.id).confidence, 70);
});

test('cortex-nodes: upsert to an archived slot revives it', () => {
  const { nodes, src } = setup();
  const a = nodes.upsert({ kind: 'entity', key: 'entity:luna', text: 'Luna the cat', source: src('user') });
  nodes.archive(a.id);
  assert.equal(nodes.get(a.id).status, 'archived');
  const b = nodes.upsert({ kind: 'entity', key: 'entity:luna', text: 'Luna the cat', source: src('user', 'again') });
  assert.equal(b.id, a.id);
  assert.equal(nodes.get(a.id).status, 'active');
});

test('cortex-nodes: tainted turn cannot write user or tool trust', () => {
  const { db, nodes, src } = setup();
  assert.equal(code(() => nodes.upsert({ kind: 'fact', text: 'Rex is my dog', source: src('user'), tainted: true })), 'tainted');
  assert.equal(code(() => nodes.upsert({ kind: 'fact', text: 'Rex is my dog', source: src('tool'), tainted: true })), 'tainted');
  assert.equal(count(db, 'SELECT count(*) n FROM node'), 0);
  assert.equal(nodes.upsert({ kind: 'knowledge', text: 'Rex is a common dog name', source: src('web'), tainted: true }).created, true);
});

test('cortex-nodes: remove cascades, archive keeps the row', () => {
  const { db, nodes, src } = setup();
  const { id } = nodes.upsert({ kind: 'fact', text: 'Rex is my dog', source: src('user') });
  assert.equal(nodes.archive(id), true);
  assert.equal(count(db, 'SELECT count(*) n FROM node'), 1);
  assert.equal(nodes.remove(id), true);
  assert.equal(nodes.get(id), null);
  assert.equal(count(db, 'SELECT count(*) n FROM provenance'), 0);
  assert.equal(nodes.remove(id), false);
});

test('cortex-nodes: list filters, orders and pages', () => {
  const { nodes, src, advance } = setup();
  const s = src('user');
  for (let i = 0; i < 5; i++) { nodes.upsert({ kind: 'fact', text: 'fact number ' + i, source: s }); advance(10); }
  nodes.upsert({ kind: 'entity', key: 'entity:rex', text: 'Rex', source: s });
  const all = nodes.list({ kind: 'fact' });
  assert.equal(all.length, 5);
  assert.equal(all[0].text, 'fact number 4');
  assert.deepEqual(nodes.list({ kind: 'fact', limit: 2, offset: 1 }).map(n => n.text), ['fact number 3', 'fact number 2']);
  nodes.archive(all[0].id);
  assert.equal(nodes.list({ kind: 'fact' }).length, 4);
  assert.equal(nodes.list({ kind: 'fact', status: 'archived' }).length, 1);
});

test('cortex-nodes: touch is lazy until flush', () => {
  const { nodes, src, advance, now } = setup();
  const { id } = nodes.upsert({ kind: 'fact', text: 'Rex is my dog', source: src('user') });
  nodes.touch([id]); nodes.touch([id]);
  assert.equal(nodes.get(id).uses, 0);
  advance(5000);
  nodes.flushUses();
  const n = nodes.get(id);
  assert.equal(n.uses, 2);
  assert.equal(n.last_used, now());
  const byUses = nodes.list({ kind: 'fact', order: 'uses' });
  assert.equal(byUses[0].id, id);
});

test('cortex-nodes: update edits text and FTS follows', () => {
  const { db, nodes, src } = setup();
  const s = src('user');
  const { id } = nodes.upsert({ kind: 'fact', text: 'Rex is my dog', source: s });
  const r = nodes.update(id, { text: 'Rex is my old beagle' }, { source: s });
  assert.deepEqual(r, { id, changed: true });
  assert.equal(nodes.get(id).text, 'Rex is my old beagle');
  assert.equal(count(db, "SELECT count(*) n FROM node_fts WHERE node_fts MATCH 'beagle'"), 1);
  assert.equal(count(db, "SELECT count(*) n FROM node_fts WHERE node_fts MATCH 'dog'"), 0);
});

test('cortex-nodes: update approve pending→active keeps the key', () => {
  const { nodes, src } = setup();
  const s = src('user');
  const { id } = nodes.upsert({ kind: 'entity', key: 'entity:rex', text: 'Rex', status: 'pending', source: s });
  const r = nodes.update(id, { status: 'active', data: { type: 'pet' } }, { source: s });
  assert.equal(r.changed, true);
  const n = nodes.get(id);
  assert.equal(n.status, 'active');
  assert.equal(n.key, 'entity:rex');
  assert.deepEqual(n.data, { type: 'pet' });
});

test('cortex-nodes: update refuses secret, tainted user source and unknown id', () => {
  const { nodes, src } = setup();
  const s = src('user');
  const { id } = nodes.upsert({ kind: 'fact', text: 'Rex is my dog', source: s });
  assert.equal(code(() => nodes.update(id, { text: 'my password is hunter2' }, { source: s })), 'secret');
  assert.equal(code(() => nodes.update(id, { text: 'Rex is a cat' }, { source: s, tainted: true })), 'tainted');
  assert.equal(code(() => nodes.update(9999, { text: 'Rex is a cat' }, { source: s })), 'not_found');
  assert.equal(code(() => nodes.update(id, { status: 'gone' }, { source: s })), 'status');
  assert.equal(nodes.get(id).text, 'Rex is my dog');
});

test('cortex-nodes: update queues re-embed only when text changed', () => {
  const { nodes, src, written } = setup();
  const s = src('user'), m = src('model');
  const { id } = nodes.upsert({ kind: 'fact', text: 'Rex is my dog', status: 'pending', source: s });
  written.length = 0;
  nodes.update(id, { status: 'active', importance: 0.9 }, { source: s });
  assert.deepEqual(written, []);
  assert.deepEqual(nodes.update(id, { text: 'Rex is my dog' }, { source: s }), { id, changed: false });
  assert.deepEqual(written, []);
  nodes.update(id, { text: 'Rex is my beagle' }, { source: m });
  assert.deepEqual(written, [[id, 'fact']]);
  assert.ok(nodes.get(id).sources.some(x => x.kind === 'model'));
});
