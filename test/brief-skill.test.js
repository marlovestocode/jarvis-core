'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBriefSkill } = require('../src/core/skills/brief');

const skill = () => createBriefSkill({ brief: { build: async () => 'Good morning. Brief text.' } });

test('brief skill: its phrases speak the brief', async () => {
  for (const p of ['morning brief', 'Morning brief!', 'my morning brief', 'brief me', 'Jarvis, brief me', 'give me the brief', "what's my day look like", 'what does my day look like']) {
    const r = await skill().handle(p, {});
    assert.equal(r?.reply, 'Good morning. Brief text.', p);
    assert.equal(r.tool, 'morning_brief');
    assert.equal(r.ok, true);
  }
});

test('brief skill: anything else is left alone', async () => {
  for (const p of ['morning', 'brief', "what's the weather", 'play my morning playlist', 'brief me on the history of rome']) {
    assert.equal(await skill().handle(p, {}), null, p);
  }
});

test('brief skill: a throwing brief gives a short ok:false reply, not an exception', async () => {
  const s = createBriefSkill({ brief: { build: async () => { throw new Error('x'); } } });
  const r = await s.handle('morning brief', {});
  assert.equal(r.ok, false);
  assert.ok(r.reply.length > 0);
});
