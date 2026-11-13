const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createYtPlaylists, cleanName } = require('../src/core/media/ytplaylists');
const { createYtLibraryTool } = require('../src/core/tools/ytplaylists');
const { matchText } = require('../src/core/media/rank');
const { DEFAULTS, loadConfig, saveConfig } = require('../src/core/config');
const { applyPatch } = require('../src/core/settings');
const { defaultTools } = require('../src/core/brain');
const { systemPrompt } = require('../src/core/brain/prompt');

// ---- responses shaped like the real InnerTube answers seen in Phase 0 ----
const run = t => ({ runs: [{ text: t }] });
const editMenu = { menuRenderer: { items: [{ menuNavigationItemRenderer: { navigationEndpoint: { playlistEditorEndpoint: {} } } }, { menuServiceItemRenderer: { serviceEndpoint: { confirmDialogEndpoint: {} } } }] } };
const savedMenu = { menuRenderer: { items: [{ menuNavigationItemRenderer: { navigationEndpoint: { addToPlaylistEndpoint: {} } } }] } };
const card = (id, title, subtitle, menu) => ({ musicTwoRowItemRenderer: { title: run(title), subtitle: { runs: subtitle.map(text => ({ text })) }, navigationEndpoint: { browseEndpoint: { browseId: id ? 'VL' + id : undefined } }, menu } });
const LIBRARY = { contents: { grid: { items: [
  card(null, 'New playlist', []),
  card('LM', 'Liked Music', ['Auto playlist']),
  card('PLgym0000001', 'Gym', ['Me', ' • ', '42 songs'], editMenu),
  card('PLgym0000002', 'Gym Cardio', ['Me', ' • ', '12 songs'], editMenu),
  card('PLchill00001', 'Chill', ['Me', ' • ', '1,118 songs'], editMenu),
  card('PLsaved00001', 'Road Trip 2019', ['Somebody Else', ' • ', '30 songs'], savedMenu),
  card('RDAMPLPLgym0000001', 'Gym Mix', ['Mix']),
  card('PLgym0000001', 'Gym', ['Me', ' • ', '42 songs'], editMenu),   // duplicate card: shown once
] } } };

const row = (videoId, setVideoId, title, artist, dur, extra = {}) => ({ musicResponsiveListItemRenderer: { playlistItemData: { videoId, playlistSetVideoId: setVideoId }, flexColumns: [
  { musicResponsiveListItemFlexColumnRenderer: { text: run(title) } },
  { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: artist }] } } },
  { musicResponsiveListItemFlexColumnRenderer: { text: run('Some Album') } },
], fixedColumns: [{ musicResponsiveListItemFixedColumnRenderer: { text: run(dur) } }], ...extra } });
const cont = token => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } });
const page1 = { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ musicEditablePlaylistDetailHeaderRenderer: { header: { musicResponsiveHeaderRenderer: { title: run('Gym') } } } }], secondaryContents: { musicPlaylistShelfRenderer: { contents: [
  row('v1', 's1', 'Lose Yourself', 'Eminem', '4:46'),
  row('v2', 's2', 'Stronger', 'Kanye West', '5:11', { musicItemRendererDisplayPolicy: 'MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT' }),
  cont('TOKEN2'),
] } } } } };
const page2 = { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [row('v3', 's3', 'Till I Collapse', 'Eminem', '4:57'), row('v2', 's2', 'Stronger', 'Kanye West', '5:11')] } }] };

// ---- run the extension's page function against a fake YouTube Music page ----
async function pageRun(cmd, args, { fetchImpl, loggedIn = true, cookie = 'SAPISID=abc123; other=1' } = {}) {
  const { ytm } = await import('../extension/page.js');
  const saved = { document: globalThis.document, window: globalThis.window, location: globalThis.location, fetch: globalThis.fetch };
  const cfg = { LOGGED_IN: loggedIn, INNERTUBE_CONTEXT: { client: {} }, SESSION_INDEX: '0' };
  globalThis.document = { cookie, querySelector: sel => (sel === 'ytmusic-app' ? {} : null) };
  globalThis.window = { ytcfg: { get: k => cfg[k] } };
  Object.defineProperty(globalThis, 'location', { value: { origin: 'https://music.youtube.com', href: 'https://music.youtube.com/' }, configurable: true, writable: true });
  globalThis.fetch = fetchImpl;
  try { return await ytm(cmd, args); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); }
  }
}
const respond = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });

