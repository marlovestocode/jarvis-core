const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanTitle, score, pickBest, found, lineAfter, coverage } = require('../src/core/lyrics/match');
const { getLyrics, toPlain } = require('../src/core/lyrics/lrclib');
const { searchByLyric, loadToken } = require('../src/core/lyrics/genius');
const { createLyrics } = require('../src/core/lyrics/service');
const { createLyricsSkill } = require('../src/core/lyrics/skill');
const { parse } = require('../src/core/lyrics/intent');
const { createLyricsTools } = require('../src/core/tools/lyrics');
const { createPolicy } = require('../src/core/net/policy');

// invented lyrics, only for tests
const SONG = 'alpha beta gamma delta\nepsilon zeta eta theta\n\niota kappa lambda mu\nnu xi omicron pi';
const rec = (o = {}) => ({ id: 1, trackName: 'Test Song', artistName: 'Test Band', albumName: 'Test Album', duration: 200, instrumental: false, plainLyrics: SONG, syncedLyrics: null, ...o });

function fakeFetcher(routes) {
  const calls = [];
  return {
    calls,
    async getJson(source, url, opts = {}) {
      calls.push({ source, url, opts });
      for (const [re, out] of routes) if (re.test(url)) { if (out instanceof Error) throw out; return { data: typeof out === 'function' ? out(url, opts) : out }; }
      throw new Error('HTTP 404');
    },
  };
}
const notFound = new Error('HTTP 404');

test('cleanTitle strips remaster, feat and version noise', () => {
  assert.equal(cleanTitle('Risk (2019 Remastered)'), 'Risk');
  assert.equal(cleanTitle('Risk - Remastered 2011'), 'Risk');
  assert.equal(cleanTitle('Risk [Official Audio]'), 'Risk');
  assert.equal(cleanTitle('Risk feat. Someone'), 'Risk');
  assert.equal(cleanTitle('Hold On'), 'Hold On');
});

test('score and pickBest: right song wins, weak and wrong songs are refused', () => {
  const req = { title: 'Test Song (Remastered)', artist: 'Test Band', duration: 201 };
  const good = { title: 'Test Song', artist: 'Test Band', duration: 200, text: 'x' };
  const wrongArtist = { title: 'Test Song', artist: 'Someone Else', duration: 200, text: 'x' };
  const wrongTitle = { title: 'Another Tune', artist: 'Test Band', duration: 200, text: 'x' };
  assert.ok(score(req, good) > score(req, wrongArtist));
  assert.equal(pickBest(req, [wrongTitle, wrongArtist, good]).rec, good);
  assert.equal(pickBest(req, [wrongTitle]), null);
  assert.equal(pickBest(req, [{ ...good, text: '' }]), null);          // no lyrics, not instrumental
  assert.ok(pickBest(req, [{ ...good, text: '', instrumental: true }])); // instrumental counts
});

test('found and lineAfter: exact, across two lines, slightly misheard, and not present', () => {
  assert.ok(found('epsilon zeta eta', SONG));
  assert.ok(found('Epsilon, zeta eta THETA!', SONG));
  assert.ok(!found('completely different words here', SONG));
  assert.equal(coverage('alpha beta', SONG), 1);
  assert.deepEqual(lineAfter(SONG, 'alpha beta gamma'), { line: 'alpha beta gamma delta', next: 'epsilon zeta eta theta' });
  assert.equal(lineAfter(SONG, 'epsilon zeta eta theta').next, 'iota kappa lambda mu');   // blank line between stanzas is skipped
  assert.equal(lineAfter(SONG, 'gamma delta epsilon zeta').next, 'iota kappa lambda mu');   // phrase runs over two lines
  assert.equal(lineAfter(SONG, 'nu xi omicron pi').next, null);                              // last line
  assert.equal(lineAfter(SONG, 'nothing like it'), null);
});

test('toPlain strips timestamps from synced lyrics', () => {
  assert.equal(toPlain({ syncedLyrics: '[00:01.20] one\n[00:03.00] two' }), 'one\ntwo');
  assert.equal(toPlain({ plainLyrics: 'plain', syncedLyrics: '[00:01.20] x' }), 'plain');
});

