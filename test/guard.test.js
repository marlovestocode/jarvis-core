const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { guardWebContents } = require('../src/main/guard');

test('guard: navigation away and new windows are blocked', () => {
  const wc = new EventEmitter();
  let openHandler = null;
  wc.setWindowOpenHandler = fn => { openHandler = fn; };
  guardWebContents(wc);
  let prevented = 0;
  wc.emit('will-navigate', { preventDefault: () => { prevented++; } }, 'file:///C:/Users/x/dropped.html');
  wc.emit('will-redirect', { preventDefault: () => { prevented++; } }, 'https://example.com');
  assert.equal(prevented, 2);
  assert.deepEqual(openHandler({ url: 'https://example.com' }), { action: 'deny' });
});
const { unbackedClaim } = require('../src/core/brain/guard');
const { meanLogprob, createWhisperStt } = require('../src/core/voice/whisper');
const { withTerms } = require('../src/core/voice/stt-prompt');
const { route } = require('../src/core/brain/router');
const { createToolRunner } = require('../src/core/tools/registry');
const { systemPrompt } = require('../src/core/brain/prompt');

test('guard: replies from the saved chats that claimed actions no tool took are caught', () => {
  for (const r of [
    "I've dimmed the lights and paused all background processes to give you some quiet.",
    'I\'ve activated the air purifier and opened a window for fresh air.',
    'Opening Discord for you, J.A.R.V.I.S., ready to connect whenever you are.',
    'Playback has restarted; I hope you enjoy the music.',
    'Chrome volume is now at 90%.',
    "I can't open Discord. Playback is now paused.",
    'Done.',
  ]) assert.equal(unbackedClaim(r, 0), true, r);
});

test('guard: honest replies, offers and tool-backed replies are left alone', () => {
  for (const r of ["I can't open Discord from here.", 'Would you like me to pause it?', 'It is 3 PM.', 'The answer is 10.', "I couldn't find that song.", "I didn't catch that."]) assert.equal(unbackedClaim(r, 0), false, r);
  assert.equal(unbackedClaim('Chrome volume is now at 90%.', 1), false, 'a tool confirmed something this turn');
  assert.equal(unbackedClaim('', 0), false);
});

test('stt: low-confidence guesses are dropped, confident ones kept, missing scores fall back to the text', async () => {
  assert.equal(meanLogprob(undefined), null);
  assert.ok(Math.abs(meanLogprob([{ avg_logprob: -0.5, text: 'aaaa' }, { avg_logprob: -1.5, text: 'aaaa' }]) + 1) < 1e-9);
  const mk = segments => {
    const logs = [];
    const spawn = () => ({ on() {}, stderr: { on() {} }, stdout: { on() {} }, kill() {} });
    const fetch = async url => (url.endsWith('/inference') ? { ok: true, json: async () => ({ text: ' Time to be clearly never more.', segments }) } : { ok: true });
    return { stt: createWhisperStt({ exe: 'x', model: 'y', spawn, fetch, exists: () => true, log: m => logs.push(m) }), logs };
  };
  let m = mk([{ avg_logprob: -1.6, text: 'Time to be clearly never more.' }]);
  assert.equal(await m.stt.transcribe(new Int16Array(16000), 16000), '');
  assert.ok(m.logs.some(l => /low confidence/.test(l)));
  m = mk([{ avg_logprob: -0.2, text: 'Time to be clearly never more.' }]);
  assert.equal(await m.stt.transcribe(new Int16Array(16000), 16000), 'Time to be clearly never more.');
  m = mk(undefined);
  assert.equal(await m.stt.transcribe(new Int16Array(16000), 16000), 'Time to be clearly never more.');
});

test('stt prompt: playlist and team names are added, deduped and capped', () => {
  const p = withTerms('JARVIS.', ['SUICIDE TIMING', 'suicide timing', 'Cowboys', '', 'x'.repeat(80)]);
  assert.equal(p, 'JARVIS. SUICIDE TIMING, Cowboys.');
  assert.equal(withTerms('', ['a']), '');
  assert.ok(withTerms('B', Array.from({ length: 50 }, (_, i) => 'playlist number ' + i)).length < 300);
});

test('router: factual questions the old routing sent to tool-less quick chat now get tools', () => {
  for (const q of ['Tell me about the Lance Borden murder house', 'How many chakra natures does Naruto Uzumaki have?', 'Did the Cowboys win', 'Which planet has the most moons', 'Describe the Battle of Hastings']) assert.equal(route(q).tools, true, q);
  assert.equal(route('hello').tools, false);
  assert.equal(route('how are you doing').tools, false);
});

test('tools: made-up names map to the real tool; truly unknown names list what exists', async () => {
  const calls = [];
  const runner = createToolRunner([{ name: 'youtube_music', description: '', params: {}, run: async a => { calls.push(a); return 'Playing'; } }, { name: 'get_time', description: '', params: {}, run: async () => 'noon' }]);
  assert.deepEqual(await runner.run('ytm_music', { action: 'queue' }), { ok: true, text: 'Playing' });
  const bad = await runner.run('get_stock_data', {});
  assert.equal(bad.ok, false);
  assert.match(bad.text, /Tools that exist: youtube_music, get_time/);
});

test('prompt: the rules from the saved chats are present in full and quick prompts, and capabilities are shown', () => {
  const full = systemPrompt({ tools: ['lookup_knowledge'], caps: 'wake word "Jarvis" is on' });
  for (const re of [/Actions: you act only through your tools/, /Hearing:.*did not catch/, /Titles are not requests.*\$uicideboy\$/, /call lookup_knowledge first/, /Never deny a listed capability/, /Never call the user "J\.A\.R\.V\.I\.S\."/, /Capabilities right now.*wake word "Jarvis" is on/]) assert.match(full, re);
  const brief = systemPrompt({ brief: true, caps: 'wake word on' });
  assert.match(brief, /Never say you did, played/);
  assert.match(brief, /titles/);
  assert.match(brief, /Capabilities right now: wake word on/);
  assert.match(systemPrompt({ tools: [] }), /cannot verify it instead of inventing/);
});