test('page playlists: parses the library, skips non-playlists and mixes, flags editable', async () => {
  const seen = [];
  const r = await pageRun('playlists', {}, { fetchImpl: async (url, init) => { seen.push({ url, init }); return respond(LIBRARY); } });
  assert.equal(r.ok, true);
  const ps = r.result.playlists;
  assert.deepEqual(ps.map(p => p.id), ['LM', 'PLgym0000001', 'PLgym0000002', 'PLchill00001', 'PLsaved00001']);
  assert.deepEqual(ps.map(p => p.kind), ['liked', 'user', 'user', 'user', 'saved']);
  assert.equal(ps[4].editable, false);
  assert.equal(ps[1].editable, true);
  assert.equal(ps[1].trackCount, 42);
  assert.equal(ps[3].trackCount, 1118);   // thousands separator
  assert.match(seen[0].url, /\/youtubei\/v1\/browse/);
  assert.equal(JSON.parse(seen[0].init.body).browseId, 'FEmusic_liked_playlists');
});

test('page: personal reads carry the signed header', async () => {
  let headers;
  await pageRun('playlists', {}, { fetchImpl: async (_u, init) => { headers = init.headers; return respond(LIBRARY); } });
  assert.match(headers.Authorization, /^SAPISIDHASH \d+_[0-9a-f]{40}$/);
  assert.equal(headers['X-Goog-AuthUser'], '0');
  assert.equal(headers['X-Origin'], 'https://music.youtube.com');
});