test('lrclib: exact hit, search fallback, 404, no match, cached with a long ttl', async () => {
  const f = fakeFetcher([[/\/api\/get\?/, rec()]]);
  const exact = await getLyrics(f, { title: 'Test Song', artist: 'Test Band', album: 'Test Album', duration: 200 });
  assert.equal(exact.rec.text, SONG);
  assert.equal(f.calls[0].source, 'lyrics');
  assert.ok(f.calls[0].opts.ttlMs >= 7 * 24 * 3600 * 1000);

  const s = fakeFetcher([[/\/api\/get\?/, notFound], [/\/api\/search\?track_name/, [rec({ id: 2, trackName: 'Other', artistName: 'Nobody' }), rec()]]]);
  const viaSearch = await getLyrics(s, { title: 'Test Song (Live)', artist: 'Test Band', album: 'A', duration: 200 });
  assert.equal(viaSearch.rec.artist, 'Test Band');

  assert.equal(await getLyrics(fakeFetcher([]), { title: 'Nope', artist: 'Nobody' }), null);
  await assert.rejects(getLyrics(fakeFetcher([[/./, new Error('HTTP 500')]]), { title: 'x' }), /500/);
  assert.equal(await getLyrics(fakeFetcher([]), { title: '  ' }), null);
});

test('genius: token only in the header, hits shaped and deduped, non-songs dropped', async () => {
  const f = fakeFetcher([[/api\.genius\.com\/search\?q=/, { response: { hits: [
    { type: 'song', result: { title: 'Test Song', primary_artist: { name: 'Test Band' } } },
    { type: 'song', result: { title: 'Test Song', primary_artist: { name: 'Test Band' } } },
    { type: 'album', result: { title: 'An Album', primary_artist: { name: 'X' } } },
    { type: 'song', result: { title: 'Second', primary_artist: { name: 'Y' } } },
  ] } }]]);
  const out = await searchByLyric(f, 'SECRET-TOKEN', 'some words');
  assert.deepEqual(out, [{ title: 'Test Song', artist: 'Test Band' }, { title: 'Second', artist: 'Y' }]);
  assert.ok(!f.calls[0].url.includes('SECRET-TOKEN'));
  assert.equal(f.calls[0].opts.headers.Authorization, 'Bearer SECRET-TOKEN');
});

test('loadToken: env first, then the first line of the file, else null', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-'));
  assert.equal(loadToken(dir, {}), null);
  fs.writeFileSync(path.join(dir, 'genius.token'), ' file-token \nignored\n');
  assert.equal(loadToken(dir, {}), 'file-token');
  assert.equal(loadToken(dir, { JARVIS_GENIUS_TOKEN: 'env-token' }), 'env-token');
  fs.rmSync(dir, { recursive: true, force: true });
});

function service({ token = 'tok', playing = null, lrc = rec(), genius } = {}) {
  const fetcher = fakeFetcher([
    [/api\.genius\.com/, genius ?? { response: { hits: [{ type: 'song', result: { title: 'Test Song', primary_artist: { name: 'Test Band' } } }] } }],
    [/lrclib\.net/, url => (url.includes('/search') ? [lrc] : lrc)],
  ]);
  const ytm = { connected: !!playing, status: async () => ({ playing }) };
  return { fetcher, svc: createLyrics({ fetcher, ytm, getToken: () => token }) };
}

test('service: current song, named song, nothing playing, not found, instrumental', async () => {
  const { svc } = service({ playing: { title: 'Test Song', artist: 'Test Band', album: 'Test Album', duration: 200 } });
  assert.equal((await svc.get({ current: true })).rec.text, SONG);
  assert.equal((await service().svc.get({ current: true })).reason, 'nothing-playing');
  assert.equal((await service().svc.get({ title: 'Test Song', artist: 'Test Band' })).ok, true);
  assert.equal((await service({ lrc: rec({ trackName: 'Different', artistName: 'Else' }) }).svc.get({ title: 'Test Song', artist: 'Test Band' })).reason, 'not-found');
  const inst = await service({ lrc: rec({ instrumental: true, plainLyrics: '' }) }).svc.get({ title: 'Test Song', artist: 'Test Band' });
  assert.equal(inst.reason, 'instrumental');
});

