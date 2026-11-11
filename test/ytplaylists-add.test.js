const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cortexOn } = require('./helpers/cortex');
const { createJournalStore } = require('../src/core/media/ytjournal');
const { createYtPlaylists } = require('../src/core/media/ytplaylists');
const { createYtMusic } = require('../src/core/media/ytmusic');
const { createYtEditTool } = require('../src/core/tools/ytplaylists');
const { createMediaSkill } = require('../src/core/media/skill');
const { parse } = require('../src/core/media/intent');
const { defaultTools } = require('../src/core/brain');
const { route } = require('../src/core/brain/router');

// ---- the extension page: playlist_edit ----
const run = t => ({ runs: [{ text: t }] });
async function pageRun(cmd, args, { fetchImpl, loggedIn = true } = {}) {
  const { ytm } = await import('../extension/page.js');
  const saved = { document: globalThis.document, window: globalThis.window, location: globalThis.location, fetch: globalThis.fetch };
  const cfg = { LOGGED_IN: loggedIn, INNERTUBE_CONTEXT: { client: {} }, SESSION_INDEX: '0' };
  globalThis.document = { cookie: 'SAPISID=abc123', querySelector: sel => (sel === 'ytmusic-app' ? {} : null) };
  globalThis.window = { ytcfg: { get: k => cfg[k] } };
  Object.defineProperty(globalThis, 'location', { value: { origin: 'https://music.youtube.com', href: 'https://music.youtube.com/' }, configurable: true, writable: true });
  globalThis.fetch = fetchImpl;
  try { return await ytm(cmd, args); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); }
  }
}
const respond = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });
const V1 = 'dQw4w9WgXcQ', V2 = '9bZkp7q19f0';

