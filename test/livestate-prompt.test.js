const test = require('node:test');
const assert = require('node:assert/strict');
const { systemPrompt } = require('../src/core/brain/prompt');

const LIVE = 'Right now:\n- x';
const now = new Date(2026, 10, 12, 10, 0);

test('brief prompt: live appears right after the media line', () => {
  const p = systemPrompt({ brief: true, now, media: 'Media: Song.', live: LIVE });
  assert.ok(p.includes('Media: Song.\n' + LIVE));
});

test('full prompt: live included, after caps line', () => {
  const p = systemPrompt({ now, tools: ['get_weather'], media: 'Media: Song.', caps: 'voice ok', live: LIVE });
  assert.ok(p.includes(LIVE));
  assert.ok(p.indexOf(LIVE) > p.indexOf('Capabilities right now'));
});

test('no live (or empty/non-string) is byte-identical to today', () => {
  for (const brief of [false, true]) {
    const base = systemPrompt({ now, brief, tools: ['get_weather'], media: 'Media: Song.', caps: 'c' });
    assert.equal(systemPrompt({ now, brief, tools: ['get_weather'], media: 'Media: Song.', caps: 'c', live: '' }), base);
    assert.equal(systemPrompt({ now, brief, tools: ['get_weather'], media: 'Media: Song.', caps: 'c', live: undefined }), base);
    assert.equal(systemPrompt({ now, brief, tools: ['get_weather'], media: 'Media: Song.', caps: 'c', live: 5 }), base);
  }
});
