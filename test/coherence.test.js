// Coherence fixes from the 2026-11-11 chat review: the claim guard replaces false claims, tool output is capped,
// an empty model answer is retried, and secret song picks stay secret.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBus } = require('../src/core/bus');
const { createSessionStore } = require('../src/core/session');
const { createRegistry } = require('../src/core/providers/provider');
const { NullProvider } = require('../src/core/providers/null-provider');
const { createToolRunner } = require('../src/core/tools/registry');
const { DEFAULTS } = require('../src/core/config');
const { createOrchestrator } = require('../src/core/orchestrator');
const { createFakeProvider } = require('./helpers/fake-provider');
const { unbackedClaim, stripClaims } = require('../src/core/brain/guard');
const { createYtMusicTool } = require('../src/core/tools/media');

function setup(provider, tools) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-coh-'));
  const bus = createBus();
  const events = [];
  bus.on('*', ev => events.push(ev));
  const sessions = createSessionStore(dir);
  const providers = createRegistry();
  providers.add(NullProvider);
  providers.add(provider);
  const orc = createOrchestrator({ bus, sessions, providers, tools: createToolRunner(tools || []), getConfig: () => ({ ...DEFAULTS, provider: provider.id }) });
  const s = sessions.create(); sessions.save(s);
  return { events, sessions, orc, s };
}

test('guard: catches "Queued five", "Sure. Queued..." and promises, leaves answers alone', () => {
  for (const t of ['Queued five', 'Sure. Queued five songs you will love.', 'Added “Chase tha Bag” to MAIN.', "I'll queue five songs now.", 'Playing “x” by Y.']) assert.equal(unbackedClaim(t, 0), true, t);
  for (const t of ['Paused: “cortisol” by Scrim. In Chrome, 2:17 of 3:27.', 'I cannot generate a playlist.', 'Would you like me to add a song?', 'Your top artist is Scrim.', 'Chrome 60%.']) assert.equal(unbackedClaim(t, 0), false, t);
  assert.equal(unbackedClaim('Queued five', 1), false);
});

test('guard: stripClaims drops the claiming sentence and keeps the rest', () => {
  assert.equal(stripClaims('Playing “x” by Y.'), "I haven't actually done that: no tool confirmed it.");
  assert.match(stripClaims('Your top artist is Scrim. Queued five.'), /^Your top artist is Scrim\. I haven't actually done that/);
  assert.doesNotMatch(stripClaims('Your top artist is Scrim. Queued five.'), /Queued/);
});

test('orchestrator: a false claim in text chat is replaced, not appended to', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'Playing “x” by Y.' }, { type: 'done' }]);
  const { sessions, orc, s } = setup(fp);
  const res = await orc.send(s.id, 'play x', { source: 'text' });
  assert.equal(res.reply, "I haven't actually done that: no tool confirmed it.");
  assert.equal(sessions.load(s.id).messages.at(-1).content, res.reply);
});