test('page playlist_edit: signed request with a duplicate check, results parsed', async () => {
  let seen;
  const r = await pageRun('playlist_edit', { id: 'PLabc1234567', actions: [{ action: 'ADD_VIDEO', videoId: V1 }, { action: 'ADD_VIDEO', videoId: V2 }] }, { fetchImpl: async (url, init) => {
    seen = { url, headers: init.headers, body: JSON.parse(init.body) };
    return respond({ status: 'STATUS_SUCCEEDED', playlistEditResults: [{ playlistEditVideoAddedResultData: { videoId: V1, setVideoId: 'AAAA1111' } }, { playlistEditVideoAddedResultData: { videoId: V2, setVideoId: 'BBBB2222' } }] });
  } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { status: 'STATUS_SUCCEEDED', ok: true, results: [{ videoId: V1, setVideoId: 'AAAA1111' }, { videoId: V2, setVideoId: 'BBBB2222' }] });
  assert.match(seen.url, /browse\/edit_playlist/);
  assert.match(seen.headers.Authorization, /^SAPISIDHASH \d+_[0-9a-f]{40}$/);
  assert.equal(seen.body.playlistId, 'PLabc1234567');
  assert.deepEqual(seen.body.actions[0], { action: 'ACTION_ADD_VIDEO', addedVideoId: V1, dedupeOption: 'DEDUPE_OPTION_CHECK' });
});

test('page playlist_edit: allowDuplicate drops the check; remove carries the row handle', async () => {
  const bodies = [];
  const f = async (_u, init) => { bodies.push(JSON.parse(init.body)); return respond({ status: 'STATUS_SUCCEEDED' }); };
  await pageRun('playlist_edit', { id: 'PLabc1234567', allowDuplicate: true, actions: [{ action: 'ADD_VIDEO', videoId: V1 }] }, { fetchImpl: f });
  assert.deepEqual(bodies[0].actions[0], { action: 'ACTION_ADD_VIDEO', addedVideoId: V1 });
  await pageRun('playlist_edit', { id: 'PLabc1234567', actions: [{ action: 'REMOVE_VIDEO', videoId: V1, setVideoId: 'AAAA1111' }] }, { fetchImpl: f });
  assert.deepEqual(bodies[1].actions[0], { action: 'ACTION_REMOVE_VIDEO', removedVideoId: V1, setVideoId: 'AAAA1111' });
});

test('page playlist_edit: only the fixed changes are accepted, ids are checked, nothing is sent otherwise', async () => {
  let sent = 0;
  const f = async () => { sent++; return respond({ status: 'STATUS_SUCCEEDED' }); };
  const bad = a => pageRun('playlist_edit', a, { fetchImpl: f });
  assert.match((await bad({ id: 'PLabc1234567', actions: [{ action: 'DELETE_PLAYLIST' }] })).error, /not allowed/);
  assert.match((await bad({ id: 'PLabc1234567', actions: [{ action: 'ADD_VIDEO', videoId: 'x y' }] })).error, /not allowed/);
  assert.match((await bad({ id: 'PLabc1234567', actions: [{ action: 'REMOVE_VIDEO', videoId: V1 }] })).error, /not allowed/);
  assert.match((await bad({ id: 'a/b', actions: [{ action: 'ADD_VIDEO', videoId: V1 }] })).error, /Bad playlist id/);
  assert.match((await bad({ id: 'PLabc1234567', actions: [] })).error, /Between 1 and 50/);
  assert.match((await bad({ id: 'PLabc1234567', actions: Array(51).fill({ action: 'ADD_VIDEO', videoId: V1 }) })).error, /Between 1 and 50/);
  assert.equal(sent, 0);
  assert.match((await pageRun('playlist_edit', { id: 'PLabc1234567', actions: [{ action: 'ADD_VIDEO', videoId: V1 }] }, { loggedIn: false, fetchImpl: f })).error, /^AUTH:/);
});

test('page playlist_edit: a refused change reports ok false', async () => {
  const r = await pageRun('playlist_edit', { id: 'PLabc1234567', actions: [{ action: 'ADD_VIDEO', videoId: V1 }] }, { fetchImpl: async () => respond({ status: 'STATUS_FAILED' }) });
  assert.deepEqual([r.ok, r.result.ok, r.result.status], [true, false, 'STATUS_FAILED']);
});

// ---- a fake YouTube Music: playlists that really change ----
const S = (videoId, title, artist) => ({ videoId, title, artists: [artist] });
const SONGS = { stronger: S('strong00001', 'Stronger', 'Kanye West'), lose: S('loseyou0001', 'Lose Yourself', 'Eminem'), till: S('tillcoll001', 'Till I Collapse', 'Eminem') };
const LIST = [
  { id: 'PLgym0000001', title: 'Gym', kind: 'user', editable: true, trackCount: 1 },
  { id: 'PLgym0000002', title: 'Gym Cardio', kind: 'user', editable: true, trackCount: 0 },
  { id: 'PLsaved00001', title: 'Road Trip', kind: 'saved', editable: false, trackCount: 3 },
  { id: 'PLmix000001', title: 'Mix Tape', kind: 'user', editable: true, trackCount: 0 },
  { id: 'PLmix000002', title: 'Mix Tape', kind: 'user', editable: true, trackCount: 0 },
];

function world({ lag = 0, editStatus = 'STATUS_SUCCEEDED', playing = SONGS.lose } = {}) {
  const store = new Map([['PLgym0000001', [{ ...SONGS.till, setVideoId: 'seed0001', available: true }]], ['PLgym0000002', []], ['PLsaved00001', []], ['PLmix000001', []], ['PLmix000002', []]]);
  const calls = [];
  let seq = 0, stale = 0, snapshot = null;
  const link = {
    connected: true, info: { version: '1.2.0' }, calls,
    request: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'playlists') return { playlists: LIST };
      if (cmd === 'status') return { playing: playing ? { ...playing, artist: playing.artists?.[0], state: 1 } : null };
      if (cmd === 'playlist') { const rows = (stale > 0 ? snapshot : store.get(args.id)) || []; if (stale > 0) stale--; return { id: args.id, editable: true, tracks: rows.map(t => ({ ...t })) }; }
      if (cmd === 'playlist_edit') {
        if (editStatus !== 'STATUS_SUCCEEDED') return { status: editStatus, ok: false, results: [] };
        const rows = store.get(args.id); snapshot = rows.map(t => ({ ...t })); stale = lag;
        const results = [];
        for (const a of args.actions) {
          if (a.action === 'ADD_VIDEO') { const song = Object.values(SONGS).find(s => s.videoId === a.videoId) || S(a.videoId, a.videoId, '?'); const row = { ...song, setVideoId: 'set' + (++seq).toString().padStart(5, '0'), available: true }; rows.push(row); results.push({ videoId: a.videoId, setVideoId: row.setVideoId }); }
          else { const i = rows.findIndex(r => r.setVideoId === a.setVideoId); if (i >= 0) rows.splice(i, 1); }
        }
        return { status: 'STATUS_SUCCEEDED', ok: true, results };
      }
      throw new Error('unexpected ' + cmd);
    },
  };
  const finds = [];
  const ytm = {
    status: async () => link.request('status'),
    findSong: async q => { finds.push(q); const k = Object.keys(SONGS).find(n => q.toLowerCase().includes(n)); if (q.includes('stronger by britney')) return { item: S('strongbrit01', 'Stronger', 'Britney Spears'), sure: true, alts: [] };
      if (q === 'stronger') return { item: SONGS.stronger, sure: false, alts: [S('strongbrit01', 'Stronger', 'Britney Spears')] };
      return k ? { item: SONGS[k], sure: true, alts: [] } : { error: `I couldn't find ${q} on YouTube Music.`, notFound: true }; },
  };
  let t = 1_000_000;
  const svcFor = (opts = {}) => createYtPlaylists({ link, ytm, getConfig: () => opts.config || {}, now: () => t, sleep: async ms => { t += ms; }, journal: opts.journal });
  return { store, calls, link, ytm, finds, svcFor, svc: svcFor(), tick: ms => { t += ms; } };
}
const edits = w => w.calls.filter(c => c.cmd === 'playlist_edit');

