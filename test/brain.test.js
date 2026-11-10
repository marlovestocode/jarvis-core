const test = require('node:test');
const assert = require('node:assert/strict');
const { systemPrompt } = require('../src/core/brain/prompt');
const { route } = require('../src/core/brain/router');

const TOOLS = ['calculate', 'convert_units', 'jarvis_status', 'get_time'];

test('prompt: identity, date, tool guidance, no LaTeX, hardware facts', () => {
  const p = systemPrompt({ source: 'text', now: new Date('2026-11-09T19:00:00'), tools: TOOLS, model: 'jarvis-worker:latest',
    hardware: { cpu: 'Ryzen 5 5600X', gpu: 'RTX 3050 8 GB', ramGB: 15.9 } });
  assert.match(p, /J\.A\.R\.V\.I\.S/);
  assert.match(p, /2026-11-09/);
  assert.match(p, /Monday/);
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
