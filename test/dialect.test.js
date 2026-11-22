const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve, list, PRESETS } = require('../src/core/voice/dialect');

test('human-jarvis is the default dialect and speaks naturally', () => {
  const d = resolve({});
  assert.equal(d.id, 'human-jarvis');
  assert.equal(d.spoken, 'natural');
  assert.ok(list().some(x => x.id === 'human-jarvis'));
});

test('the older dialects stay selectable and literal', () => {
  for (const id of ['british-formal', 'neutral', 'casual']) {
    const d = resolve({ dialect: id });
    assert.equal(d.id, id);
    assert.equal(d.spoken, 'literal');
  }
});

test('human-jarvis wording: concise, fragments allowed, no stock openers, compact', () => {
  const d = PRESETS['human-jarvis'];
  assert.match(d.diction, /fragment/i);
  assert.match(d.diction, /Never open with "Certainly!"/);
  assert.ok(d.diction.length < 1600, `diction ${d.diction.length}`);
  assert.ok(d.character.length < 700, `character ${d.character.length}`);
});

test('config default dialect is human-jarvis', () => {
  assert.equal(require('../src/core/config').DEFAULTS.speech.dialect, 'human-jarvis');
});
