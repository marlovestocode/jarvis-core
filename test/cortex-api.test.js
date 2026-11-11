const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cortexLib = require('../src/core/cortex');
const { createFakeEmbedder } = require('../src/core/cortex/embedder');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jcortex-api-'));

function seed(c) {
  const s = c.source.add({ kind: 'user', ref: 'session-1' });
  const rex = c.node.upsert({ kind: 'entity', key: 'entity:rex', text: 'Rex the dog', source: s }).id;
  const vet = c.node.upsert({ kind: 'fact', text: 'Rex has a vet visit in March', source: s }).id;
  c.link(vet, rex, 'mentions', { weight: 0.5 });
  return { s, rex, vet };
}
const weight = (c, a, b) => c.neighbors(a, { types: ['mentions'] }).find(n => n.id === b)?.weight;

test('cortex-api: full public surface', () => {
  const c = cortexLib.open({});
  for (const f of ['link', 'unlink', 'neighbors', 'recall', 'reinforce', 'weaken', 'isCorrection', 'stats', 'trim', 'backup', 'export', 'wipe', 'health', 'close']) assert.equal(typeof c[f], 'function', f);
  for (const f of ['upsert', 'get', 'find', 'list', 'archive', 'remove']) assert.equal(typeof c.node[f], 'function', 'node.' + f);
  assert.equal(typeof c.source.add, 'function');
  assert.equal(typeof c.event.add, 'function');
  assert.equal(typeof c.event.query, 'function');
  assert.equal(typeof c.consolidate.tick, 'function');
  c.close();
});

test('cortex-api: upsert → recall → reinforce raises the edge; weaken lowers it', async () => {
  const c = cortexLib.open({});
  const { rex, vet } = seed(c);
  const r = await c.recall('Rex vet visit');
  assert.ok(r.items.some(i => i.id === vet));
  const before = weight(c, vet, rex);
  c.reinforce([vet, rex]);
  const after = weight(c, vet, rex);
  assert.ok(after > before, `${after} > ${before}`);
  c.weaken([vet]);
  assert.ok(weight(c, vet, rex) < after);
  c.close();
});

test('cortex-api: validation errors are CortexError, internal errors are typed too', () => {
  const c = cortexLib.open({});
  const s = c.source.add({ kind: 'user', ref: 'x' });
  assert.throws(() => c.node.upsert({ kind: 'fact', text: 'my password is x', source: s }), e => e instanceof cortexLib.CortexError && e.code === 'secret');
  assert.throws(() => c.link(1, 99999, 'mentions'), e => e instanceof cortexLib.CortexError);
  c.close();
});

test('cortex-api: node.remove drops its vector from the search matrix', async () => {
  const embedder = createFakeEmbedder({ dim: 32 });
  const c = cortexLib.open({ embedder });
  const s = c.source.add({ kind: 'user', ref: 'x' });
  const { id } = c.node.upsert({ kind: 'fact', text: 'Rex loves the forest trail', source: s });
  await c.consolidate.tick({ deadlineMs: 50 });   // embeds the queue
  assert.equal(c.stats().vectors, 1);
  c.node.remove(id);
  assert.equal(c.stats().vectors, 0);
  const r = await c.recall('Rex loves the forest trail');
  assert.equal(r.items.length, 0);
  c.close();
});

test('cortex-api: wipe by kind keeps other kinds', () => {
  const c = cortexLib.open({});
  seed(c);
  c.event.add({ kind: 'tool', payload: { name: 'x' } });
  assert.equal(c.wipe({ kinds: ['fact'] }), 1);
  assert.equal(c.stats().nodes, 1);
  assert.equal(c.stats().events, 1);
  assert.throws(() => c.wipe({ kinds: ['nope'] }), e => e.code === 'kind');
  c.close();
});

test('cortex-api: wipe everything removes rows, backups and imported.bak files', () => {
  const dir = tmpDir();
  const c = cortexLib.open({ file: path.join(dir, 'cortex.db') });
  seed(c);
  c.backup();
  fs.writeFileSync(path.join(dir, 'memory.json.imported.bak'), '{}');
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  c.wipe({ everything: true });
  const st = c.stats();
  assert.equal(st.nodes + st.edges + st.events, 0);
  const left = fs.readdirSync(dir).sort();
  assert.ok(!left.some(f => /backup|imported\.bak/.test(f)), left.join(','));
  assert.ok(left.includes('config.json'));
  c.close();
});

test('cortex-api: export has the rows as plain JSON', () => {
  const c = cortexLib.open({});
  const { vet } = seed(c);
  c.event.add({ kind: 'tool', payload: { name: 'x' } });
  const x = c.export();
  const back = JSON.parse(JSON.stringify(x));
  assert.equal(back.version, 1);
  assert.equal(back.nodes.length, 2);
  assert.equal(back.edges.length, 1);
  assert.equal(back.provenance.length, 2);
  assert.equal(back.sources.length, 1);
  assert.equal(back.events.length, 1);
  assert.ok(back.nodes.some(n => n.id === vet && n.text === 'Rex has a vet visit in March'));
  c.close();
});

test('cortex-api: stats numbers and trim', async () => {
  const c = cortexLib.open({});
  seed(c);
  const st = c.stats();
  assert.equal(st.nodes, 2);
  assert.equal(st.edges, 1);
  assert.equal(st.vectors, 0);
  assert.equal(st.mode, 'keyword');
  assert.equal(typeof st.bytes, 'number');
  c.trim();
  assert.ok((await c.recall('Rex vet')).items.length > 0);
  c.close();
});

test('cortex-api: backups rotate to the newest 3', () => {
  const dir = tmpDir();
  let t = 1_700_000_000_000;
  const c = cortexLib.open({ file: path.join(dir, 'cortex.db'), now: () => (t += 1000) });
  seed(c);
  for (let i = 0; i < 5; i++) c.backup();
  assert.equal(fs.readdirSync(dir).filter(f => /^cortex\.backup-\d+\.db$/.test(f)).length, 3);
  assert.ok(c.health().lastBackupAt > 0);
  c.close();
});

test('cortex-api: touch counts flush on close', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'cortex.db');
  const c = cortexLib.open({ file });
  const { vet, rex } = seed(c);
  c.reinforce([vet, rex]);
  c.close();
  const d = cortexLib.open({ file });
  assert.equal(d.node.get(vet).uses, 1);
  d.close();
});

test('cortex-api: nodes written before an embedder existed are embedded after a reopen with one (W1 E8)', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { createFakeEmbedder } = require('../src/core/cortex/embedder');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jcbf-')), 'cortex.db');
  let c = cortexLib.open({ file });
  const s = c.source.add({ kind: 'user', ref: 'x' });
  for (const t of ['Rex is my dog', 'I live in Abilene', 'I like jazz']) c.node.upsert({ kind: 'fact', text: t, source: s });
  c.node.upsert({ kind: 'track', text: 'Some song title', source: s });
  c.close();
  c = cortexLib.open({ file, embedder: createFakeEmbedder({ dim: 64 }) });
  assert.equal(c.consolidate.queue, 3, 'only the kinds that get vectors');
  for (let i = 0; i < 5 && c.consolidate.queue; i++) await c.consolidate.tick({ deadlineMs: 50 });
  assert.equal(c.stats().vectors, 3);
  c.close();
  c = cortexLib.open({ file, embedder: createFakeEmbedder({ dim: 64 }) });
  assert.equal(c.consolidate.queue, 0, 'nothing missing on the next open');
  c.close();
});