test('add by name: found, added, read back, and journaled', async () => {
  const w = world();
  const r = await w.svc.addByName('gym', ['stronger by kanye west']);
  assert.equal(r.status, 'ok');
  assert.equal(r.verified, true);
  assert.deepEqual(r.added.map(s => s.title), ['Stronger']);
  assert.equal(w.store.get('PLgym0000001').length, 2);
  assert.equal(edits(w).length, 1);
  assert.deepEqual(edits(w)[0].args.actions, [{ action: 'ADD_VIDEO', videoId: 'strong00001' }]);
  assert.equal(r.entry.items[0].setVideoId, 'set00001');
});

test('add several songs: one request, every song found before anything changes', async () => {
  const w = world();
  const r = await w.svc.addByName('my gym playlist', ['stronger by kanye west', 'lose yourself']);
  assert.equal(r.status, 'ok');
  assert.equal(edits(w).length, 1);
  assert.equal(edits(w)[0].args.actions.length, 2);
  const w2 = world();
  const bad = await w2.svc.addByName('gym', ['lose yourself', 'bohemian rhapsody']);
  assert.equal(bad.status, 'songNotFound');
  assert.equal(edits(w2).length, 0);   // the first song was not added alone
});

test('add: YouTube Music lagging behind the write is waited for, and never claimed early', async () => {
  const slow = world({ lag: 2 });
  assert.equal((await slow.svc.addByName('gym', ['stronger by kanye west'])).verified, true);
  const never = world({ lag: 99 });
  const r = await never.svc.addByName('gym', ['stronger by kanye west']);
  assert.equal(r.status, 'ok');
  assert.equal(r.verified, false);
  assert.equal(r.entry.items.length, 1);   // it was sent, so it can still be undone
});

test('add: a song already there is skipped, never sent', async () => {
  const w = world();
  const r = await w.svc.addByName('gym', ['till i collapse']);
  assert.equal(r.status, 'duplicate');
  assert.equal(edits(w).length, 0);
  assert.equal(r.skipped[0].title, 'Till I Collapse');
});

test('add: the same song as another version is held back unless the user asks for a copy', async () => {
  const w = world();
  w.store.get('PLgym0000001').push({ ...SONGS.stronger, videoId: 'strongvideo1', setVideoId: 'seed0002', available: true });
  const held = await w.svc.addSongs('gym', [SONGS.stronger]);
  assert.equal(held.status, 'duplicate');
  assert.equal(held.held.length, 1);
  assert.equal(edits(w).length, 0);
  const copy = await w.svc.addSongs('gym', [SONGS.stronger], { allowDuplicate: true });
  assert.equal(copy.status, 'ok');
  assert.equal(edits(w).length, 1);
  assert.equal(edits(w)[0].args.allowDuplicate, true);
  const mixed = await world().svc.addSongs('gym', [SONGS.lose, SONGS.till]);   // one new, one there already
  assert.deepEqual([mixed.status, mixed.added.length, mixed.skipped.length], ['ok', 1, 1]);
});

