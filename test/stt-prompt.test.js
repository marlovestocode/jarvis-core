const test = require('node:test');
const assert = require('node:assert/strict');
const { STT_PROMPTS, sttPrompt } = require('../src/core/voice/stt-prompt');

test('stt prompt: v1 keeps every v0 term, adds command vocabulary, stays under ~200 tokens', () => {
  const v0 = STT_PROMPTS.v0.split(/,\s*|\.\s*/).filter(Boolean);
  for (const t of v0) assert.ok(STT_PROMPTS.v1.includes(t), t);
  for (const t of ['YouTube Music', 'volume', 'weather', 'news', 'Wikipedia']) assert.ok(STT_PROMPTS.v1.toLowerCase().includes(t.toLowerCase()), t);
  assert.ok(STT_PROMPTS.v1.length / 4 <= 200, `~${Math.round(STT_PROMPTS.v1.length / 4)} tokens`);
});

test('stt prompt: picked by name, unknown → v1, none → empty', () => {
  assert.equal(sttPrompt('v0'), STT_PROMPTS.v0);
  assert.equal(sttPrompt('none'), '');
  assert.equal(sttPrompt('zzz'), STT_PROMPTS.v1);
});