test('service: reverse lookup is verified against the lyrics, never guessed', async () => {
  const ok = await service().svc.byLyric('epsilon zeta eta');
  assert.equal(ok.ok, true); assert.equal(ok.next, 'iota kappa lambda mu');
  const unconfirmed = await service().svc.byLyric('words that are not in this song at all');
  assert.equal(unconfirmed.reason, 'unconfirmed'); assert.equal(unconfirmed.guess.title, 'Test Song');
  assert.equal((await service({ token: null }).svc.byLyric('epsilon zeta')).reason, 'no-token');
  assert.equal((await service({ genius: { response: { hits: [] } } }).svc.byLyric('epsilon zeta')).reason, 'not-found');
});

test('service: nextLine uses the playing song first, and needs no token for it', async () => {
  const { svc, fetcher } = service({ token: null, playing: { title: 'Test Song', artist: 'Test Band', album: 'Test Album', duration: 200 } });
  const r = await svc.nextLine('alpha beta gamma');
  assert.equal(r.next, 'epsilon zeta eta theta');
  assert.ok(!fetcher.calls.some(c => /genius/.test(c.url)));
});

test('intent: the phrasings that must match, and the ones that must not', () => {
  assert.deepEqual(parse('lyrics for this'), { kind: 'show', current: true });
  assert.deepEqual(parse('show me the lyrics'), { kind: 'show', current: true });
  assert.deepEqual(parse('what are the lyrics to this song'), { kind: 'show', current: true });
  assert.deepEqual(parse('Jarvis, can you show me the lyrics to Risk by Deftones?'), { kind: 'show', title: 'Risk', artist: 'Deftones' });
  assert.deepEqual(parse('lyrics to Hold On'), { kind: 'show', title: 'Hold On' });
  assert.deepEqual(parse('pull up risk by deftones lyrics'), { kind: 'show', title: 'risk', artist: 'deftones' });
  for (const t of ['Tell me the lyrics for this song.', 'tell me the lyrics to this song', 'Can you sing me the lyrics of this song?', 'I want to see the lyrics for the song that is playing', 'what are the lyrics for the current track']) assert.deepEqual(parse(t), { kind: 'show', current: true }, t);
  assert.deepEqual(parse('tell me the lyrics to Risk by Deftones'), { kind: 'show', title: 'Risk', artist: 'Deftones' });
  assert.deepEqual(parse('what song goes "epsilon zeta eta"'), { kind: 'find', phrase: 'epsilon zeta eta' });
  assert.deepEqual(parse('which song has the lyrics epsilon zeta'), { kind: 'find', phrase: 'epsilon zeta' });
  assert.deepEqual(parse("what's the next line after epsilon zeta"), { kind: 'next', phrase: 'epsilon zeta' });
  assert.deepEqual(parse('what comes after epsilon zeta eta'), { kind: 'next', phrase: 'epsilon zeta eta' });
  for (const no of ['play risk by deftones', 'lyrics videos are fun to watch', 'what song is this', 'what is the weather', 'queue risk next', 'I like the lyrics of old songs a lot', 'play the lyrics video for this']) assert.equal(parse(no), null, no);
});