test('orchestrator: voice has already spoken the claim, so it hears the correction after it', async () => {
  const fp = createFakeProvider([{ type: 'token', text: 'Playing x.' }, { type: 'done' }]);
  const { events, orc, s } = setup(fp);
  const res = await orc.send(s.id, 'play x', { source: 'voice' });
  assert.match(res.reply, /^Playing x\. I haven't actually done that/);
  assert.match(events.filter(e => e.type === 'token').map(e => e.text).join(''), /I haven't actually done that/);
});

test('orchestrator: an empty answer after a tool is retried once with a nudge that is not saved', async () => {
  const fp = createFakeProvider([
    [{ type: 'tool_call', id: 'a', name: 'get_time', args: {} }, { type: 'done' }],
    [{ type: 'done' }],
    [{ type: 'token', text: 'It is noon.' }, { type: 'done' }],
  ]);
  const { sessions, orc, s } = setup(fp, [{ name: 'get_time', description: 't', params: {}, async run() { return 'NOON'; } }]);
  const res = await orc.send(s.id, 'time?', { source: 'text' });
  assert.equal(res.reply, 'It is noon.');
  assert.equal(fp.calls.length, 3);
  assert.match(fp.calls[2].messages.at(-1).content, /Answer the user now/);
  assert.ok(!sessions.load(s.id).messages.some(m => /Answer the user now/.test(m.content)));
});

test('orchestrator: still empty after the retry falls back to the last tool result', async () => {
  const fp = createFakeProvider([[{ type: 'tool_call', id: 'a', name: 'get_time', args: {} }, { type: 'done' }], [{ type: 'done' }]]);
  const { orc, s } = setup(fp, [{ name: 'get_time', description: 't', params: {}, async run() { return 'NOON'; } }]);
  const res = await orc.send(s.id, 'time?', { source: 'text' });
  assert.equal(res.reply, 'NOON');
});

test('orchestrator: tool output is capped for the model, and older turns keep only a short reminder', async () => {
  const big = 'x'.repeat(10000);
  const fp = createFakeProvider([
    [{ type: 'tool_call', id: 'a', name: 'dump', args: {} }, { type: 'done' }],
    [{ type: 'token', text: 'Done reading.' }, { type: 'done' }],
    [{ type: 'token', text: 'Second.' }, { type: 'done' }],
  ]);
  const { orc, s } = setup(fp, [{ name: 'dump', description: 'd', params: {}, async run() { return big; } }]);
  await orc.send(s.id, 'dump it', { source: 'text' });
  const nowTool = fp.calls[1].messages.find(m => m.role === 'tool').content;
  assert.ok(nowTool.length < 2700 && /more characters cut/.test(nowTool), `this turn: ${nowTool.length}`);
  await orc.send(s.id, 'thanks', { source: 'text' });
  const oldTool = fp.calls[2].messages.find(m => m.role === 'tool').content;
  assert.ok(oldTool.length < 500, `old turn: ${oldTool.length}`);
});

function fakeYtm(durations = ['3:45', '1:02:03', '']) {
  const q = [];
  return {
    connected: true,
    played: [],
    upNextCalls: [],
    async enqueue(query) { const item = { title: query.split(' by ')[0], artists: [query.split(' by ')[1] || 'A'], videoId: 'v' + q.length, duration: durations[q.length % durations.length] }; q.push(item); return { ok: true, item, position: 'end' }; },
    async play(query) { this.played.push(query); return { ok: true, started: true, item: { title: query.split(' by ')[0], artists: ['A'] } }; },
    async upNext(count) { this.upNextCalls.push(count); return { now: null, next: q.map(i => ({ title: i.title, artist: i.artists[0], duration: i.duration })), repeat: this.repeat }; },
    async clear() { q.length = 0; return { removed: 0 }; },
  };
}

test('youtube_music: secret picks never show a title, can be played by number, and can be revealed', async () => {
  const ytm = fakeYtm();
  const tool = createYtMusicTool({ ytm });
  const r1 = await tool.run({ action: 'add_to_queue', query: 'Alpha Song by Band', secret: true });
  const r2 = await tool.run({ action: 'add_to_queue', query: 'Beta Song by Band', secret: true });
  for (const r of [r1, r2]) assert.doesNotMatch(r, /Alpha|Beta|Band/);
  const next = await tool.run({ action: 'up_next' });
  assert.doesNotMatch(next, /Alpha|Beta|Band/);
  assert.match(next, /a secret pick; a secret pick/);
  const p = await tool.run({ action: 'play_secret', index: 2 });
  assert.doesNotMatch(p, /Alpha|Beta/);
  assert.equal(ytm.played[0], 'Beta Song by Band');
  const shown = await tool.run({ action: 'reveal_secret' });
  assert.match(shown, /1\. Alpha Song.*2\. Beta Song/);
  assert.match(await tool.run({ action: 'up_next' }), /Alpha Song/);   // revealed: no longer hidden
  await assert.rejects(tool.run({ action: 'play_secret', index: 1 }), /no secret picks/);
});

test('youtube_music: a normal add still names the song', async () => {
  const tool = createYtMusicTool({ ytm: fakeYtm() });
  assert.match(await tool.run({ action: 'add_to_queue', query: 'Gamma by Band' }), /Gamma/);
});

test('youtube_music: up_next asks for 5 songs by default, passes count through and clamps it to 1..25', async () => {
  const ytm = fakeYtm();
  const tool = createYtMusicTool({ ytm });
  assert.equal(await tool.run({ action: 'up_next' }), 'Nothing is queued after this song.');
  await tool.run({ action: 'up_next', count: 10 });
  await tool.run({ action: 'up_next', count: 99 });
  await tool.run({ action: 'up_next', count: 0 });
  await tool.run({ action: 'up_next', count: undefined });
  await tool.run({ action: 'up_next', count: -1 });
  assert.deepEqual(ytm.upNextCalls, [5, 10, 25, 5, 5, 1]);
});

test('youtube_music: up_next shows each song length and the total across m:ss and h:mm:ss', async () => {
  const ytm = fakeYtm(['3:45', '1:02:03']);
  const tool = createYtMusicTool({ ytm });
  await tool.run({ action: 'add_to_queue', query: 'Alpha Song by Band' });
  await tool.run({ action: 'add_to_queue', query: 'Beta Song by Band' });
  const r = await tool.run({ action: 'up_next' });
  assert.match(r, /"Alpha Song" by Band \(3:45\);/);
  assert.match(r, /"Beta Song" by Band \(1:02:03\)\./);
  assert.match(r, /Total 1:05:48\.$/);
  ytm.repeat = 'LIST';
  assert.match(await tool.run({ action: 'up_next' }), /Total 1:05:48\. Repeat LIST\.$/);
});

test('youtube_music: up_next notes how many queued songs have no length', async () => {
  const ytm = fakeYtm(['3:45', '', '']);
  const tool = createYtMusicTool({ ytm });
  for (const query of ['Alpha Song by Band', 'Beta Song by Band', 'Gamma Song by Band']) await tool.run({ action: 'add_to_queue', query });
  const r = await tool.run({ action: 'up_next' });
  assert.match(r, /"Beta Song" by Band; "Gamma Song" by Band\./);   // no length: no duration shown
  assert.match(r, /Total 3:45 \(2 without a length\)\.$/);
});

test('youtube_music: up_next adds no total when no song has a parseable length', async () => {
  const tool = createYtMusicTool({ ytm: fakeYtm(['']) });
  await tool.run({ action: 'add_to_queue', query: 'Alpha Song by Band' });
  assert.equal(await tool.run({ action: 'up_next' }), 'Up next: "Alpha Song" by Band.');
});

test('youtube_music: up_next leaks no title or length for secret picks', async () => {
  const ytm = fakeYtm(['3:45', '1:02:03']);
  const tool = createYtMusicTool({ ytm });
  await tool.run({ action: 'add_to_queue', query: 'Alpha Song by Band', secret: true });
  await tool.run({ action: 'add_to_queue', query: 'Beta Song by Band', secret: true });
  const r = await tool.run({ action: 'up_next' });
  assert.doesNotMatch(r, /Alpha|Beta|Band|3:45|1:02:03/);
  assert.match(r, /a secret pick; a secret pick/);
});

test('orchestrator: a text reply that claims a state with no tool is taken back and redone with a tool', async () => {
  const fp = createFakeProvider([
    [{ type: 'token', text: 'The media is already paused.' }, { type: 'done' }],
    [{ type: 'tool_call', id: 'a', name: 'get_time', args: {} }, { type: 'done' }],
    [{ type: 'token', text: 'It is noon.' }, { type: 'done' }],
  ]);
  const { events, sessions, orc, s } = setup(fp, [{ name: 'get_time', description: 't', params: {}, async run() { return 'NOON'; } }]);
  const res = await orc.send(s.id, 'pause song', { source: 'text' });
  assert.equal(res.reply, 'It is noon.');
  assert.match(fp.calls[1].messages.at(-1).content, /without calling a tool/);
  assert.ok(events.some(e => e.type === 'retract'));
  assert.ok(!sessions.load(s.id).messages.some(m => /already paused/.test(m.content)));
});

test('guard: "already paused" with no tool is a claim; a tool-backed status is not', () => {
  assert.equal(unbackedClaim('The media is already paused.', 0), true);
  assert.equal(unbackedClaim('The media is already paused.', 1), false);
});

test('intent: "pause song" and "pause media" are plain pause commands', () => {
  const { parse } = require('../src/core/media/intent');
  for (const t of ['pause song', 'pause media', 'pause the music']) assert.deepEqual(parse(t), { kind: 'control', action: 'pause' });
});
