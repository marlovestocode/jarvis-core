const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, parseApp } = require('../src/core/media/intent');
const { createMediaService, normalize, identify } = require('../src/core/media/service');
const { createMediaSkill } = require('../src/core/media/skill');
const { answer, promptLine } = require('../src/core/media/say');
const { createMediaTool, createMediaStatusTool } = require('../src/core/tools/media');
const { createToolRunner } = require('../src/core/tools/registry');

// ---- a fake media host that behaves like Windows: controls change state a moment later ----
function session(over = {}) {
  return { app: 'Chrome', current: true, title: 'Nightmare on the Northside', artist: 'Scrim', albumArtist: '', album: 'A Man Rose from the Dead', subtitle: '', track: 0,
    type: 'Music', status: 'Playing', position: 60, start: 0, end: 205, updated: 1000, shuffle: null, repeat: null, rate: 1,
    can: { play: false, pause: true, playpause: true, stop: true, next: true, prev: true, seek: true, shuffle: false, repeat: false }, ...over };
}
function fakeHost({ sessions = [session()], volume = 0.5, muted = false, apps = [{ process: 'chrome', volume: 0.4, muted: false }], refuse = new Set(), ignore = new Set(), lagReads = 1 } = {}) {
  const st = { sessions, system: { volume, muted }, apps };
  const calls = [];
  let pendingFx = [];
  const now = () => 1000;
  const later = fx => pendingFx.push({ fx, reads: lagReads });
  async function request(cmd, a = {}) {
    calls.push({ cmd, ...a });
    if (cmd === 'state') {
      for (const p of pendingFx) if (--p.reads < 0) p.fx();
      pendingFx = pendingFx.filter(p => p.reads >= 0);
      return JSON.parse(JSON.stringify({ at: now(), ...st }));
    }
    if (cmd === 'control') {
      if (refuse.has(a.action)) return false;
      const s = st.sessions.find(x => x.app === a.app);
      if (!s) throw new Error('No media session for ' + a.app);
      if (ignore.has(a.action)) return true;
      later(() => {
        if (a.action === 'play') { s.status = 'Playing'; s.can.play = false; s.can.pause = true; }
        if (a.action === 'pause') { s.status = 'Paused'; s.can.play = true; s.can.pause = false; }
        if (a.action === 'stop') s.status = 'Stopped';
        if (a.action === 'next') { s.title = 'Next Song'; s.position = 0; }
        if (a.action === 'prev') { s.position = 0; }
        if (a.action === 'seek') s.position = a.value;
        if (a.action === 'shuffle') s.shuffle = a.value;
        if (a.action === 'repeat') s.repeat = ['None', 'Track', 'List'][a.value];
      });
      return true;
    }
    if (cmd === 'volume') {
      if (ignore.has('volume')) return 1;
      later(() => {
        if (a.app) { for (const x of st.apps.filter(x => x.process === a.app)) { if (a.set !== undefined) x.volume = a.set; if (a.mute !== undefined) x.muted = a.mute; } }
        else { if (a.set !== undefined) st.system.volume = a.set; if (a.mute !== undefined) st.system.muted = a.mute; }
      });
      return 1;
    }
    throw new Error('unknown ' + cmd);
  }
  return { request, calls, st };
}
const svc = (host, o = {}) => createMediaService({ request: host.request, sleep: async () => {}, pollMs: 0, verifyMs: 30, ...o });
const controls = host => host.calls.filter(c => c.cmd !== 'state');

// ---- intent ----
test('intent: transport, casual and app-targeted commands', () => {
  const cases = {
    'pause': { action: 'pause' }, 'Jarvis, pause the music.': { action: 'pause' }, 'resume': { action: 'play' }, 'play': { action: 'play' },
    'skip': { action: 'next' }, 'next song please': { action: 'next' }, 'skip this one': { action: 'next' }, 'previous track': { action: 'prev' },
    'go back a song': { action: 'prev' }, 'stop the music': { action: 'stop' }, 'start over': { action: 'seek', to: 0 },
    'pause spotify': { action: 'pause', app: 'Spotify' }, 'skip on youtube': { action: 'next', app: 'YouTube' },
  };
  for (const [said, want] of Object.entries(cases)) assert.deepEqual(parse(said), { kind: 'control', ...want }, said);
});

