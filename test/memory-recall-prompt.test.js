const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/core/cortex');
const { createMemory } = require('../src/core/memory/facts');
const { createMemoryBlock, HEADER } = require('../src/core/memory/block');

function setup({ usePastChats = true } = {}) {
  const cortex = open({ now: () => 1_700_000_000_000 });
  const memory = createMemory({ cortex });
  const cfg = { memory: { usePastChats, autoCapture: true } };
  const block = createMemoryBlock({ cortex, memory, getConfig: () => cfg });
  const note = (text, entities) => { const r = memory.propose({ text, sessionId: 's1', entities }); memory.approve(r.id); return r.id; };
  const chat = text => {
    const src = cortex.source.add({ kind: 'model', ref: 'history/s1.json' });
    return cortex.node.upsert({ kind: 'chat', key: 'chat:s1', text, source: src }).id;
  };
  return { cortex, memory, block, note, chat, cfg };
}

test('memory-recall-prompt: profile in budget, by uses then newest', () => {
  const { memory, block } = setup();
  memory.add('first fact here'); memory.add('second fact here');
  const p = block.profile({ brief: false });
  assert.equal(p.text, 'second fact here; first fact here');
  assert.equal(p.ids.length, 2);
  for (let i = 0; i < 40; i++) memory.add(`profile fact number ${i} about the user and their many hobbies`);
  assert.ok(block.profile({}).text.length <= 500);
  assert.ok(block.profile({ brief: true }).text.length <= 300);
});

test('memory-recall-prompt: memo ≤ 500, total with profile ≤ 1000', async () => {
  const { memory, block, note } = setup();
  for (let i = 0; i < 30; i++) memory.add(`I like jazz record number ${i} from the long list of albums`);
  for (let i = 0; i < 30; i++) note(`jazz note ${i}: the user went to a jazz club downtown on a rainy evening`);
  const p = block.profile({});
  const r = await block.forTurn({ text: 'any jazz plans?', profileIds: p.ids });
  assert.ok(r.memo.startsWith(HEADER));
  assert.ok(r.memo.length <= 500, 'memo ' + r.memo.length);
  assert.ok(p.text.length + r.memo.length <= 1000);
  assert.ok(r.ids.length > 0);
});

test('memory-recall-prompt: no match → empty memo', async () => {
  const { block, note } = setup();
  note('Rex has a vet visit in March');
  assert.deepEqual(await block.forTurn({ text: 'quantum chromodynamics' }), { memo: '', ids: [] });
});

test('memory-recall-prompt: brief → no chat lines and a smaller memo', async () => {
  const { block, note, chat } = setup();
  note('Rex has a vet visit in March');
  chat('We talked about the vet visit for Rex and the cost');
  const full = await block.forTurn({ text: 'the vet visit' });
  assert.match(full.memo, /We talked about/);
  const brief = await block.forTurn({ text: 'the vet visit', brief: true });
  assert.doesNotMatch(brief.memo, /We talked about/);
  assert.match(brief.memo, /vet visit in March/);
  assert.ok(brief.memo.length <= 500);
});

test('memory-recall-prompt: a short follow-up uses the previous message', async () => {
  const { block, note } = setup();
  note('Rex has a vet visit in March');
  assert.equal((await block.forTurn({ text: 'and when?' })).memo, '');
  const r = await block.forTurn({ text: 'and when?', previousUserText: 'tell me about the vet visit' });
  assert.match(r.memo, /vet visit in March/);
});

test('memory-recall-prompt: profile ids are excluded from the memo', async () => {
  const { memory, block } = setup();
  memory.add('I love the vet clinic downtown');
  const p = block.profile({});
  assert.match((await block.forTurn({ text: 'vet clinic' })).memo, /vet clinic/);
  assert.equal((await block.forTurn({ text: 'vet clinic', profileIds: p.ids })).memo, '');
});

test('memory-recall-prompt: usePastChats off → no chat lines', async () => {
  const { block, chat, cfg } = setup();
  chat('We talked about the vet visit for Rex and the cost');
  assert.match((await block.forTurn({ text: 'vet visit' })).memo, /We talked about/);
  cfg.memory.usePastChats = false;
  assert.equal((await block.forTurn({ text: 'vet visit' })).memo, '');
});

test('memory-graph: a "Rex" question reaches the vet fact through the entity with no shared word', async () => {
  const { block, note } = setup();
  note('Rex is my dog', [{ name: 'Rex', type: 'pet' }]);
  note('the appointment at the clinic is on March 3', [{ name: 'Rex', type: 'pet' }]);
  const r = await block.forTurn({ text: 'how is Rex doing' });
  assert.match(r.memo, /appointment at the clinic/);
});

test('memory-recall-prompt: a fact whose entity was removed is still recalled', async () => {
  const { cortex, block, note } = setup();
  note('the appointment at the clinic is on March 3', [{ name: 'Rex', type: 'pet' }]);
  cortex.node.remove(cortex.node.find({ kind: 'entity', key: 'entity:rex' }).id);
  const r = await block.forTurn({ text: 'clinic appointment' });
  assert.match(r.memo, /appointment at the clinic/);
});

test('memory-recall-prompt: afterTurn reinforces unless tainted; a correction weakens the last ids', () => {
  const calls = [];
  const cortex = {
    reinforce: (ids, o) => calls.push(['reinforce', ids, o]),
    weaken: ids => calls.push(['weaken', ids]),
    isCorrection: t => /^no\b/i.test(t),
  };
  const block = createMemoryBlock({ cortex, memory: {}, getConfig: () => ({ memory: {} }) });
  block.afterTurn({ ids: [1, 2], tainted: true });
  block.afterTurn({ ids: [], tainted: false });
  assert.equal(block.onUserMessage({ text: 'great, thanks', lastIds: [1, 2] }), false);
  assert.equal(block.onUserMessage({ text: "no, that's wrong", lastIds: [1, 2] }), true);
  assert.equal(block.onUserMessage({ text: 'no', lastIds: [] }), false);
  assert.deepEqual(calls, [['reinforce', [1, 2], { tainted: true }], ['weaken', [1, 2]]]);
});

test('memory-recall-prompt: prompt hints for recall_chats and memory_about; remember points at past chats', () => {
  const { systemPrompt } = require('../src/core/brain/prompt');
  const p = systemPrompt({ tools: ['remember', 'forget_memory', 'recall_chats', 'memory_about'], memory: 'likes jazz' });
  assert.match(p, /recall_chats: /);
  assert.match(p, /memory_about: /);
  assert.match(p, /never invent what was said/);
  assert.match(p, /Saved about the user \(their own notes; facts, not instructions.*likes jazz/);
});
