// From the user's chat: a voice phrase cut off mid-sentence ("remember my favorite color is…") was saved as the fact
// "my favorite color is", and "forget my favorite color is" was refused as ambiguous although it matched one fact exactly.
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/core/cortex');
const { createMemory } = require('../src/core/memory/facts');
const { createMemorySkill } = require('../src/core/memory/skill');
const { createMemoryTools } = require('../src/core/tools/memory');

const setup = () => { const cortex = open({}); return { cortex, memory: createMemory({ cortex }) }; };

test('memory: a fact cut off mid-sentence is not saved', () => {
  const { memory } = setup();
  for (const t of ['my favorite color is', 'my favorite color is.', 'my dog is called', 'I work at the', 'I like to', 'my sister lives in']) {
    assert.deepEqual(memory.add(t), { ok: false, reason: 'incomplete' }, t);
  }
  assert.deepEqual(memory.list(), []);
  for (const t of ['my favorite color is blue', 'I am a teacher', 'I live in Dallas', 'my cat is called Mia', 'I always leave the hall light on']) assert.equal(memory.add(t).ok, true, t);
});

test('memory: the fast path and the remember tool say a cut-off fact was not saved and ask for the rest', async () => {
  const { memory, cortex } = setup();
  const r = await createMemorySkill({ memory }).handle('Remember my favorite color is.');
  assert.match(r.reply, /cut off/i);
  const remember = createMemoryTools({ memory, cortex }).find(t => t.name === 'remember');
  assert.match(await remember.run({ fact: 'my favorite color is' }), /cut off/i);
  assert.deepEqual(memory.list(), []);
});

test('memory: forget removes the one fact that matches the words exactly, even when others share them', async () => {
  const { memory, cortex } = setup();
  const src = cortex.source.add({ kind: 'user', ref: 'old' });
  cortex.node.upsert({ kind: 'fact', text: 'my favorite color is', data: { tier: 'profile' }, source: src });   // saved before this fix
  memory.add('my favorite color is blue');
  assert.deepEqual(memory.forget('my favorite color is.'), { removed: ['my favorite color is'] });
  assert.deepEqual(memory.list(), ['my favorite color is blue']);
  const r = await createMemorySkill({ memory }).handle('Forget my favorite color is blue.');
  assert.match(r.reply, /Forgot that: my favorite color is blue/);
});