test('add: the same song twice in one request is added once', async () => {
  const w = world();
  const r = await w.svc.addSongs('gym', [SONGS.lose, SONGS.lose]);
  assert.deepEqual([r.added.length, r.skipped.length], [1, 1]);
});

test('add: a refused change is reported as it is, and a refusal that changed nothing is not a success', async () => {
  const w = world({ editStatus: 'STATUS_FAILED' });
  const r = await w.svc.addSongs('gym', [SONGS.lose]);
  assert.equal(r.status, 'failed');
  assert.equal(w.svc.addSongs && (await w.svc.undo()).status, 'nothing');   // nothing was journaled
  // the duplicate check refuses with a failure when the song appeared a moment ago: that is a duplicate, not an error
  const w2 = world({ editStatus: 'STATUS_FAILED' });
  w2.store.get('PLgym0000001').push({ ...SONGS.lose, setVideoId: 'late0001', available: true });
  assert.equal((await w2.svc.addSongs('gym', [SONGS.lose])).status, 'duplicate');
});

test('add: playlists that are missing, unclear or not the user\'s own', async () => {
  const w = world();
  assert.equal((await w.svc.addByName('workout', ['lose yourself'])).status, 'notFound');
  assert.equal((await w.svc.addByName('mix tape', ['lose yourself'])).status, 'ambiguous');
  assert.equal((await w.svc.addByName('road trip', ['lose yourself'])).status, 'readonly');
  assert.equal(w.finds.length, 0);   // no song search for a playlist that cannot be used
  assert.equal(edits(w).length, 0);
});

test('add: an unclear song is a question, and nothing is changed', async () => {
  const w = world();
  const r = await w.svc.addByName('gym', ['stronger']);
  assert.equal(r.status, 'ambiguousSong');
  assert.deepEqual(r.candidates.map(s => s.artists[0]), ['Kanye West', 'Britney Spears']);
  assert.equal(edits(w).length, 0);
});

test('add: limits (config maxBulk, 5000 songs)', async () => {
  const w = world();
  const svc = w.svcFor({ config: { music: { maxBulk: 2 } } });
  const many = Array.from({ length: 3 }, (_, i) => S('bulk000000' + i, 'S' + i, 'A'));
  assert.deepEqual([(await svc.addSongs('gym', many)).status, (await svc.addSongs('gym', many.slice(0, 2))).status], ['tooMany', 'ok']);
  const full = world();
  full.store.set('PLgym0000001', Array.from({ length: 5000 }, (_, i) => ({ videoId: 'vid' + String(i).padStart(8, '0'), setVideoId: 'sv' + i, title: 't' + i, artists: ['a'], available: true })));
  assert.equal((await full.svc.addSongs('gym', [SONGS.lose])).status, 'full');
});

test('add current: the playing song, named playlist; nothing playing is said plainly', async () => {
  const w = world();
  const r = await w.svc.addCurrent('gym');
  assert.deepEqual([r.status, r.current, r.added[0].title], ['ok', true, 'Lose Yourself']);
  assert.equal(edits(w)[0].args.actions[0].videoId, 'loseyou0001');
  assert.equal((await world({ playing: null }).svc.addCurrent('gym')).status, 'nothing');
  assert.equal((await world().svc.addCurrent('road trip')).status, 'readonly');
});

test('undo: removes exactly what was added, once', async () => {
  const w = world();
  await w.svc.addSongs('gym', [SONGS.lose, SONGS.stronger]);
  assert.equal(w.store.get('PLgym0000001').length, 3);
  const r = await w.svc.undo();
  assert.deepEqual([r.status, r.verified, r.removed.length], ['ok', true, 2]);
  assert.deepEqual(w.store.get('PLgym0000001').map(x => x.videoId), ['tillcoll001']);   // the song that was already there stays
  assert.deepEqual(edits(w).at(-1).args.actions.map(a => a.action), ['REMOVE_VIDEO', 'REMOVE_VIDEO']);
  assert.equal((await w.svc.undo()).status, 'nothing');
});

