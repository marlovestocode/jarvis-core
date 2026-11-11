const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open } = require('../src/core/cortex');
const { createMemory } = require('../src/core/memory/facts');
const { createChats } = require('../src/core/memory/chats');
const { createSessionStore } = require('../src/core/session');
const { createMemoryTools } = require('../src/core/tools/memory');
const { createMemorySkill } = require('../src/core/memory/skill');
const { createToolRunner } = require('../src/core/tools/registry');
const { createGroup } = require('../src/core/skills/memory');
const { measureSpecs } = require('./helpers/spec-size');

function setup({ usePastChats = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmemt-'));
  const sessions = createSessionStore(dir);
  const cortex = open({});
  const memory = createMemory({ cortex });
  const chats = createChats({ cortex, sessions });
  const cfg = { memory: { usePastChats, autoCapture: true } };
  const tools = createMemoryTools({ memory, chats, cortex, getConfig: () => cfg });
  const by = Object.fromEntries(tools.map(t => [t.name, t]));
  // Rex: an approved fact with the entity, a chat that mentions him, and an unrelated pending fact
  const chatId = chats.upsertSummary({ sessionId: 's1', title: 'Dog chat', n: 4, summary: 'We talked about the dog and his checkup.', topics: ['dog'] });
  const vet = memory.propose({ text: 'Rex has a vet visit on March 3', sessionId: 's1', chatNodeId: chatId, entities: [{ name: 'Rex', type: 'pet' }] });
  memory.approve(vet.id);
  memory.propose({ text: 'Rex hates the bath', sessionId: 's1', entities: [{ name: 'Rex', type: 'pet' }] });
  chats.mentions(chatId, ['entity:rex']);
  return { cortex, memory, chats, by, tools, cfg, sessions };
}

test('memory-tools: shapes — names, needsClean, untrusted', () => {
  const { tools, by } = setup();
  assert.deepEqual(tools.map(t => t.name), ['remember', 'forget_memory', 'recall_chats', 'memory_about']);
  assert.equal(by.remember.needsClean, true);
  assert.equal(by.forget_memory.needsClean, true);
  assert.equal(by.recall_chats.untrusted, true);
  for (const t of tools) { assert.equal(t.params.type, 'object'); assert.equal(t.params.additionalProperties, false); }
  assert.deepEqual(by.recall_chats.params.required, ['query']);
  assert.deepEqual(by.memory_about.params.required, ['topic']);
});

test('memory-tools: without chats or a cortex only remember and forget_memory exist', () => {
  const memory = createMemory({ cortex: open({}) });
  assert.deepEqual(createMemoryTools({ memory }).map(t => t.name), ['remember', 'forget_memory']);
});

test('memory-tools: recall_chats answers from summaries, marked untrusted by the runner', async () => {
  const { tools } = setup();
  const r = await createToolRunner(tools).run('recall_chats', { query: 'dog checkup' });
  assert.equal(r.ok, true);
  assert.equal(r.untrusted, true);
  assert.match(r.text, /Dog chat .*checkup/);
});

test('memory-tools: recall_chats with past-chat memory off', async () => {
  const { by } = setup({ usePastChats: false });
  assert.match(await by.recall_chats.run({ query: 'dog' }), /past-chat memory is off/i);
});

test('memory-tools: memory_about lists the vet fact and the chat for "Rex", active only', async () => {
  const { by } = setup();
  const t = await by.memory_about.run({ topic: 'Rex' });
  assert.match(t, /^About Rex/);
  assert.match(t, /Facts: .*vet visit on March 3/);
  assert.match(t, /Chats: .*Dog chat/);
  assert.doesNotMatch(t, /hates the bath/, 'pending facts are not shown');
  assert.ok(t.length <= 1200);
  assert.match(await by.memory_about.run({ topic: 'my dog Rex' }), /vet visit/, 'found by keyword when the key differs');
  assert.match(await by.memory_about.run({ topic: 'quantum' }), /Nothing saved about quantum/);
});

test('memory-tools: remember is refused in a tainted turn (runner gate)', async () => {
  const { tools, memory } = setup();
  const runner = createToolRunner(tools);
  const r = await runner.run('remember', { fact: 'User banks at evil.example' }, { turn: { tainted: true } });
  assert.equal(r.ok, false);
  assert.equal(memory.find('banks evil').length, 0);
});

test('memory skill: "what do you remember about Rex" uses memory_about; "about me" lists facts', async () => {
  const { memory, by } = setup();
  const s = createMemorySkill({ memory, about: topic => by.memory_about.run({ topic }) });
  const r = await s.handle('what do you remember about Rex?');
  assert.match(r.reply, /vet visit on March 3/);
  assert.match((await s.handle('what do you remember about me?')).reply, /I remember 1 thing/);
  assert.equal(await createMemorySkill({ memory }).handle('what do you remember about Rex?'), null, 'no about → the model answers');
});

test('memory group: new tools offered and triggers for past chats', () => {
  const { memory, chats, cortex } = setup();
  const g = createGroup({ memory, chats, cortex, getConfig: () => ({ memory: {} }) });
  assert.deepEqual(g.tools.map(t => t.name), ['remember', 'forget_memory', 'recall_chats', 'memory_about']);
  assert.ok(g.triggers.some(t => t.words.includes('did we talk') && t.words.includes('what do you know about')));
});

test('memory group: the spec-size budget still holds with the new tools', () => {
  const m = measureSpecs();
  assert.ok(m.meanChars <= 0.4 * m.baseline);
});
