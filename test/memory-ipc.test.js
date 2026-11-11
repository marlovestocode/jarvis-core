const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open } = require('../src/core/cortex');
const { createMemory } = require('../src/core/memory/facts');
const { createChats } = require('../src/core/memory/chats');
const { createSessionStore } = require('../src/core/session');
const { createMemoryHandlers, validate } = require('../src/main/memory-ipc');

function setup({ confirm = true, savePath, openPath } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmemipc-'));
  const sessions = createSessionStore(dir);
  const cortex = open({});
  const memory = createMemory({ cortex });
  const chats = createChats({ cortex, sessions });
  const calls = [];
  const ctx = {
    memory, cortex, chats, sessions,
    dialog: {
      confirm: async msg => { calls.push(['confirm', msg]); return confirm; },
      saveFile: async () => savePath ?? path.join(dir, 'export.json'),
      openFile: async () => openPath ?? null,
    },
    embedder: { status: async () => ({ model: 'nomic-embed-text', installed: false, mode: 'keyword' }), install: async () => { calls.push(['pull']); return { ok: true }; } },
  };
  const h = createMemoryHandlers(ctx);
  const s = sessions.create(); s.messages.push({ role: 'user', content: 'dog talk' }); sessions.save(s);
  return { dir, ctx, h, calls, memory, cortex, chats, sessions, s };
}

test('memory-ipc: validate refuses oversized, wrong-type, negative and unknown fields', () => {
  const schema = { id: 'id', text: 'str?' };
  assert.equal(validate(schema, { id: 3, text: 'ok' }).ok, true);
  assert.equal(validate(schema, { id: 3 }).ok, true);
  assert.match(validate(schema, { id: 3, text: 'x'.repeat(10 * 1024 * 1024) }).error, /text/);
  assert.match(validate(schema, { id: { $gt: 0 } }).error, /id/);
  assert.match(validate(schema, { id: -1 }).error, /id/);
  assert.match(validate(schema, { id: 1.5 }).error, /id/);
  assert.match(validate(schema, { id: 1, extra: true }).error, /extra/);
  assert.match(validate(schema, null).error, /payload/);
  assert.match(validate({ ids: 'ids' }, { ids: new Array(201).fill(1) }).error, /ids/);
});

test('memory-ipc: every verb refuses a bad payload and writes nothing', async () => {
  const { h, memory, cortex } = setup();
  memory.add('I like jazz');
  const before = JSON.stringify(cortex.export().nodes);
  const bad = [
    ['memory:list', { status: 'all-of-it' }], ['memory:edit', { id: 1, text: 'x'.repeat(10e6) }], ['memory:edit', { id: {}, text: 'a' }],
    ['memory:delete', { id: -4 }], ['memory:approve', { ids: [1], evil: 1 }], ['memory:reject', { ids: 'all' }],
    ['memory:wipe', {}], ['memory:wipe', { confirm: 'forget' }], ['memory:neighbors', { id: '1' }],
    ['summaries:delete', { sessionId: 7 }], ['summaries:delete', {}], ['memory:edit', 'id=1'],
  ];
  for (const [ch, payload] of bad) {
    const r = await h[ch](payload);
    assert.equal(r.ok, false, ch + ' ' + JSON.stringify(payload).slice(0, 40));
    assert.equal(typeof r.error, 'string');
  }
  assert.equal(JSON.stringify(cortex.export().nodes), before);
});

test('memory-ipc: list active and pending with a source line', async () => {
  const { h, memory, s } = setup();
  memory.add('I like jazz');
  memory.propose({ text: 'Rex is my dog', sessionId: s.id });
  memory.propose({ text: 'I live in Abilene', sessionId: '0f0f0f0f-0000-4000-8000-000000000000' });
  const act = await h['memory:list']({ status: 'active' });
  assert.equal(act.ok, true);
  assert.equal(act.items[0].text, 'I like jazz');
  assert.match(act.items[0].origin, /^you said it · /);
  const pend = await h['memory:list']({ status: 'pending' });
  assert.equal(pend.items.length, 2);
  assert.match(pend.items.find(i => i.text === 'Rex is my dog').origin, /^from chat dog talk/);
  assert.equal(pend.items.find(i => /Abilene/.test(i.text)).origin, 'from a deleted chat');
  assert.deepEqual(pend.stats, { active: 1, pending: 2, rejected: 0, cap: 300 });
});