test('undo: songs already gone are not touched; other copies of the same song are left alone', async () => {
  const w = world();
  await w.svc.addSongs('gym', [SONGS.lose]);
  w.store.get('PLgym0000001').push({ ...SONGS.lose, setVideoId: 'mine0001', available: true });   // a copy the user added themselves
  const r = await w.svc.undo();
  assert.equal(r.removed.length, 1);
  assert.deepEqual(w.store.get('PLgym0000001').map(x => x.setVideoId), ['seed0001', 'mine0001']);
  const w2 = world();
  await w2.svc.addSongs('gym', [SONGS.lose]);
  w2.store.get('PLgym0000001').splice(1, 1);   // removed by hand in YouTube Music
  const gone = await w2.svc.undo();
  assert.equal(gone.status, 'gone');
  assert.equal(edits(w2).length, 1);   // no remove was sent
});

test('undo journal survives a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-undo-'));
  const journal = () => createJournalStore({ cortex: cortexOn(dir) });
  const w = world();
  await w.svcFor({ journal: journal() }).addSongs('gym', [SONGS.lose]);
  assert.equal(journal().load().length, 1);
  const after = w.svcFor({ journal: journal() });
  assert.equal((await after.undo()).status, 'ok');
  assert.equal(w.store.get('PLgym0000001').length, 1);
  assert.equal((await w.svcFor({ journal: journal() }).undo()).status, 'nothing');
});

// ---- the model tool ----
const tool = (o, opts) => { const w = world(o); return { w, t: createYtEditTool({ playlists: w.svcFor(opts) }) }; };

test('ytm_playlist_edit: says Added only when it was verified, and how to undo', async () => {
  const { t } = tool();
  assert.equal(await t.run({ op: 'add', playlist: 'gym', songs: ['stronger by kanye west'] }), 'Added "Stronger" by Kanye West to Gym (verified). The user can say "undo" to take it back.');
  assert.match(await t.run({ op: 'add_current', playlist: 'gym' }), /^Added "Lose Yourself" by Eminem to Gym \(verified\)/);
  assert.match(await t.run({ op: 'undo' }), /^Undone: removed "Lose Yourself" by Eminem from Gym \(verified\)/);
  const lag = tool({ lag: 99 });
  assert.match(await lag.t.run({ op: 'add', playlist: 'gym', songs: ['lose yourself'] }), /has not shown the change yet\. Do not say it is done/);
});