test('page: signed out → AUTH error, and no request is sent', async () => {
  let sent = 0;
  const r = await pageRun('playlists', {}, { loggedIn: false, fetchImpl: async () => { sent++; return respond({}); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /^AUTH:/);
  assert.equal(sent, 0);
});

test('page: HTTP 401 → AUTH, 429 → RATE', async () => {
  assert.match((await pageRun('playlists', {}, { fetchImpl: async () => respond({}, 401) })).error, /^AUTH:/);
  assert.match((await pageRun('playlists', {}, { fetchImpl: async () => respond({}, 429) })).error, /^RATE:/);
});

test('page playlist: follows continuations, drops repeated rows, parses songs', async () => {
  const bodies = [];
  const r = await pageRun('playlist', { id: 'PLgym0000001' }, { fetchImpl: async (_u, init) => { const b = JSON.parse(init.body); bodies.push(b); return respond(b.continuation ? page2 : page1); } });
  assert.equal(r.ok, true);
  const p = r.result;
  assert.equal(bodies[0].browseId, 'VLPLgym0000001');
  assert.equal(bodies[1].continuation, 'TOKEN2');
  assert.equal(p.title, 'Gym');
  assert.equal(p.editable, true);
  assert.deepEqual(p.tracks.map(t => t.videoId), ['v1', 'v2', 'v3']);   // v2 came twice
  assert.deepEqual(p.tracks[0], { videoId: 'v1', setVideoId: 's1', title: 'Lose Yourself', artists: ['Eminem'], album: 'Some Album', durationSec: 286, available: true });
  assert.equal(p.tracks[1].available, false);
  assert.equal(p.truncated, false);
});

test('page playlist: limit stops paging and says it was cut; bad ids are refused', async () => {
  let calls = 0;
  const r = await pageRun('playlist', { id: 'PLx0000000', limit: 2 }, { fetchImpl: async () => { calls++; return respond(page1); } });
  assert.equal(r.result.truncated, true);
  assert.equal(calls, 1);
  assert.match((await pageRun('playlist', { id: 'a b/../c' }, { fetchImpl: async () => respond({}) })).error, /Bad playlist id/);
});

// ---- the service ----
const LIST = [
  { id: 'LM', title: 'Liked Music', kind: 'liked', editable: false, trackCount: 300 },
  { id: 'PLgym0000001', title: 'Gym', kind: 'user', editable: true, trackCount: 42 },
  { id: 'PLgym0000002', title: 'Gym Cardio', kind: 'user', editable: true, trackCount: 12 },
  { id: 'PLchill00001', title: 'Chill', kind: 'user', editable: true, trackCount: 118 },
  { id: 'PLsaved00001', title: 'Road Trip 2019', kind: 'saved', editable: false, trackCount: 30 },
  { id: 'PLmix000001', title: 'Mix Tape', kind: 'user', editable: true, trackCount: 5 },
  { id: 'PLmix000002', title: 'Mix Tape', kind: 'user', editable: true, trackCount: 9 },
];
const TRACKS = [{ videoId: 'v1', setVideoId: 's1', title: 'Lose Yourself', artists: ['Eminem'], durationSec: 286, available: true }, { videoId: 'v2', setVideoId: 's2', title: 'Stronger', artists: ['Kanye West'], durationSec: 311, available: true }];

function fakeLink(handlers = {}, { version = '1.1.0', connected = true } = {}) {
  const calls = [];
  return {
    calls, connected, info: { version },
    request: async (cmd, args, opts) => { calls.push({ cmd, args, opts }); const h = handlers[cmd] || (() => { throw new Error('unexpected ' + cmd); }); return h(args, calls.filter(c => c.cmd === cmd).length); },
  };
}
const happy = () => ({ playlists: () => ({ playlists: LIST }), playlist: args => ({ id: args.id, title: LIST.find(p => p.id === args.id)?.title, editable: true, truncated: false, tracks: TRACKS }), status: () => ({ url: 'x' }) });
function make(handlers = happy(), opts = {}) {
  let t = 1_000_000;
  const link = fakeLink(handlers, opts.link);
  const svc = createYtPlaylists({ link, getConfig: () => opts.config || {}, now: () => t, sleep: async ms => { t += ms; }, file: opts.file });
  return { svc, link, tick: ms => { t += ms; } };
}

test('cleanName: drops "my" and "playlist"', () => {
  assert.equal(cleanName('my Gym playlist'), 'gym');
  assert.equal(cleanName('the chill list'), 'chill');
  assert.equal(cleanName('Gym'), 'gym');
});

test('matchText: exact beats partial beats unrelated', () => {
  assert.equal(matchText('gym', 'Gym'), 1);
  assert.ok(matchText('gym', 'Gym Cardio') >= 0.85);
  assert.ok(matchText('cardio gym', 'Gym Cardio') > 0.8);
  assert.ok(matchText('gym', 'Chill') < 0.2);
});

test('resolve: exact title, spoken form, id, alias', async () => {
  const { svc } = make(happy(), { config: { music: { aliases: [{ alias: 'workout', playlistId: 'PLgym0000002' }] } } });
  assert.equal((await svc.resolve('Chill')).playlist.id, 'PLchill00001');
  assert.equal((await svc.resolve('my chill playlist')).playlist.id, 'PLchill00001');
  assert.equal((await svc.resolve('PLchill00001')).playlist.id, 'PLchill00001');
  assert.equal((await svc.resolve('my workout playlist')).playlist.id, 'PLgym0000002');
  assert.equal((await svc.resolve('road trip')).playlist.id, 'PLsaved00001');
});

test('resolve: exact title wins over a longer name that contains it', async () => {
  const { svc } = make();
  assert.equal((await svc.resolve('gym')).playlist.id, 'PLgym0000001');
  assert.equal((await svc.resolve('gym cardio')).playlist.id, 'PLgym0000002');
});

test('resolve: two playlists with the same name → ambiguous with both', async () => {
  const { svc } = make();
  const r = await svc.resolve('mix tape');
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(r.candidates.map(p => p.id).sort(), ['PLmix000001', 'PLmix000002']);
});

test('resolve: nothing close → notFound with suggestions only when something is near', async () => {
  const { svc } = make();
  const r = await svc.resolve('workout');
  assert.equal(r.status, 'notFound');
  const near = await svc.resolve('road');
  assert.equal(near.playlist.id, 'PLsaved00001');
  assert.equal((await svc.resolve('')).status, 'notFound');
});

test('resolve: editableOnly skips playlists the user cannot change', async () => {
  const { svc } = make();
  assert.equal((await svc.resolve('road trip', { editableOnly: true })).status, 'notFound');
  assert.equal((await svc.resolve('liked music', { editableOnly: true })).status, 'notFound');
});

test('library: cached within the TTL, refetched after it or on refresh', async () => {
  const { svc, link, tick } = make();
  await svc.library(); await svc.library();
  assert.equal(link.calls.filter(c => c.cmd === 'playlists').length, 1);
  tick(299_000); await svc.library();
  assert.equal(link.calls.filter(c => c.cmd === 'playlists').length, 1);
  tick(2_000); await svc.library();
  assert.equal(link.calls.filter(c => c.cmd === 'playlists').length, 2);
  await svc.library({ refresh: true });
  assert.equal(link.calls.filter(c => c.cmd === 'playlists').length, 3);
});

test('library: TTL comes from config', async () => {
  const { svc, link, tick } = make(happy(), { config: { music: { libraryTtlSec: 10 } } });
  await svc.library(); tick(11_000); await svc.library();
  assert.equal(link.calls.filter(c => c.cmd === 'playlists').length, 2);
});

test('playlist: tracks cached per playlist, invalidate forces a re-read', async () => {
  const { svc, link } = make();
  const a = await svc.open('gym'); const b = await svc.open('gym');
  assert.equal(a.status, 'ok');
  assert.equal(a.tracks.length, 2);
  assert.equal(b.cached, true);
  assert.equal(link.calls.filter(c => c.cmd === 'playlist').length, 1);
  svc.invalidate('PLgym0000001');
  await svc.open('gym');
  assert.equal(link.calls.filter(c => c.cmd === 'playlist').length, 2);
});

test('open: asks for no tracks while the name is ambiguous', async () => {
  const { svc, link } = make();
  const r = await svc.open('mix tape');
  assert.equal(r.status, 'ambiguous');
  assert.equal(link.calls.filter(c => c.cmd === 'playlist').length, 0);
});

test('errors: signed out is reported, never served from the old cache', async () => {
  let signedOut = false;
  const { svc, tick } = make({ playlists: () => { if (signedOut) throw new Error('AUTH: Sign in'); return { playlists: LIST }; } });
  await svc.library();
  signedOut = true; tick(400_000);
  await assert.rejects(svc.library(), err => err.code === 'AUTH' && /Sign in to YouTube Music/.test(err.message));
});

test('errors: other failures fall back to the last known list, marked stale', async () => {
  let down = false;
  const { svc, tick } = make({ playlists: () => { if (down) throw new Error('YouTube Music did not answer in time'); return { playlists: LIST }; } });
  await svc.library();
  down = true; tick(400_000);
  const r = await svc.library();
  assert.equal(r.stale, true);
  assert.equal(r.playlists.length, LIST.length);
});

test('errors: rate limit is retried with backoff, then surfaces', async () => {
  let n = 0;
  const ok = make({ playlists: () => { if (++n < 3) throw new Error('RATE: slow down'); return { playlists: LIST }; } });
  assert.equal((await ok.svc.library()).playlists.length, LIST.length);
  assert.equal(n, 3);
  const bad = make({ playlists: () => { throw new Error('RATE: slow down'); } });
  await assert.rejects(bad.svc.library(), err => err.code === 'RATE');
  assert.equal(bad.link.calls.length, 3);   // first try + 2 retries
});

test('errors: extension offline, too old, or no tab', async () => {
  await assert.rejects(make(happy(), { link: { connected: false } }).svc.library(), err => err.code === 'NO_LINK');
  await assert.rejects(make(happy(), { link: { version: '1.0.0' } }).svc.library(), err => err.code === 'OLD' && /reload/i.test(err.message));
  await assert.rejects(make({ playlists: () => ({ noTab: true }) }).svc.library(), err => err.code === 'NO_TAB' && /reload it/.test(err.message));
  // an extension that predates the command reports its version as current but answers "Unknown command"
  await assert.rejects(make({ playlists: () => { throw new Error('Unknown command playlists'); } }).svc.library(), err => err.code === 'OLD' && /reload/.test(err.message));
});

test('calls to the extension run one at a time', async () => {
  let active = 0, peak = 0;
  const slow = async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return { playlists: LIST }; };
  const { svc } = make({ playlists: slow, playlist: async a => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return { id: a.id, tracks: [] }; } });
  await Promise.all([svc.library({ refresh: true }), svc.library({ refresh: true }), svc.open('gym')]);
  assert.equal(peak, 1);
});