test('skill: lyrics are shown in full, spoken as one short line; every failure is honest', async () => {
  const { svc } = service({ playing: { title: 'Test Song', artist: 'Test Band', album: 'Test Album', duration: 200 } });
  const skill = createLyricsSkill({ lyrics: svc });
  const r = await skill.handle('lyrics for this');
  assert.equal(r.reply, 'The lyrics to Test Song are on screen.');
  assert.ok(r.record.includes('alpha beta gamma delta') && r.record.includes('nu xi omicron pi') && r.record.includes('LRCLIB'));
  assert.equal(await skill.handle('play something'), null);

  const found = await skill.handle('what song goes epsilon zeta eta');
  assert.match(found.reply, /“Test Song” by Test Band.*iota kappa lambda mu/);
  const nl = await skill.handle("what's the next line after epsilon zeta eta theta");
  assert.match(nl.reply, /iota kappa lambda mu/);
  const unsure = await skill.handle('what song goes totally unrelated words here');
  assert.match(unsure.reply, /couldn't confirm/); assert.equal(unsure.ok, false);
  assert.match((await createLyricsSkill({ lyrics: service({ token: null }).svc }).handle('what song goes epsilon zeta')).reply, /Genius API token/);
  assert.match((await createLyricsSkill({ lyrics: service().svc }).handle('lyrics for this')).reply, /Nothing is playing/);
  assert.match((await createLyricsSkill({ lyrics: service().svc, getConfig: () => ({ online: { enabled: false } }) }).handle('lyrics for this')).reply, /Online lookups are off/);
  assert.match((await createLyricsSkill({ lyrics: service({ lrc: rec({ instrumental: true, plainLyrics: '' }) }).svc }).handle('lyrics to Test Song by Test Band')).reply, /instrumental/);
});

test('skill: a lyric containing code fences cannot break out of the block', async () => {
  const { svc } = service({ lrc: rec({ plainLyrics: 'line one\n```\nline two' }) });
  const r = await createLyricsSkill({ lyrics: svc }).handle('lyrics to Test Song by Test Band');
  assert.equal(r.record.match(/```/g).length, 2);
});

test('tools: capped, wrapped as source data, honest when nothing is found', async () => {
  const long = Array.from({ length: 400 }, (_, i) => `line number ${i} of a long song`).join('\n');
  const [get, find] = createLyricsTools({ lyrics: service({ lrc: rec({ plainLyrics: long }), playing: { title: 'Test Song', artist: 'Test Band', album: 'Test Album', duration: 200 } }).svc });
  const out = await get.run({});
  assert.match(out, /^SOURCE DATA/); assert.ok(out.length < 2400); assert.match(out, /lyrics for this/);
  assert.match(await createLyricsTools({ lyrics: service({ lrc: rec({ trackName: 'X', artistName: 'Y' }) }).svc })[0].run({ title: 'Test Song', artist: 'Test Band' }), /do not recite them from memory/);
  assert.match(await find.run({ lines: 'unrelated words nowhere' }), /NOT confirmed/);
  await assert.rejects(find.run({ lines: ' ' }), /required/);
});

test('policy: lyrics hosts are allowed, the lyrics switch works, other hosts stay refused', () => {
  const p = createPolicy(() => ({ online: { enabled: true, lyrics: true } }));
  assert.equal(p.allowed('https://lrclib.net/api/get?x=1', 'lyrics').ok, true);
  assert.equal(p.allowed('https://api.genius.com/search?q=x', 'lyrics').ok, true);
  assert.equal(p.allowed('https://genius.com/Some-song-lyrics', 'lyrics').ok, false);   // pages are never fetched
  assert.equal(createPolicy(() => ({ online: { enabled: true, lyrics: false } })).allowed('https://lrclib.net/api/get', 'lyrics').ok, false);
});

test('service: an "Artist - Title" upload title is split, the artist from the title beats the uploader', async () => {
  const lrc = rec({ trackName: 'Entombed', artistName: 'Deftones' });
  const fetcher = fakeFetcher([[/lrclib\.net/, url => (url.includes('/search') ? [lrc] : lrc)]]);
  const svc = createLyrics({ fetcher, getToken: () => null });
  const r = await svc.get({ title: 'Deftones - Entombed', artist: 'Primera Starrk' });
  assert.equal(r.ok, true); assert.equal(r.rec.title, 'Entombed'); assert.equal(r.rec.artist, 'Deftones');
  // a dash title whose parts match nothing is still refused, never guessed
  assert.equal((await svc.get({ title: 'Nothing - Related', artist: 'Nobody' })).reason, 'not-found');
});

test('skill: after a miss, a short bare reply is the song (not sent to the model); other talk is left alone', async () => {
  let t = 1000;
  const { svc } = service();
  const skill = createLyricsSkill({ lyrics: svc, now: () => t });
  assert.match((await skill.handle('lyrics to Unknown Thing by Nobody')).reply, /couldn't find/);
  const follow = await skill.handle('Test Song by Test Band');
  assert.match(follow.reply, /The lyrics to Test Song are on screen/);
  assert.equal(await skill.handle('Test Song by Test Band'), null);          // the question was answered: no longer a follow-up
  await skill.handle('lyrics to Unknown Thing by Nobody');
  assert.equal(await skill.handle('play something else'), null);             // a command is never taken for a title
  await skill.handle('lyrics to Unknown Thing by Nobody');
  t = 50000;
  assert.equal(await skill.handle('Test Song'), null);                       // too late
});

test('match: artist spellings and swapped or "Artist - Title" records are one song', () => {
  const req = { title: 'Antarctica', artist: 'Suicide Boys' };
  const ok = { title: 'Antarctica', artist: '$uicideboy$', text: 'x' };
  assert.ok(score(req, ok) >= 0.9);
  assert.ok(score(req, { title: '$uicideboy$', artist: 'Antarctica', text: 'x' }) >= 0.9);                       // fields swapped
  assert.ok(score(req, { title: '$UICIDEBOY$ - ANTARCTICA (Lyric Video)', artist: '$uicideboy$', text: 'x' }) >= 0.9);
  assert.ok(score(req, { title: 'Antarctica', artist: 'SuicideBoys', text: 'x' }) >= 0.9);
  assert.equal(pickBest(req, [{ title: 'Antarctica', artist: 'Men Without Hats', text: 'x' }]), null);          // same title, other artist
});

test('lrclib: falls through to a title-only search when the artist is spelled differently', async () => {
  const f = fakeFetcher([
    [/\/api\/search\?track_name=/, []],
    [/\/api\/search\?q=Antarctica%20Suicide%20Boys/, []],
    [/\/api\/search\?q=Antarctica$/, [rec({ trackName: 'Antarctica', artistName: 'Men Without Hats' }), rec({ trackName: 'Antarctica', artistName: '$uicideboy$' })]],
  ]);
  const hit = await getLyrics(f, { title: 'Antarctica', artist: 'Suicide Boys' });
  assert.equal(hit.rec.artist, '$uicideboy$');
});

test('lrclib: a speech-garbled title is found by its content words, and scoring still refuses a different song', async () => {
  const real = rec({ trackName: '...And to Those I Love, Thanks for Sticking Around', artistName: '$uicideboy$' });
  const f = fakeFetcher([[/\/api\/search\?q=those%20love%20thanks%20sticking%20around$/, [rec({ trackName: 'Thanks for Sticking Around', artistName: 'On Planets' }), real]]]);
  const hit = await getLyrics(f, { title: 'end those two i love thanks for sticking around', artist: 'Suicide Boys' });
  assert.equal(hit.rec.artist, '$uicideboy$');
  const other = fakeFetcher([[/\/api\/search\?q=/, [rec({ trackName: 'Thanks for Sticking Around', artistName: 'On Planets' })]]]);
  assert.equal(await getLyrics(other, { title: 'end those two i love thanks for sticking around', artist: 'Suicide Boys' }), null);
});

test('skill: "play that song" right after lyrics plays that song; with no recent lyrics it is left to the media skill', async () => {
  const plays = [];
  const ytm = { play: async q => { plays.push(q); return { ok: true, started: true, item: { title: 'Test Song', artists: ['Test Band'] } }; } };
  let t = 1000;
  const { svc } = service();
  const skill = createLyricsSkill({ lyrics: svc, ytm, now: () => t });
  assert.equal(await skill.handle('Can you play that song?'), null);          // nothing shown yet
  await skill.handle('lyrics to Test Song by Test Band');
  for (const say of ['Can you play that song?', 'play it', 'please play that', 'could you play this one']) {
    plays.length = 0;
    const r = await skill.handle(say);
    assert.equal(plays[0], 'Test Song by Test Band', say);
    assert.match(r.reply, /^Playing .*Test Song.*Test Band/, say);
  }
  assert.equal(await skill.handle('play something else'), null);
  t = 1000 + 16 * 60 * 1000;
  assert.equal(await skill.handle('play that song'), null);                  // too long ago
  // a song named from a line counts too
  t += 1000;
  await skill.handle('what song goes epsilon zeta eta');
  plays.length = 0; await skill.handle('play it');
  assert.equal(plays[0], 'Test Song by Test Band');
});