test('ytm_playlist_edit: problems come back as the thing to tell or ask the user', async () => {
  const { t } = tool();
  assert.match(await t.run({ op: 'add', playlist: 'gym', songs: ['till i collapse'] }), /^Nothing added: "Till I Collapse" by Eminem already in Gym/);
  await assert.rejects(t.run({ op: 'add', playlist: 'mix tape', songs: ['lose yourself'] }), /ask the user which: Mix Tape/);
  await assert.rejects(t.run({ op: 'add', playlist: 'workout', songs: ['lose yourself'] }), /No playlist called "workout"/);
  await assert.rejects(t.run({ op: 'add', playlist: 'road trip', songs: ['lose yourself'] }), /cannot be changed/);
  await assert.rejects(t.run({ op: 'add', playlist: 'gym', songs: ['stronger'] }), /More than one song matches "stronger": ask the user which: "Stronger" by Kanye West; "Stronger" by Britney Spears/);
  await assert.rejects(t.run({ op: 'add', playlist: 'gym', songs: ['bohemian rhapsody'] }), /couldn't find bohemian rhapsody/);
  await assert.rejects(t.run({ op: 'add', songs: ['x'] }), /playlist is required/);
  await assert.rejects(t.run({ op: 'add', playlist: 'gym' }), /songs is required/);
  await assert.rejects(t.run({ op: 'delete', playlist: 'gym' }), /op must be/);
  await assert.rejects(tool({ playing: null }).t.run({ op: 'add_current', playlist: 'gym' }), /Nothing is playing/);
  assert.equal(await t.run({ op: 'undo' }), 'There is nothing to undo.');
});

// ---- spoken phrases ----
test('intent: add / undo phrases', () => {
  assert.deepEqual(parse('add this to gym'), { kind: 'library-add', current: true, name: 'gym', explicit: false });
  assert.deepEqual(parse('add this song to my gym playlist'), { kind: 'library-add', current: true, name: 'gym', explicit: true });
  assert.deepEqual(parse('Jarvis, save this to my chill playlist please'), { kind: 'library-add', current: true, name: 'chill', explicit: true });
  assert.deepEqual(parse('add this song'), { kind: 'library-add', current: true, name: null, explicit: true });
  assert.deepEqual(parse('add stronger by kanye west to my gym playlist'), { kind: 'library-add', songs: ['stronger by kanye west'], name: 'gym', explicit: true });
  assert.equal(parse('add lose yourself to my gym').explicit, false);
  assert.equal(parse('undo').kind, 'library-undo');
  assert.equal(parse('undo that').kind, 'library-undo');
  assert.equal(parse('take that back').kind, 'library-undo');
  // existing queue phrases are untouched
  assert.deepEqual([parse('add take on me to the queue').kind, parse('add take on me to the queue').mode], ['find', 'end']);
  assert.equal(parse('add this to the queue'), null);
  assert.equal(parse('play my gym playlist').kind, 'library');
});

function skillWith(opts = {}) {
  const w = world(opts);
  const ytmLike = { connected: true, play: async () => ({ ok: true, item: { title: 'x' }, started: true }) };
  let t = 0;
  const svc = w.svcFor();
  return { w, skill: createMediaSkill({ service: {}, ytm: ytmLike, ytPlaylists: svc, now: () => (t += 1000) }) };
}

test('skill: "add this to gym" adds the playing song and says so (voice short, text with undo)', async () => {
  const { w, skill } = skillWith();
  const text = await skill.handle('add this to gym');
  assert.equal(text.reply, 'Added “Lose Yourself” by Eminem to Gym. Say undo to take it back.');
  assert.equal(text.record, 'Added “Lose Yourself” by Eminem to Gym.');
  assert.equal(w.store.get('PLgym0000001').length, 2);
  const voice = await skillWith().skill.handle('add this to my gym playlist', { source: 'voice' });
  assert.equal(voice.reply, 'Added Lose Yourself by Eminem to Gym.');
});

test('skill: "add this song" asks which playlist, and the next thing said is the playlist', async () => {
  const { w, skill } = skillWith();
  const ask = await skill.handle('add this song');
  assert.equal(ask.reply, 'Which playlist?');
  assert.equal(edits(w).length, 0);
  const done = await skill.handle('my gym playlist');
  assert.match(done.reply, /^Added “Lose Yourself” by Eminem to Gym\./);
  // a different request in between drops the question
  const again = skillWith();
  await again.skill.handle('add this song');
  assert.equal(await again.skill.handle('what time is it'), null);
  assert.equal(edits(again.w).length, 0);
});

test('skill: "add X to my gym playlist"; an unclear song is asked about and the answer adds it', async () => {
  const { w, skill } = skillWith();
  const ok = await skill.handle('add stronger by kanye west to my gym playlist');
  assert.match(ok.reply, /^Added “Stronger” by Kanye West to Gym\./);
  const ask = await skill.handle('add stronger to my gym playlist');
  assert.equal(ask.reply, 'Which one: “Stronger” by Kanye West, or “Stronger” by Britney Spears?');
  const done = await skill.handle('the second one');
  assert.match(done.reply, /^Added “Stronger” by Britney Spears to Gym\./);
  assert.equal(w.store.get('PLgym0000001').map(x => x.videoId).includes('strongbrit01'), true);
});

test('skill: duplicates, unclear playlists, read-only playlists, nothing playing', async () => {
  const { skill } = skillWith();
  assert.equal((await skill.handle('add till i collapse to my gym playlist')).reply, '“Till I Collapse” by Eminem is already in Gym.');
  const ask = await skill.handle('add this to my mix tape playlist');
  assert.equal(ask.reply, 'Which playlist: Mix Tape or Mix Tape?');
  assert.match((await skill.handle('the first one')).reply, /^Added “Lose Yourself”/);
  assert.match((await skill.handle('add this to my road trip playlist')).reply, /can't be changed/);
  assert.equal((await skillWith({ playing: null }).skill.handle('add this to gym')).reply, 'Nothing is playing in YouTube Music.');
});

test('skill: a name that matches nothing: "playlist" makes it an answer, otherwise another request', async () => {
  const { skill } = skillWith();
  const said = await skill.handle('add this to my workout playlist');
  assert.equal(said.ok, false);
  assert.match(said.reply, /^I couldn't find a playlist called workout\./);
  assert.equal(await skill.handle('add 5 to my total'), null);
  assert.equal(await skill.handle('add this to workout'), null);   // loose: the model gets it and can explain
});

test('skill: undo, then nothing left to undo', async () => {
  const { w, skill } = skillWith();
  await skill.handle('add this to gym');
  const u = await skill.handle('undo');
  assert.equal(u.reply, 'Undone: removed “Lose Yourself” by Eminem from Gym.');
  assert.equal(w.store.get('PLgym0000001').length, 1);
  assert.equal((await skill.handle('undo that')).reply, "There's nothing to undo.");
});

test('skill: signed-out and offline are said plainly', async () => {
  const w = world();
  const svc = w.svcFor();
  w.link.request = async () => { throw new Error('AUTH: Sign in'); };
  const skill = createMediaSkill({ service: {}, ytm: { connected: true }, ytPlaylists: svc });
  const r = await skill.handle('add this to my gym playlist');
  assert.equal(r.ok, false);
  assert.match(r.reply, /Sign in to YouTube Music/);
  const off = createMediaSkill({ service: {}, ytm: { connected: false }, ytPlaylists: svc });
  assert.match((await off.handle('add this to my gym playlist')).reply, /isn't connected/);
  assert.equal(await off.handle('add 5 to my total'), null);
});

// ---- finding one real song ----
const cand = (type, title, artists, extra = {}) => ({ top: false, type, title, artists, album: '', duration: '', videoId: ['song', 'video'].includes(type) ? (title + artists.join('')).replace(/\W/g, '').slice(0, 11).padEnd(11, 'x') : null, play: { watchEndpoint: { videoId: 'v' } }, queue: {}, ...extra });
const search = candidates => createYtMusic({ link: { connected: true, request: async () => ({ candidates }) } });

test('findSong: only real songs, the audio and its video are one song, a clear winner needs no question', async () => {
  const r = await search([cand('album', 'Stronger', ['Kanye West']), cand('video', 'Stronger', ['Kanye West'], { top: true }), cand('song', 'Stronger', ['Kanye West']), cand('song', 'Stronger', ['Britney Spears'])]).findSong('stronger by kanye west');
  assert.equal(r.item.type, 'song');
  assert.deepEqual(r.item.artists, ['Kanye West']);
  assert.equal(r.sure, true);
  assert.deepEqual(r.alts.map(a => a.artists[0]), ['Britney Spears']);
});

test('findSong: two songs with one title are a question; nothing close or only albums is not found', async () => {
  const two = await search([cand('song', 'Stronger', ['Kanye West']), cand('song', 'Stronger', ['Britney Spears'])]).findSong('stronger');
  assert.equal(two.sure, false);
  assert.equal(two.alts.length, 1);
  const albums = await search([cand('album', 'Stronger', ['Kanye West']), cand('playlist', 'Stronger Mix', []), cand('artist', 'Stronger', [])]).findSong('stronger');
  assert.equal(albums.notFound, true);
  assert.equal((await search([cand('song', 'Something Else Entirely', ['Nobody'])]).findSong('bohemian rhapsody by queen')).notFound, true);
  assert.match((await search([]).findSong('')).error, /Which song/);
});

test('brain and router: the edit tool exists with the service, and add phrases get tools', () => {
  const w = world();
  assert.equal(defaultTools({ ytPlaylists: w.svc }).some(t => t.name === 'ytm_playlist_edit'), true);
  assert.equal(defaultTools({}).some(t => t.name === 'ytm_playlist_edit'), false);
  for (const text of ['add this to gym', 'undo that', 'save this song', 'add stronger to my gym playlist']) assert.equal(route(text, { source: 'voice' }).tools, true, text);
});