test('intent: seek relative and absolute', () => {
  assert.deepEqual(parse('go back 30 seconds'), { kind: 'control', action: 'seek', by: -30 });
  assert.deepEqual(parse('skip ahead a minute'), { kind: 'control', action: 'seek', by: 60 });
  assert.deepEqual(parse('rewind ten seconds'), { kind: 'control', action: 'seek', by: -10 });
  assert.deepEqual(parse('rewind'), { kind: 'control', action: 'seek', by: -10 });
  assert.deepEqual(parse('fast forward'), { kind: 'control', action: 'seek', by: 30 });
  assert.deepEqual(parse('go to 1:30'), { kind: 'control', action: 'seek', to: 90 });
  assert.deepEqual(parse('skip to 2 minutes and 10 seconds'), { kind: 'control', action: 'seek', to: 130 });
});

test('intent: volume, mute, shuffle, repeat', () => {
  assert.deepEqual(parse('turn it up a bit'), { kind: 'control', action: 'volume', by: 0.05 });
  assert.deepEqual(parse('turn it up'), { kind: 'control', action: 'volume', by: 0.1 });
  assert.deepEqual(parse('louder'), { kind: 'control', action: 'volume', by: 0.1 });
  assert.deepEqual(parse('a little quieter'), { kind: 'control', action: 'volume', by: -0.05 });
  assert.deepEqual(parse("it's too loud"), { kind: 'control', action: 'volume', by: -0.1 });
  assert.deepEqual(parse('set the volume to 40%'), { kind: 'control', action: 'volume', set: 0.4 });
  assert.deepEqual(parse('volume 25'), { kind: 'control', action: 'volume', set: 0.25 });
  assert.deepEqual(parse('turn spotify down'), { kind: 'control', action: 'volume', by: -0.1, app: 'Spotify', target: 'app' });
  assert.deepEqual(parse('mute'), { kind: 'control', action: 'mute' });
  assert.deepEqual(parse('unmute'), { kind: 'control', action: 'unmute' });
  assert.deepEqual(parse('shuffle off'), { kind: 'control', action: 'shuffle', on: false });
  assert.deepEqual(parse('repeat this song'), { kind: 'control', action: 'repeat', mode: 'track' });
  assert.deepEqual(parse('repeat off'), { kind: 'control', action: 'repeat', mode: 'none' });
});

test('intent: questions about what is playing', () => {
  for (const q of ["what's playing", 'what song is this?', 'what is this song', 'what am i listening to']) assert.equal(parse(q)?.what, 'now', q);
  assert.equal(parse('who sings this')?.what, 'artist');
  assert.equal(parse('what album is this from')?.what, 'album');
  assert.equal(parse('how long is left')?.what, 'time');
  assert.equal(parse("what's the volume")?.what, 'volume');
  assert.equal(parse("what's up next")?.what, 'next');
});

test('intent: ordinary chat and questions are not hijacked', () => {
  for (const q of ['what time is it', 'how do I pause a docker container', 'stop the docker container', 'play a game with me',
    'explain how volume of a sphere works', 'what is next on my calendar', 'repeat that', 'skip the intro and explain gravity', 'who is the president'])
    assert.ok(parse(q) === null || parse(q).kind === 'unsupported', q);
  assert.equal(parse('play a game with me'), null);   // not music: the model answers
  assert.equal(parse('play bohemian rhapsody').kind, 'find');
  assert.equal(parse('stop').loose, true);
  assert.equal(parseApp('Spotify'), 'Spotify');
  assert.equal(parseApp('the one in chrome'), 'Chrome');
});

// ---- state ----
test('state: names, live position, volumes', () => {
  assert.equal(identify('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify').name, 'Spotify');
  assert.equal(identify('308046B0AF4A39CB').name, 'Firefox');
  const st = normalize({ at: 11000, sessions: [session({ updated: 1000 })], system: { volume: 0.5, muted: false }, apps: [{ process: 'chrome', volume: 0.4, muted: false }] });
  const s = st.sessions[0];
  assert.equal(s.app, 'Chrome'); assert.equal(s.status, 'playing'); assert.equal(s.position, 70); assert.equal(s.duration, 205);
  assert.equal(s.volume, 0.4); assert.equal(st.system.volume, 0.5);
  assert.match(promptLine(st), /playing “Nightmare on the Northside” by Scrim \(A Man Rose from the Dead\) in Chrome, 1:10\/3:25\. System volume 50%/);
});