test('digest: built from the cache, never fetches, skips auto playlists, marks saved ones', async () => {
  const { svc, link } = make(happy(), { config: { music: { digestSize: 3 } } });
  assert.equal(svc.digest(), '');
  assert.equal(link.calls.length, 0);
  await svc.library();
  const d = svc.digest();
  assert.match(d, /Liked Music \(300\), Gym \(42\), Gym Cardio \(12\), and 4 more\./);
  const all = make(happy());
  await all.svc.library();
  assert.match(all.svc.digest(), /Road Trip 2019 \(30\) \[saved\]/);
});

test('library hint on disk: used for the digest before the extension answers, refetched before use', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-ytp-')), 'cache', 'lib.json');
  const first = make(happy(), { file });
  await first.svc.library();
  assert.ok(fs.existsSync(file));
  const second = make(happy(), { file });
  assert.match(second.svc.digest(), /\(last known\): .*Gym \(42\)/);
  await second.svc.library();
  assert.equal(second.link.calls.filter(c => c.cmd === 'playlists').length, 1);
  assert.doesNotMatch(second.svc.digest(), /last known/);
});

test('onLink: refreshes only when a YouTube Music tab already exists', async () => {
  const noTab = make({ status: () => ({ noTab: true }), playlists: () => ({ playlists: LIST }) });
  noTab.svc.onLink(true);
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(noTab.link.calls.some(c => c.cmd === 'playlists'), false);
  const tab = make(happy());
  tab.svc.onLink(true);
  for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
  assert.equal(tab.link.calls.some(c => c.cmd === 'playlists'), true);
  tab.svc.onLink(false);
});

