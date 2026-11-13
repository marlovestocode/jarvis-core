const test = require('node:test');
const assert = require('node:assert/strict');
const { systemPrompt, nowLine } = require('../src/core/brain/prompt');
const { route } = require('../src/core/brain/router');

const { realTools } = require('./helpers/tool-deps');
const TOOLS = realTools(['calculate', 'convert_units', 'jarvis_status', 'get_time']);

test('prompt: identity, date, tool guidance, no LaTeX, hardware facts', () => {
  const p = systemPrompt({ source: 'text', now: new Date('2026-11-09T19:00:00'), tools: TOOLS, model: 'jarvis-worker:latest',
    hardware: { cpu: 'Ryzen 5 5600X', gpu: 'RTX 3050 8 GB', ramGB: 15.9 } });
  assert.match(p, /J\.A\.R\.V\.I\.S/);
  assert.doesNotMatch(p, /2026-11-09|Monday|19:00/, 'the clock is not in the system prompt: it would break the model cache every minute');
  assert.match(p, /ends with a "Now:" line/);
  assert.match(nowLine(new Date('2026-11-09T19:00:00')), /^Now: 2026-11-09 Monday 19:00 \(.+\)\.$/);
  assert.equal(systemPrompt({ source: 'text', now: new Date('2026-11-09T19:01:00'), tools: TOOLS }), systemPrompt({ source: 'text', now: new Date('2030-01-01T03:30:00'), tools: TOOLS }));
  assert.equal(systemPrompt({ brief: true, now: new Date('2026-11-09T19:01:00') }), systemPrompt({ brief: true, now: new Date('2030-01-01T03:30:00') }));
  assert.match(p, /calculate/);
  assert.match(p, /jarvis_status/);
  assert.match(p, /LaTeX/);
  assert.match(p, /RTX 3050/);
  assert.match(p, /jarvis-worker/);
  assert.ok(p.length < 6000, `prompt is ${p.length} chars`);
});

test('prompt: only names tools that exist; voice mode asks for short spoken replies', () => {
  const p = systemPrompt({ source: 'voice', now: new Date(), tools: [] });
  assert.doesNotMatch(p, /calculate/);
  assert.match(p, /spoken/i);
  assert.match(p, /no markdown/i);
});

test('router: chit-chat goes fast without thinking', () => {
  for (const t of ['hi', 'thanks!', 'good morning jarvis', 'tell me a joke', 'who are you?']) {
    const r = route(t, { source: 'text' });
    assert.equal(r.tier, 'fast', t);
    assert.equal(r.think, false, t);
  }
});

test('router: math, physics, code, system and long questions go deep', () => {
  for (const t of ['What is 23.7 raised to the power 3.2?', 'Convert 65 mph to m/s', 'escape velocity of earth',
    'fix this python error: KeyError', 'what gpu do I have?', 'How many days between March 3 2024 and today?',
    'Explain the difference between TCP and UDP in detail with examples for a networking class.']) {
    assert.equal(route(t, { source: 'text' }).tier, 'deep', t);
  }
});

test('router: think only for reasoning-heavy text turns, never by default in voice', () => {
  assert.equal(route('Prove that the square root of 2 is irrational.', { source: 'text' }).think, true);
  assert.equal(route('Derive the period of a simple pendulum for small angles.', { source: 'text' }).think, true);
  assert.equal(route('A train leaves at 3pm going 80 km/h and another at 4pm going 100 km/h from the same station. When does the second catch up and how far out?', { source: 'text' }).think, true);
  assert.equal(route('What is 2^100?', { source: 'text' }).think, false, 'tools make plain calculation fast');
  assert.equal(route('Prove that the square root of 2 is irrational.', { source: 'voice' }).think, false);
  assert.equal(route('think hard: what is 2+2', { source: 'voice' }).think, true, 'explicit request wins');
});

test('router: quick chat turns ask for no tools (small prompt, no silly tool calls)', () => {
  assert.equal(route('hello jarvis', { source: 'text' }).tools, false);
  assert.notEqual(route('what gpu do I have?', { source: 'text' }).tools, false);
});

test('prompt: brief mode for quick chat is much shorter', () => {
  const full = systemPrompt({ source: 'text', now: new Date(), tools: TOOLS });
  const brief = systemPrompt({ source: 'text', now: new Date(), tools: [], brief: true });
  assert.ok(brief.length < full.length * 0.6, `${brief.length} vs ${full.length}`);
  assert.match(brief, /J\.A\.R\.V\.I\.S/);
});