// ---- service: read → act → verify ----
test('service: pause acts on the playing session and verifies', async () => {
  const host = fakeHost();
  const r = await svc(host).act({ action: 'pause' });
  assert.equal(r.ok, true); assert.equal(r.session.status, 'paused');
  assert.deepEqual(controls(host), [{ cmd: 'control', app: 'Chrome', action: 'pause', value: undefined }]);
});

test('service: pause when nothing plays is a no-op, not an action', async () => {
  const host = fakeHost({ sessions: [session({ status: 'Paused' })] });
  const r = await svc(host).act({ action: 'pause' });
  assert.equal(r.ok, true); assert.equal(r.noop, true); assert.equal(controls(host).length, 0);
});

test('service: play picks the right session, asks when two are paused', async () => {
  const two = fakeHost({ sessions: [session({ app: 'Spotify.exe', status: 'Paused', current: false }), session({ status: 'Paused', current: false })] });
  assert.deepEqual((await svc(two).act({ action: 'play' })).clarify, ['Spotify', 'Chrome']);
  const named = fakeHost({ sessions: [session({ app: 'Spotify.exe', status: 'Paused', current: false }), session({ status: 'Paused', current: false })] });
  const r = await svc(named).act({ action: 'play', app: 'Spotify' });
  assert.equal(r.ok, true); assert.equal(controls(named)[0].app, 'Spotify.exe');
});