// ---- the model tool ----
const tool = (handlers, opts) => { const m = make(handlers, opts); return { ...m, t: createYtLibraryTool({ playlists: m.svc }) }; };

test('ytm_library: lists playlists with counts, hides auto mixes, marks saved ones', async () => {
  const { t } = tool(happy());
  const out = await t.run({});
  assert.match(out, /^7 playlists: /);
  assert.match(out, /Gym \(42 tracks\)/);
  assert.match(out, /Road Trip 2019 \(30 tracks\), saved from someone else/);
});

test('ytm_library: shows a playlist, pages and filters', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ videoId: 'v' + i, setVideoId: 's' + i, title: 'Song ' + i, artists: ['Artist ' + (i % 3)], durationSec: 200 + i, available: true }));
  const { t } = tool({ ...happy(), playlist: a => ({ id: a.id, title: 'Gym', editable: true, truncated: false, tracks: many }) });
  const first = await t.run({ playlist: 'my gym playlist' });
  assert.match(first, /^Gym \(60 tracks\) \[playlist PLgym0000001\]\n1\. Song 0 - Artist 0 \(3:20\)/);
  assert.match(first, /\n25\. Song 24/);
  assert.doesNotMatch(first, /\n26\. /);
  assert.match(first, /Showing 1-25 of 60; ask for more with offset 25\./);
  const next = await t.run({ playlist: 'gym', offset: 25, limit: 2 });
  assert.match(next, /\n26\. Song 25[^\n]*\n27\. Song 26[^\n]*\n?Showing 26-27 of 60/);
  const filtered = await t.run({ playlist: 'gym', query: 'artist 2', limit: 2 });
  assert.match(filtered, /\n3\. Song 2 /);
  assert.match(filtered, /of 20;/);
});

test('ytm_library: ambiguous and missing playlists come back as the question to ask', async () => {
  const { t } = tool(happy());
  await assert.rejects(t.run({ playlist: 'mix tape' }), /More than one playlist matches "mix tape": ask the user which: Mix Tape \(5 tracks\); Mix Tape \(9 tracks\)/);
  await assert.rejects(t.run({ playlist: 'workout' }), /No playlist called "workout"\./);
  await assert.rejects(t.run({ view: 'playlist' }), /playlist is required/);
});

test('ytm_library: read-only and unavailable songs are labelled; offline is an error', async () => {
  const { t } = tool({ ...happy(), playlist: a => ({ id: a.id, title: 'Road Trip 2019', editable: false, tracks: [{ title: 'Gone', artists: [], available: false }] }) });
  const out = await t.run({ playlist: 'road trip' });
  assert.match(out, /read-only/);
  assert.match(out, /1\. Gone \[unavailable\]/);
  const off = tool(happy(), { link: { connected: false } });
  await assert.rejects(off.t.run({}), /extension is not connected/);
});

// ---- config, settings, brain wiring ----
test('config: music defaults, and a bad block falls back per key', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-cfg-'));
  assert.deepEqual(loadConfig(d).music, DEFAULTS.music);
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ music: { libraryTtlSec: 'x', digestSize: 5, aliases: [{ alias: ' gym ', playlistId: 'PLabc1234567' }, { alias: 'bad', playlistId: '../x' }, 7] } }));
  const c = loadConfig(d).music;
  assert.equal(c.libraryTtlSec, 300);
  assert.equal(c.digestSize, 5);
  assert.deepEqual(c.aliases, [{ alias: 'gym', playlistId: 'PLabc1234567' }]);
  saveConfig(d, { ...loadConfig(d) });
  assert.deepEqual(loadConfig(d).music, c);
});

test('settings: music patch validates shortcuts and clamps numbers', () => {
  const ctx = { providers: { get: () => null }, engines: {} };
  const ok = applyPatch(DEFAULTS, { music: { aliases: [{ alias: 'gym', playlistId: 'PLabc1234567' }], digestSize: 500, playlistTtlSec: 1 } }, ctx);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.config.music.aliases, [{ alias: 'gym', playlistId: 'PLabc1234567' }]);
  assert.equal(ok.config.music.digestSize, 100);
  assert.equal(ok.config.music.playlistTtlSec, 5);
  assert.deepEqual(DEFAULTS.music.aliases, []);   // the defaults were not touched
  const bad = applyPatch(DEFAULTS, { music: { aliases: [{ alias: '', playlistId: 'PLabc1234567' }], libraryTtlSec: 'abc' } }, ctx);
  assert.equal(bad.errors.length, 2);
  assert.deepEqual(bad.config.music.aliases, []);
});

