const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { memoryOn } = require('./helpers/memory');
const { createMemorySkill } = require('../src/core/memory/skill');
const { createMemoryTools } = require('../src/core/tools/memory');
const { systemPrompt } = require('../src/core/brain/prompt');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jmem-')), 'memory.json');

test('memory: add, dedupe, persist and reload', () => {
  const file = tmp();
  const m = memoryOn(file);
  assert.equal(m.add('I prefer Fahrenheit.').ok, true);
  assert.equal(m.add('i prefer fahrenheit').duplicate, true);
  assert.equal(m.count(), 1);
  assert.deepEqual(memoryOn(file).list(), ['I prefer Fahrenheit']);
});

test('memory: refuses secrets, empty and long text', () => {
  const m = memoryOn(tmp());
  assert.equal(m.add('my password is hunter2').reason, 'secret');
  assert.equal(m.add('card 4111 1111 1111 1111').reason, 'secret');
  assert.equal(m.add('hi').reason, 'empty');
  assert.equal(m.add('x'.repeat(300)).reason, 'long');
  assert.equal(m.count(), 0);
});

test('memory: forget by words; several matches need all=true; cap drops the oldest', () => {
  const m = memoryOn(tmp(), { caps: { active: 3 }, addTier: 'note' });
  m.add('Daniel likes jazz'); m.add('Daniel likes tea'); m.add('Daniel owns an RTX 3050');
  assert.equal(m.forget('jazz').removed.length, 1);
  m.add('Daniel likes rain');
  const amb = m.forget('daniel likes');
  assert.equal(amb.removed.length, 0);
  assert.equal(amb.ambiguous.length, 2);
  assert.equal(m.forget('daniel likes', { all: true }).removed.length, 2);
  m.add('aaaaaa'); m.add('bbbbbb'); m.add('cccccc'); m.add('dddddd');
  assert.equal(m.count(), 3);
  assert.deepEqual(m.list(), ['bbbbbb', 'cccccc', 'dddddd']);
  assert.equal(m.forget('zzzz').removed.length, 0);
});

test('memory: digest is newest first and within the budget', () => {
  const m = memoryOn(tmp());
  m.add('first fact here'); m.add('second fact here');
  assert.equal(m.digest(), 'second fact here; first fact here');
  assert.equal(m.digest(25), 'second fact here');
  assert.equal(memoryOn(tmp()).digest(), '');
});

test('memory skill: remember, recall, forget, forget everything, passthrough', async () => {
  const m = memoryOn(tmp());
  const s = createMemorySkill({ memory: m });
  let r = await s.handle('Jarvis, remember that my dog is called Rex.');
  assert.match(r.reply, /your dog is called Rex/);
  assert.equal(m.count(), 1);
  r = await s.handle('what do you remember about me?');
  assert.match(r.reply, /dog is called Rex/);
  r = await s.handle('forget my dog');
  assert.match(r.reply, /Forgot that/);
  assert.equal(m.count(), 0);
  m.add('likes jazz'); m.add('likes tea');
  assert.equal((await s.handle('forget everything')).reply.startsWith('Done'), true);
  assert.equal(m.count(), 0);
  assert.equal((await s.handle('remember my password is abc')).ok, false);
  assert.equal(await s.handle('play some jazz'), null);
  assert.equal(await s.handle('what is the weather'), null);
  assert.equal(await s.handle('forget it'), null);
});

test('memory tools: remember and forget_memory report the real result', async () => {
  const m = memoryOn(tmp());
  const [remember, forget] = createMemoryTools({ memory: m });
  assert.match(await remember.run({ fact: 'User lives in Abilene' }), /^Saved/);
  assert.match(await remember.run({ fact: 'api key is sk-123' }), /Refused/);
  assert.match(await forget.run({ about: 'abilene' }), /^Forgot/);
  assert.match(await forget.run({ about: 'nothing here' }), /Nothing saved/);
});

test('prompt: saved memory appears in full and quick prompts, and is absent when empty', () => {
  assert.match(systemPrompt({ memory: 'likes jazz' }), /Saved about the user.*likes jazz/);
  assert.match(systemPrompt({ memory: 'likes jazz', brief: true }), /likes jazz/);
  assert.doesNotMatch(systemPrompt({}), /Saved about the user/);
});

test('prompt: the user block names them, home, teams, voice and says what is not known', () => {
  const full = systemPrompt({ user: { name: 'Sam', city: 'Abilene, TX', units: 'F', teams: ['Cowboys'], voiceEnrolled: true, about: 'I build apps' } });
  for (const re of [/The user is Sam/, /Abilene, TX \(Fahrenheit/, /Follows: Cowboys/, /recognise their voice/, /In their words: I build apps/, /not been told/]) assert.match(full, re);
  assert.match(systemPrompt({ user: { name: 'Sam' }, brief: true }), /The user is Sam/);
  const anon = systemPrompt({ user: { name: '' } });
  assert.match(anon, /have not told you their name/);
  assert.doesNotMatch(systemPrompt({}), /The user is/);
});

test('memory skill: "call me X" / "my name is X" saves the name through setName', async () => {
  const names = [];
  const s = createMemorySkill({ memory: memoryOn(tmp()), setName: n => names.push(n) });
  assert.match((await s.handle('Jarvis, call me daniel')).reply, /Daniel/);
  await s.handle('my name is Sam Lee');
  assert.deepEqual(names, ['Daniel', 'Sam Lee']);
  assert.equal(await s.handle('my name is the best thing about me and more words here now'), null);
});

test('config and settings: user name and about are kept, trimmed and length-limited', () => {
  const { DEFAULTS } = require('../src/core/config');
  const { applyPatch } = require('../src/core/settings');
  assert.deepEqual({ ...DEFAULTS.user }, { name: '', about: '' });
  const cfgIn = JSON.parse(JSON.stringify(DEFAULTS));
  const ok = applyPatch(cfgIn, { user: { name: '  Sam  ', about: 'builds apps' } }, { providers: new Map(), engines: {} });
  assert.deepEqual(ok.config.user, { name: 'Sam', about: 'builds apps' });
  const bad = applyPatch(cfgIn, { user: { name: 'x'.repeat(61) } }, { providers: new Map(), engines: {} });
  assert.equal(bad.errors.length, 1);
});