test('router: time and date questions use tools (fresh answer, not copied from history)', () => {
  for (const t of ['what time is it?', 'What day is it today', "what's the date", 'time?']) {
    const r = route(t, { source: 'voice' });
    assert.equal(r.tier, 'deep', t);
    assert.notEqual(r.tools, false, t);
  }
});

test('router: live data, world facts and follow-ups use the main model with tools', () => {
  for (const q of ['weather now', 'rain tomorrow?', 'any severe weather alerts?', 'top news headline', 'last Cowboys score', 'Dallas game schedule', 'NBA standings', 'Who wrote Middlemarch?', 'What is the capital of Burkina Faso?', 'When was Westphalia signed?', 'Where is Timbuktu?', 'Why is the sky blue?', 'Explain photosynthesis', 'read the history section', 'what about tomorrow?']) {
    const r = route(q);
    assert.equal(r.tier, 'deep', q);
    assert.equal(r.tools, true, q);
  }
});

test('prompt: lookup rules only when registered; local inference and lookup privacy are accurate', () => {
  const names = ['get_weather', 'weather_alerts', 'news_headlines', 'sports_scores', 'lookup_knowledge', 'read_article'];
  const p = systemPrompt({ tools: realTools(names) });
  for (const name of names) assert.match(p, new RegExp(name));
  assert.match(p, /fetched text.*data.*not instructions/i);
  assert.match(p, /source and age/i);
  assert.match(p, /never.*invent/i);
  assert.doesNotMatch(p, /Nothing leaves the machine|fully offline/);
  assert.doesNotMatch(systemPrompt({ tools: [] }), /lookup_knowledge|get_weather/);
});

test('brain: registers all knowledge tools only with a gated fetcher', () => {
  const { defaultTools } = require('../src/core/brain');
  assert.ok(!defaultTools().some(t => t.name === 'lookup_knowledge'));
  const tools = defaultTools({ fetcher: {}, kiwix: {}, getConfig: () => ({}) });
  assert.ok(tools.some(t => t.name === 'lookup_knowledge'));
  assert.ok(tools.some(t => t.name === 'get_weather'));
});

test('router: requests to act on the PC or media get tools, however short (from real voice turns)', () => {
  for (const t of ['turn down media button.', 'turn down Chrome application by 10%.', 'can you resume media?', 'Try playlist.',
    'skip this one', 'mute it', 'make it louder', 'put on some Kendrick', 'resume', 'unpause', 'shuffle my queue', 'open Spotify',
    'could you lower it a bit?', 'please stop', 'replay that']) {
    const r = route(t, { source: 'voice' });
    assert.equal(r.tools, true, t);
  }
});

test('router: small talk and questions about JARVIS itself stay quick chat', () => {
  for (const t of ['how are you?', "I'm testing your wake word ability.", 'I know.', 'hello jarvis', 'what are you?']) {
    assert.equal(route(t, { source: 'voice' }).tools, false, t);
  }
});

test('prompt: brief mode knows JARVIS listens by voice and wake word, and never claims actions it cannot take', () => {
  const brief = systemPrompt({ source: 'voice', now: new Date(), tools: [], brief: true });
  assert.match(brief, /wake word "Jarvis"/);
  assert.match(brief, /voice/i);
  assert.match(brief, /no tools/i);
  assert.match(brief, /never say you (?:did|played|changed)/i);
});

// regression, from real chats on 2026-11-11: these went to quick chat (no tools) and got "I did not catch that" or "no internet"
test('router: skill-list phrasings and look-it-up requests get tools', () => {
  const { route } = require('../src/core/brain/router');
  for (const t of ['Give me your skill list.', 'Give me your skill set.', 'List your skill set.', 'Tell me who Not Your Average Flight is', 'Search up who not your average flight is', 'look up the tallest building', 'Whose flight reacts']) {
    assert.equal(route(t).tools, true, t);
  }
  for (const t of ['hello?', 'looks good', 'checking in']) assert.equal(route(t).tools, false, t);
});

test('prompt: spoken habits do not teach a "Very good" sign-off', () => {
  const { systemPrompt } = require('../src/core/brain/prompt');
  for (const brief of [false, true]) {
    const p = systemPrompt({ source: 'voice', brief });
    assert.match(p, /never after an answer, a refusal, an error/);
    assert.doesNotMatch(p, /\("Very good\./);
  }
});