test('brain: ytm_library exists only with the playlist service, and the prompt carries the digest', async () => {
  const names = tools => tools.map(t => t.name);
  assert.equal(names(defaultTools({})).includes('ytm_library'), false);
  const { svc } = make();
  await svc.library();
  const withSvc = defaultTools({ ytPlaylists: svc });
  assert.equal(names(withSvc).includes('ytm_library'), true);
  const p = systemPrompt({ tools: withSvc.filter(t => t.name === 'ytm_library'), library: svc.digest() });
  assert.match(p, /ytm_library: the user's OWN playlists/);
  assert.match(p, /YouTube Music playlists: .*Gym \(42\)/);
  assert.doesNotMatch(systemPrompt({ tools: [], library: svc.digest() }), /Gym \(42\)/);
});

// ---- Phase 2: playing playlists ----
const { parse } = require('../src/core/media/intent');
const { createMediaSkill } = require('../src/core/media/skill');
const { createYtPlayLibraryTool } = require('../src/core/tools/ytplaylists');

const T2 = [
  { videoId: 'gone1', setVideoId: 'g1', title: 'Removed Song', artists: ['Nobody'], durationSec: 100, available: false },
  { videoId: 'v1', setVideoId: 's1', title: 'Lose Yourself', artists: ['Eminem'], durationSec: 286, available: true },
  { videoId: 'v2', setVideoId: 's2', title: 'Stronger', artists: ['Kanye West'], durationSec: 311, available: true },
  { videoId: 'v3', setVideoId: 's3', title: 'Stronger', artists: ['Britney Spears'], durationSec: 200, available: true },
  { videoId: 'v4', setVideoId: 's4', title: 'Till I Collapse', artists: ['Eminem'], durationSec: 297, available: true },
];
function playHandlers(over = {}) {
  return { ...happy(), playlist: a => ({ id: a.id, title: 'x', editable: true, tracks: T2 }),
    play: args => ({ playing: { videoId: args.videoId, title: 't' }, started: true }), shuffle: () => ({ shuffled: true }), ...over };
}

test('intent: playlist phrases go to the library, everything else is unchanged', () => {
  const lib = t => parse(t);
  assert.deepEqual(lib('play my gym playlist'), { kind: 'library', mode: 'play', name: 'gym', shuffle: false, explicit: true, query: 'gym playlist' });
  assert.equal(lib('play the chill playlist').explicit, false);
  assert.equal(lib('Jarvis, play my gym playlist please').name, 'gym');
  assert.deepEqual([lib('shuffle my gym playlist').shuffle, lib('shuffle my gym playlist').name], [true, 'gym']);
  assert.equal(lib('play my gym playlist on shuffle').shuffle, true);
  assert.deepEqual(lib('play stronger from my gym playlist'), { kind: 'library', mode: 'play', name: 'gym', track: 'stronger', explicit: true });
  assert.equal(lib('play my liked songs').name, 'liked songs');
  // not library phrases
  assert.equal(lib('shuffle the playlist').kind, 'control');
  assert.equal(lib('shuffle').kind, 'control');
  assert.equal(lib('play the playlist').kind, 'find');
  assert.equal(lib('play bohemian rhapsody by queen').kind, 'find');
  assert.deepEqual([lib('play mr brightside next').kind, lib('play mr brightside next').mode], ['find', 'next']);
  assert.equal(lib('play some lofi').kind, 'find');
  assert.notEqual(lib('play my music')?.kind, 'library');
});

test('cleanName: liked songs means the Liked Music playlist', async () => {
  assert.equal(cleanName('my liked songs'), 'liked music');
  const { svc } = make();
  assert.equal((await svc.resolve('my liked songs')).playlist.id, 'LM');
});

test('play: starts the first playable song of the playlist and checks the right one loaded', async () => {
  const { svc, link } = make(playHandlers());
  const r = await svc.play('gym');
  assert.equal(r.status, 'ok');
  assert.equal(r.started, true);
  assert.equal(r.track.videoId, 'v1');   // the unavailable first row is skipped
  const c = link.calls.find(x => x.cmd === 'play');
  assert.deepEqual(c.args, { play: { watchEndpoint: { videoId: 'v1', playlistId: 'PLgym0000001', index: 1 } }, videoId: 'v1' });
});

test('play: shuffle shuffles after it started; a song is never shuffled away', async () => {
  const a = make(playHandlers());
  const r = await a.svc.play('gym', { shuffle: true });
  assert.equal(r.shuffled, true);
  assert.ok(a.link.calls.some(x => x.cmd === 'shuffle'));
  const b = make(playHandlers());
  await b.svc.play('gym', { shuffle: true, track: 'lose yourself' });
  assert.equal(b.link.calls.some(x => x.cmd === 'shuffle'), false);
});

test('play: a song by name, with the artist to tell versions apart', async () => {
  const { svc, link } = make(playHandlers());
  const r = await svc.play('gym', { track: 'lose yourself' });
  assert.equal(r.track.videoId, 'v1');
  const kanye = await svc.play('gym', { track: 'stronger by kanye west' });
  assert.equal(kanye.track.videoId, 'v2');
  assert.equal(link.calls.filter(x => x.cmd === 'play').at(-1).args.play.watchEndpoint.index, 2);
  const dup = await svc.play('gym', { track: 'stronger' });
  assert.equal(dup.status, 'ambiguousTrack');
  assert.deepEqual(dup.candidates.map(t => t.videoId).sort(), ['v2', 'v3']);
  const none = await svc.play('gym', { track: 'bohemian rhapsody' });
  assert.equal(none.status, 'noTrack');
});

test('play: unavailable songs are never started; empty and unknown playlists say so', async () => {
  const gone = make(playHandlers({ playlist: a => ({ id: a.id, tracks: [T2[0]] }) }));
  assert.equal((await gone.svc.play('gym')).status, 'empty');
  assert.equal((await gone.svc.play('gym', { track: 'removed song' })).status, 'empty');
  const { svc } = make(playHandlers());
  assert.equal((await svc.play('workout')).status, 'notFound');
  assert.equal((await svc.play('mix tape')).status, 'ambiguous');
});

test('play: a different song loaded → wrong; autoplay blocked → started false', async () => {
  const wrong = make(playHandlers({ play: () => ({ playing: { videoId: 'other' }, started: true }) }));
  assert.equal((await wrong.svc.play('gym')).status, 'wrong');
  const blocked = make(playHandlers({ play: a => ({ playing: { videoId: a.videoId }, started: false }) }));
  const r = await blocked.svc.play('gym', { shuffle: true });
  assert.deepEqual([r.status, r.started, r.shuffled], ['ok', false, false]);
  assert.equal(blocked.link.calls.some(x => x.cmd === 'shuffle'), false);
});

test('play: a failed shuffle does not undo a started playlist', async () => {
  const { svc } = make(playHandlers({ shuffle: () => { throw new Error('Shuffle is not available yet'); } }));
  const r = await svc.play('gym', { shuffle: true });
  assert.deepEqual([r.status, r.started, r.shuffled], ['ok', true, false]);
});

test('pick: ordinals, names, yes for a single suggestion', () => {
  const { svc } = make();
  const c = [LIST[1], LIST[2], LIST[3]];
  assert.equal(svc.pick('the second one', c).id, 'PLgym0000002');
  assert.equal(svc.pick('first', c).id, 'PLgym0000001');
  assert.equal(svc.pick('the last one', c).id, 'PLchill00001');
  assert.equal(svc.pick('chill', c).id, 'PLchill00001');
  assert.equal(svc.pick('gym cardio please', c).id, 'PLgym0000002');
  assert.equal(svc.pick('yes', c), null);
  assert.equal(svc.pick('yes', [LIST[1]]).id, 'PLgym0000001');
  assert.equal(svc.pick('what time is it', c), null);
  assert.equal(svc.pick('', c), null);
});

test('ytm_play_library: confirms what played, asks when unclear', async () => {
  const mk = h => { const m = make(h); return createYtPlayLibraryTool({ playlists: m.svc }); };
  assert.equal(await mk(playHandlers()).run({ playlist: 'gym' }), 'Playing Gym (5 tracks), starting with "Lose Yourself" by Eminem (verified).');
  assert.match(await mk(playHandlers()).run({ playlist: 'gym', shuffle: true }), /\(verified\)\. Shuffled\.$/);
  assert.equal(await mk(playHandlers()).run({ playlist: 'gym', track: 'stronger by kanye west' }), 'Playing "Stronger" by Kanye West from Gym (verified).');
  assert.match(await mk(playHandlers({ play: a => ({ playing: { videoId: a.videoId }, started: false }) })).run({ playlist: 'gym' }), /Chrome blocked autoplay/);
  await assert.rejects(mk(playHandlers()).run({ playlist: 'mix tape' }), /ask the user which: Mix Tape \(5 tracks\); Mix Tape \(9 tracks\)/);
  await assert.rejects(mk(playHandlers()).run({ playlist: 'gym', track: 'stronger' }), /More than one song in Gym matches "stronger"/);
  await assert.rejects(mk(playHandlers()).run({ playlist: 'workout' }), /No playlist called "workout"/);
  await assert.rejects(mk(playHandlers()).run({}), /playlist is required/);
});

test('brain: both playlist tools are added together', () => {
  const { svc } = make();
  const names = defaultTools({ ytPlaylists: svc }).map(t => t.name);
  assert.ok(names.includes('ytm_library') && names.includes('ytm_play_library'));
  assert.match(systemPrompt({ tools: defaultTools({ ytPlaylists: svc }).filter(t => t.name === 'ytm_play_library') }), /ytm_play_library: play one of the user's OWN playlists/);
});

// the media skill: what the user hears from "play my gym playlist" without any model call
function skillWith({ handlers = playHandlers(), linkOpts, catalog } = {}) {
  const m = make(handlers, { link: linkOpts });
  const ytm = { connected: m.link.connected, play: async q => { catalog?.push(q); return { ok: true, item: { title: q, artists: [] }, started: true, sure: true }; } };
  let t = 0;
  return { skill: createMediaSkill({ service: {}, ytm, ytPlaylists: m.svc, now: () => (t += 1000) }), m };
}

test('skill: "play my gym playlist" plays it, silent in voice, short in text', async () => {
  const { skill } = skillWith();
  const text = await skill.handle('play my gym playlist');
  assert.equal(text.reply, 'Playing Gym (5 songs).');
  assert.equal(text.tool, 'youtube_music');
  const voice = await skillWith().skill.handle('play my gym playlist', { source: 'voice' });
  assert.equal(voice.reply, '');
  assert.equal(voice.record, 'Playing Gym (5 songs).');
  const shuffled = await skillWith().skill.handle('shuffle my gym playlist');
  assert.match(shuffled.reply, /shuffled/);
  const song = await skillWith().skill.handle('play stronger by kanye west from my gym playlist');
  assert.match(song.reply, /^Playing “Stronger” by Kanye West from Gym\.$/);
});

test('skill: an unclear playlist is asked about, and the answer plays it', async () => {
  const { skill, m } = skillWith();
  const ask = await skill.handle('play my mix tape playlist');
  assert.match(ask.reply, /^Which playlist: Mix Tape or Mix Tape\?$/);
  assert.deepEqual(ask.clarify, ['Mix Tape', 'Mix Tape']);
  const done = await skill.handle('the second one');
  assert.match(done.reply, /^Playing Mix Tape \(5 songs\)\.$/);
  assert.equal(m.link.calls.find(c => c.cmd === 'playlist').args.id, 'PLmix000002');
});

test('skill: the question is dropped by an unrelated reply, and a later answer no longer works', async () => {
  const { skill, m } = skillWith();
  await skill.handle('play my mix tape playlist');
  assert.equal(await skill.handle('what time is it'), null);
  assert.equal(await skill.handle('the second one'), null);
  assert.equal(m.link.calls.some(c => c.cmd === 'play'), false);
});

test('skill: not in the library → "my" is an error, a loose phrase falls back to the catalog', async () => {
  const catalog = [];
  const { skill } = skillWith({ catalog });
  const mine = await skill.handle('play my workout playlist');
  assert.equal(mine.ok, false);
  assert.match(mine.reply, /^I couldn't find a playlist called workout\./);
  assert.deepEqual(catalog, []);
  const loose = await skill.handle('play the workout playlist');
  assert.deepEqual(catalog, ['workout playlist']);
  assert.equal(loose.ok, true);
});

test('skill: errors are spoken plainly', async () => {
  const offline = await skillWith({ linkOpts: { connected: false } }).skill.handle('play my gym playlist');
  assert.equal(offline.ok, false);
  assert.match(offline.reply, /extension isn't connected/);
  const signedOut = await skillWith({ handlers: playHandlers({ playlists: () => { throw new Error('AUTH: x'); } }) }).skill.handle('play my gym playlist');
  assert.equal(signedOut.ok, false);
  assert.match(signedOut.reply, /Sign in to YouTube Music/);
  const noSong = await skillWith().skill.handle('play bohemian rhapsody from my gym playlist');
  assert.match(noSong.reply, /^I couldn't find bohemian rhapsody in Gym\./);
  const blocked = await skillWith({ handlers: playHandlers({ play: a => ({ playing: { videoId: a.videoId }, started: false }) }) }).skill.handle('play my gym playlist');
  assert.match(blocked.reply, /Chrome blocked autoplay/);
  assert.equal(blocked.ok, true);
});

