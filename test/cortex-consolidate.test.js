const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cortexLib = require('../src/core/cortex');
const { l2normalize } = require('../src/core/cortex/vectors');
const { createFakeEmbedder } = require('../src/core/cortex/embedder');

const DAY = 864e5;
// embedder from a table: text → fixed direction, so cosines are exact
function tableEmbedder(table, dim = 4) {
  return { id: 'table', dim, status: async () => ({ ok: true }),
    async embed(texts) { return texts.map(t => l2normalize(Float32Array.from(table[t] || [0, 0, 0, 1]))); } };
}
function setup({ embedder, file, idle = () => true } = {}) {
  let t = 1_700_000_000_000;
  const c = cortexLib.open({ embedder, file, now: () => t, isIdle: () => idle() });
  return { c, advance: ms => { t += ms; }, src: kind => c.source.add({ kind, ref: kind + Math.random() }) };
}
async function drain(c) { for (let i = 0; i < 20 && c.consolidate.queue; i++) await c.consolidate.tick({ deadlineMs: 1000 }); }
const similar = (c, a) => c.neighbors(a, { types: ['similar'] });

test('cortex-consolidate: similar link at cos ≥ 0.82, not below', async () => {
  const e = tableEmbedder({ 'fact a': [1, 0, 0, 0], 'fact b': [0.9, Math.sqrt(1 - 0.81), 0, 0], 'fact c': [0.7, Math.sqrt(1 - 0.49), 0, 0] });
  const { c, src } = setup({ embedder: e });
  const s = src('user');
  const a = c.node.upsert({ kind: 'fact', text: 'fact a', source: s }).id;
  const b = c.node.upsert({ kind: 'fact', text: 'fact b', source: s }).id;
  const cc = c.node.upsert({ kind: 'fact', text: 'fact c', source: s }).id;
  await drain(c);
  const n = similar(c, a);
  assert.ok(n.some(x => x.id === b && Math.abs(x.weight - 0.9) < 0.02));
  assert.ok(!n.some(x => x.id === cc));
  c.close();
});

test('cortex-consolidate: dedupe archives the older of two equal-trust non-user nodes', async () => {
  const e = tableEmbedder({ 'Paris is the capital of France': [1, 0, 0, 0], 'The capital of France is Paris': [0.99, Math.sqrt(1 - 0.9801), 0, 0] });
  const { c, src, advance } = setup({ embedder: e });
  const a = c.node.upsert({ kind: 'knowledge', text: 'Paris is the capital of France', source: src('web') }).id;
  advance(1000);
  const b = c.node.upsert({ kind: 'knowledge', text: 'The capital of France is Paris', source: src('web') }).id;
  await drain(c);
  assert.equal(c.node.get(a).status, 'archived');
  assert.equal(c.node.get(b).status, 'active');
  assert.ok(c.neighbors(b, { types: ['same_as'] }).some(x => x.id === a));
  c.close();
});

test('cortex-consolidate: unequal trust is not deduped', async () => {
  const e = tableEmbedder({ 'Paris is the capital of France': [1, 0, 0, 0], 'The capital of France is Paris': [0.99, Math.sqrt(1 - 0.9801), 0, 0] });
  const { c, src } = setup({ embedder: e });
  const a = c.node.upsert({ kind: 'knowledge', text: 'Paris is the capital of France', source: src('wiki') }).id;
  c.node.upsert({ kind: 'knowledge', text: 'The capital of France is Paris', source: src('web') });
  await drain(c);
  assert.equal(c.node.get(a).status, 'active');
  c.close();
});

test('cortex-consolidate: user-trust duplicates are only proposed', async () => {
  const e = tableEmbedder({ 'I like green tea': [1, 0, 0, 0], 'I really like green tea': [0.99, Math.sqrt(1 - 0.9801), 0, 0] });
  const { c, src, advance } = setup({ embedder: e });
  const a = c.node.upsert({ kind: 'fact', text: 'I like green tea', source: src('user') }).id;
  advance(1000);
  const b = c.node.upsert({ kind: 'fact', text: 'I really like green tea', source: src('user') }).id;
  await drain(c);
  assert.equal(c.node.get(a).status, 'active');
  assert.equal(c.node.get(b).status, 'active');
  assert.equal(c.node.get(b).data.proposedMerge, a);
  c.close();
});