test('memory-ipc: approve, reject, edit, delete', async () => {
  const { h, memory } = setup();
  const a = memory.propose({ text: 'Rex is my dog', sessionId: 's' });
  const b = memory.propose({ text: 'I hate mondays', sessionId: 's' });
  assert.deepEqual(await h['memory:approve']({ ids: [a.id], text: 'Rex is my beagle' }), { ok: true, done: 1 });
  assert.deepEqual(await h['memory:reject']({ ids: [b.id] }), { ok: true, done: 1 });
  assert.equal((await h['memory:list']({ status: 'rejected' })).items.length, 1);
  assert.equal((await h['memory:edit']({ id: a.id, tier: 'profile' })).ok, true);
  assert.equal((await h['memory:edit']({ id: a.id, tier: 'gold' })).ok, false);
  assert.equal((await h['memory:delete']({ id: a.id })).ok, true);
  assert.deepEqual(memory.list(), []);
});

test('memory-ipc: wipe needs the confirm word and removes facts, entities and chats', async () => {
  const { h, memory, chats, cortex } = setup();
  memory.add('I like jazz');
  chats.upsertSummary({ sessionId: 's1', title: 't', n: 4, summary: 'We talked about jazz', topics: [] });
  const r = await h['memory:wipe']({ confirm: 'FORGET' });
  assert.equal(r.ok, true);
  assert.equal(cortex.stats().nodes, 0);
});

test('memory-ipc: neighbors of a fact', async () => {
  const { h, memory } = setup();
  const a = memory.propose({ text: 'Rex is my dog', sessionId: 's', entities: [{ name: 'Rex', type: 'pet' }] });
  memory.approve(a.id);
  const r = await h['memory:neighbors']({ id: a.id });
  assert.equal(r.ok, true);
  assert.equal(r.node.text, 'Rex is my dog');
  assert.deepEqual(r.neighbors.map(n => [n.kind, n.text, n.type]), [['entity', 'Rex', 'mentions']]);
});

test('memory-ipc: installEmbedder declined → no pull request made', async () => {
  const no = setup({ confirm: false });
  const r = await no.h['memory:installEmbedder']();
  assert.deepEqual(r, { ok: false, declined: true });
  assert.deepEqual(no.calls.map(c => c[0]), ['confirm']);
  assert.match(no.calls[0][1], /nomic-embed-text \(about 270 MB\)/);
  const yes = setup({ confirm: true });
  assert.equal((await yes.h['memory:installEmbedder']()).ok, true);
  assert.deepEqual(yes.calls.map(c => c[0]), ['confirm', 'pull']);
  assert.equal((await yes.h['memory:embedder']()).model, 'nomic-embed-text');
});

test('memory-ipc: export writes facts, entities and chats only; import proposes facts as pending', async () => {
  const { h, memory, chats, dir, cortex } = setup();
  memory.add('I like jazz');
  chats.upsertSummary({ sessionId: 's1', title: 't', n: 4, summary: 'We talked about jazz', topics: [] });
  cortex.node.upsert({ kind: 'knowledge', text: 'Jazz began in New Orleans', source: cortex.source.add({ kind: 'wiki', ref: 'x' }) });
  const r = await h['memory:export']();
  assert.equal(r.ok, true);
  const j = JSON.parse(fs.readFileSync(r.path, 'utf8'));
  assert.deepEqual(j.nodes.map(n => n.kind).sort(), ['chat', 'fact']);

  const file = path.join(dir, 'in.json');
  fs.writeFileSync(file, JSON.stringify({ nodes: [{ kind: 'fact', text: 'I like tea' }, { kind: 'fact', text: 'my password is x' }, { kind: 'chat', text: 'no' }], facts: [{ text: 'I like rain' }] }));
  const imp = setup({ openPath: file });
  const r2 = await imp.h['memory:import']();
  assert.deepEqual(r2, { ok: true, proposed: 2, skipped: 1 });
  assert.deepEqual(imp.memory.pending().map(f => f.text).sort(), ['I like rain', 'I like tea']);
  assert.deepEqual(imp.memory.list(), []);
});

test('memory-ipc: summaries list and delete', async () => {
  const { h, chats, s } = setup();
  chats.upsertSummary({ sessionId: s.id, title: 'dog talk', n: 4, summary: 'We talked about the dog', topics: ['dog'] });
  chats.upsertSummary({ sessionId: 'gone', title: 'old', n: 4, summary: 'We talked about the cat', topics: [] });
  const l = await h['summaries:list']();
  assert.equal(l.items.length, 2);
  assert.equal(l.items.find(i => i.sessionId === s.id).exists, true);
  assert.equal(l.items.find(i => i.sessionId === 'gone').exists, false);
  assert.equal((await h['summaries:delete']({ sessionId: 'gone' })).ok, true);
  assert.equal((await h['summaries:list']()).items.length, 1);
  assert.equal((await h['summaries:delete']({ all: true })).ok, true);
  assert.equal((await h['summaries:list']()).items.length, 0);
});
