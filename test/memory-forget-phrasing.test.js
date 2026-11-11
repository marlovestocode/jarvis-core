// "Can you remove X from your memory?" (from the user's saved chats, 2026-11-11): the memory tools were never offered,
// so the model said it could not, and the fast path only knew sentences starting with forget/delete/remove.
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/core/cortex');
const { createMemory } = require('../src/core/memory/facts');
const { createMemorySkill } = require('../src/core/memory/skill');
const { createMemoryTools } = require('../src/core/tools/memory');
const { loadGroups, buildCatalog, selectGroups } = require('../src/core/skills');
const { route } = require('../src/core/brain/router');

const ASKS = ['Can you remove that from your memory?', 'Can you remove the testing 523 instruction from your memory please?', 'Can you clean your memory?',
  'Delete that from your memory', 'erase my old address from memory', 'Could you wipe your memories of my ex?'];

function setup() {
  const cortex = open({});
  const memory = createMemory({ cortex });
  return { cortex, memory };
}

test('forget phrasing: removal from memory goes to the tool model, never quick chat', () => {
  for (const t of ASKS) assert.equal(route(t, { source: 'voice' }).tools, true, t);
});

test('forget phrasing: removal from memory loads the memory skill group', () => {
  const { cortex, memory } = setup();
  const cat = buildCatalog(loadGroups({ memory, cortex, getConfig: () => ({}) }));
  for (const t of ASKS) assert.ok(selectGroups(t, {}, cat).includes('memory'), t);
  for (const t of ['Give me your current memory usage.', 'Can you run a memory check?']) assert.ok(!selectGroups(t, {}, cat).includes('memory'), t);
});

test('forget phrasing: the fast path takes a polite "can you remove X from your memory please"', async () => {
  const { memory } = setup();
  memory.add('my favourite colour is green');
  const skill = createMemorySkill({ memory });
  const r = await skill.handle('Can you remove my favourite colour from your memory please?');
  assert.match(r.reply, /Forgot that: my favourite colour is green/);
  assert.deepEqual(memory.list(), []);
  assert.equal(await skill.handle('Delete that from your memory'), null, 'a pronoun goes to the model, which knows what "that" is');
});

test('forget phrasing: when nothing saved matches, the tool says it was never saved and what to do', async () => {
  const { memory, cortex } = setup();
  const forget = createMemoryTools({ memory, cortex }).find(t => t.name === 'forget_memory');
  const text = await forget.run({ about: 'testing 523' });
  assert.match(text, /Nothing saved matches/);
  assert.match(text, /only said in this chat/i);
  assert.match(text, /stop/i);
});