test('cortex-consolidate: prune drops faded edges and archives old knowledge/chat, never user facts', async () => {
  const { c, src, advance } = setup({});
  const user = src('user'), web = src('web'), model = src('model');
  const fact = c.node.upsert({ kind: 'fact', text: 'old user fact', source: user }).id;
  const kn = c.node.upsert({ kind: 'knowledge', text: 'old web knowledge', source: web }).id;
  const chat = c.node.upsert({ kind: 'chat', text: 'old chat summary', source: model }).id;
  const userChat = c.node.upsert({ kind: 'chat', text: 'chat the user wrote', source: user }).id;
  c.link(fact, kn, 'touched', { weight: 0.5 });
  c.link(fact, chat, 'same_as', { weight: 0.5 });
  advance(181 * DAY);
  const r = await c.consolidate.tick({ deadlineMs: 1000 });
  assert.ok(r.did.includes('prune'));
  assert.equal(c.node.get(kn).status, 'archived');
  assert.equal(c.node.get(chat).status, 'archived');
  assert.equal(c.node.get(fact).status, 'active');
  assert.equal(c.node.get(userChat).status, 'active');
  assert.deepEqual(c.neighbors(fact, { depth: 1 }).map(x => x.type), ['same_as']);
  c.close();
});

test('cortex-consolidate: not idle → nothing done', async () => {
  const { c, src } = setup({ embedder: createFakeEmbedder({ dim: 16 }), idle: () => false });
  c.node.upsert({ kind: 'fact', text: 'Rex is my dog', source: src('user') });
  const r = await c.consolidate.tick({ deadlineMs: 1000 });
  assert.equal(r.aborted, true);
  assert.deepEqual(r.did, []);
  assert.equal(c.stats().vectors, 0);
  c.close();
});

test('cortex-consolidate: idle turning false mid-tick aborts the rest', async () => {
  let calls = 0;
  const { c, src } = setup({ embedder: createFakeEmbedder({ dim: 16 }), idle: () => ++calls <= 1 });
  c.node.upsert({ kind: 'fact', text: 'Rex is my dog', source: src('user') });
  const r = await c.consolidate.tick({ deadlineMs: 1000 });
  assert.equal(r.aborted, true);
  assert.deepEqual(r.did, ['embed']);
  c.close();
});

test('cortex-consolidate: overlapping tick is refused', async () => {
  const { c, src } = setup({ embedder: createFakeEmbedder({ dim: 16 }) });
  c.node.upsert({ kind: 'fact', text: 'Rex is my dog', source: src('user') });
  const [a, b] = await Promise.all([c.consolidate.tick({ deadlineMs: 1000 }), c.consolidate.tick({ deadlineMs: 1000 })]);
  assert.equal(b.aborted, true);
  assert.deepEqual(b.did, []);
  assert.ok(a.did.includes('embed'));
  c.close();
});

test('cortex-consolidate: each synchronous step stays short on 2,000 nodes', async () => {
  const { c, src, advance } = setup({ embedder: createFakeEmbedder({ dim: 256 }) });
  const s = src('web');
  for (let i = 0; i < 2000; i++) c.node.upsert({ kind: 'knowledge', text: `knowledge item ${i} about topic ${i % 37} and thing ${i % 11}`, source: s });
  advance(DAY * 2);
  let worst = 0;
  for (let i = 0; i < 10; i++) {
    const r = await c.consolidate.tick({ deadlineMs: 8 });
    for (const ms of Object.values(r.steps || {})) worst = Math.max(worst, ms);
  }
  assert.ok(worst <= 8 * 3, 'worst step ' + worst.toFixed(1) + ' ms');   // ×3 slack for a busy runner; the bench reports the real number
  c.close();
});

test('cortex-consolidate: housekeeping runs once per period', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jcortex-hk-'));
  const { c, src, advance } = setup({ file: path.join(dir, 'cortex.db') });
  c.node.upsert({ kind: 'fact', text: 'Rex is my dog', source: src('user') });
  const backups = () => fs.readdirSync(dir).filter(f => /backup/.test(f)).length;
  let r = await c.consolidate.tick({ deadlineMs: 1000 });
  assert.ok(r.did.includes('backup') && r.did.includes('optimize') && r.did.includes('checkpoint') && r.did.includes('check'));
  r = await c.consolidate.tick({ deadlineMs: 1000 });
  assert.ok(!r.did.includes('backup') && !r.did.includes('checkpoint'));
  assert.equal(backups(), 1);
  advance(61 * 60e3);
  r = await c.consolidate.tick({ deadlineMs: 1000 });
  assert.ok(r.did.includes('checkpoint') && !r.did.includes('backup'));
  advance(DAY);
  r = await c.consolidate.tick({ deadlineMs: 1000 });
  assert.ok(r.did.includes('backup'));
  assert.equal(backups(), 2);
  c.close();
});