test('service: a control that does not take is retried once, then reported', async () => {
  const host = fakeHost({ ignore: new Set(['pause']) });
  const r = await svc(host).act({ action: 'pause' });
  assert.equal(r.ok, false); assert.match(r.message, /Chrome didn't pause/);
  assert.equal(controls(host).length, 2);
});

test('service: skip is never retried (no double skip)', async () => {
  const host = fakeHost({ ignore: new Set(['next']) });
  const r = await svc(host).act({ action: 'next' });
  assert.equal(r.ok, false); assert.equal(controls(host).length, 1);
  const ok = await svc(fakeHost()).act({ action: 'next' });
  assert.equal(ok.ok, true); assert.equal(ok.session.title, 'Next Song');
});

test('service: relative and absolute seek, clamped; refused when the player cannot seek', async () => {
  const host = fakeHost();
  const r = await svc(host).act({ action: 'seek', by: -30 });
  assert.equal(r.ok, true); assert.equal(r.value, 30);
  const end = await svc(fakeHost()).act({ action: 'seek', to: 9999 });
  assert.equal(end.value, 204);
  const no = await svc(fakeHost({ sessions: [session({ can: { ...session().can, seek: false } })] })).act({ action: 'seek', by: 10 });
  assert.equal(no.ok, false); assert.equal(no.unsupported, true); assert.match(no.message, /doesn't allow seeking/);
});

test('service: system volume by default, app volume when named, read back', async () => {
  const host = fakeHost();
  const r = await svc(host).act({ action: 'volume', by: 0.05 });
  assert.equal(r.ok, true); assert.equal(r.value, 0.55); assert.equal(r.target, 'system');
  assert.deepEqual(controls(host)[0], { cmd: 'volume', set: 0.55 });
  const app = fakeHost();
  const a = await svc(app).act({ action: 'volume', set: 0.2, app: 'Chrome', target: 'app' });
  assert.equal(a.ok, true); assert.deepEqual(controls(app)[0], { cmd: 'volume', app: 'chrome', set: 0.2 });
  const full = fakeHost({ volume: 1 });
  const f = await svc(full).act({ action: 'volume', by: 0.05 });
  assert.equal(f.ok, true); assert.equal(f.target, 'app'); assert.deepEqual(controls(full)[0], { cmd: 'volume', app: 'chrome', set: 0.45 });
  const up = fakeHost({ muted: true });
  await svc(up).act({ action: 'volume', by: 0.1 });
  assert.equal(up.st.system.muted, false);   // turning it up unmutes
});

test('service: shuffle/repeat refused honestly when the source does not support them', async () => {
  const r = await svc(fakeHost()).act({ action: 'shuffle', on: true });
  assert.equal(r.ok, false); assert.match(r.message, /Chrome doesn't let Windows change shuffle/);
  const sp = fakeHost({ sessions: [session({ app: 'Spotify.exe', shuffle: false, repeat: 'None', can: { ...session().can, shuffle: true, repeat: true } })] });
  assert.equal((await svc(sp).act({ action: 'shuffle', on: true })).ok, true);
  assert.equal((await svc(sp).act({ action: 'repeat', mode: 'track' })).ok, true);
  assert.equal(sp.st.sessions[0].repeat, 'Track');
  const q = await svc(fakeHost()).act({ action: 'queue' });
  assert.equal(q.unsupported, true); assert.match(q.message, /queue/);
});

test('service: host down → media keys, reported as unverified', async () => {
  const keys = [];
  const s = createMediaService({ request: async () => { throw new Error('media host not running'); }, keys: async k => keys.push(k) });
  const r = await s.act({ action: 'next' });
  assert.equal(r.ok, true); assert.equal(r.verified, false); assert.deepEqual(keys, ['next']);
  const no = await s.act({ action: 'seek', by: 10 });
  assert.equal(no.ok, false);
});

// ---- skill: silent voice, short text, spoken answers ----
test('skill: voice controls are silent, text gets one or two words', async () => {
  const skill = createMediaSkill({ service: svc(fakeHost()) });
  const v = await skill.handle('pause', { source: 'voice' });
  assert.equal(v.reply, ''); assert.equal(v.record, 'Paused.'); assert.equal(v.ok, true);
  const t = await createMediaSkill({ service: svc(fakeHost()) }).handle('turn it up a bit', { source: 'text' });
  assert.equal(t.reply, 'Volume 55%.');
  assert.equal(await skill.handle('what is the capital of France', { source: 'voice' }), null);
});

test('skill: questions are answered from fresh state, spoken well', async () => {
  const skill = createMediaSkill({ service: svc(fakeHost()) });
  assert.equal((await skill.handle("what's playing?", { source: 'voice' })).reply,
    'Nightmare on the Northside by Scrim, from A Man Rose from the Dead. In Chrome, 1 minute of 3 minutes 25 seconds.');
  assert.equal((await skill.handle('who sings this', { source: 'voice' })).reply, 'Scrim.');
  assert.equal((await skill.handle('how long is left', { source: 'text' })).reply, '2:25 left, of 3:25.');
  assert.equal((await skill.handle("what's the volume", { source: 'voice' })).reply, '50 percent. Chrome is at 40 percent.');
  assert.match((await skill.handle("what's up next", { source: 'voice' })).reply, /queue/);
});

test('skill: failures and limits are spoken; one short clarifying question', async () => {
  const skill = createMediaSkill({ service: svc(fakeHost({ ignore: new Set(['pause']) })) });
  assert.equal((await skill.handle('pause', { source: 'voice' })).reply, "Chrome didn't pause.");
  const none = createMediaSkill({ service: svc(fakeHost({ sessions: [] })) });
  assert.equal((await none.handle('skip', { source: 'voice' })).reply, "Nothing's playing.");
  assert.equal(await none.handle('stop', { source: 'voice' }), null);   // bare "stop" with nothing playing is not media
  const host = fakeHost({ sessions: [session({ app: 'Spotify.exe', status: 'Paused', current: false }), session({ status: 'Paused', current: false })] });
  const two = createMediaSkill({ service: svc(host) });
  assert.equal((await two.handle('resume', { source: 'voice' })).reply, 'Spotify or Chrome?');
  const r = await two.handle('Spotify', { source: 'voice' });
  assert.equal(r.reply, ''); assert.equal(controls(host)[0].app, 'Spotify.exe');
});

// ---- model tools ----
test('tools: media_control and media_status use the service', async () => {
  const host = fakeHost();
  const service = svc(host);
  const runner = createToolRunner([createMediaTool({ service }), createMediaStatusTool({ service })]);
  const st = await runner.run('media_status', {});
  assert.match(st.text, /Nightmare on the Northside” by Scrim.*In Chrome, 1:00 of 3:25\..*Chrome volume 40%\.\nSystem volume 50%\./s);
  const c = await runner.run('media_control', { action: 'seek', by: 15 });
  assert.equal(c.ok, true); assert.match(c.text, /At 1:15\. Verified\./);
  const bad = await runner.run('media_control', { action: 'shuffle' });
  assert.equal(bad.ok, false); assert.match(bad.text, /doesn't let Windows change shuffle/);
});

test('say: answer with no session', () => {
  assert.equal(answer({ what: 'now' }, { system: { volume: 1, muted: false } }, null, true), "Nothing's playing.");
});
