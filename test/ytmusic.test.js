const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const { parseRequest, rank } = require('../src/core/media/rank');
const { startYtMusicLink, frame, createParser } = require('../src/core/media/ytmusic-link');
const { createYtMusic } = require('../src/core/media/ytmusic');
const { createMediaSkill } = require('../src/core/media/skill');
const { EXTENSION_ID } = require('../src/core/media/ytmusic-id');

// Candidates shaped like extension/page.js output (from real YouTube Music searches).
const c = (type, title, artists, extra = {}) => ({ top: false, type, title, artists, album: '', duration: '', videoId: type === 'song' || type === 'video' ? title.replace(/\W/g, '').slice(0, 11) : null,
  play: type === 'song' || type === 'video' ? { watchEndpoint: { videoId: title.replace(/\W/g, '').slice(0, 11) } } : { watchPlaylistEndpoint: { playlistId: 'PL' + title.replace(/\W/g, '') } },
  queue: { next: { videoId: 'n' }, end: { videoId: 'e' } }, ...extra });
const BOHEMIAN = [
  c('video', 'Bohemian Rhapsody', ['Queen'], { top: true, duration: '6:00' }),
  c('song', 'Bohemian Rhapsody', ['Queen']),
  c('album', 'Bohemian Rhapsody (The Original Soundtrack)', ['Queen']),
  c('song', 'Bohemian Rhapsody (2019 Remastered Edition)', ['Bohemian Rhapsody']),
  c('song', 'Bohemian Rhapsody (Live, European Tour / 1979)', ['Queen']),
  c('song', 'Bohemian Rhapsody', ['Jared Halley']),
];
const JAZZ = [
  c('other', 'Jazz Radio', [], { top: true, queue: {} }),
  c('playlist', 'Essential Jazz', []),
  c('playlist', 'Cool Jazz Moods', []),
  c('song', 'Jazz Cafe Music – Coffee Shop Ambience for Work & Study', ['Rainy Jazz Club']),
];
const IDIOT = [
  c('album', 'American Idiot', ['Green Day'], { top: true }),
  c('album', 'American Idiot (20th Anniversary Deluxe Edition)', ['Green Day']),
  c('song', 'American Idiot', ['Green Day']),
  c('song', 'Holiday / Boulevard of Broken Dreams', ['Green Day']),
];
const best = (q, cands, need) => rank(parseRequest(q), cands, { need })[0].c;

test('rank: the studio song by the right artist, not live, cover or remaster channel', () => {
  assert.deepEqual([best('bohemian rhapsody by queen', BOHEMIAN).type, best('bohemian rhapsody by queen', BOHEMIAN).artists[0]], ['song', 'Queen']);
  assert.equal(best('bohemian rhapsody queen', BOHEMIAN).title, 'Bohemian Rhapsody');
  assert.notEqual(best('bohemian rhapsody', BOHEMIAN).title, 'Bohemian Rhapsody (Live, European Tour / 1979)');
  assert.equal(best('bohemian rhapsody live', BOHEMIAN).title, 'Bohemian Rhapsody (Live, European Tour / 1979)');
  assert.equal(best('bohemian rhapsody by jared halley', BOHEMIAN).artists[0], 'Jared Halley');
});

test('rank: albums, moods and artists', () => {
  assert.deepEqual([best('the album american idiot', IDIOT).type, best('the album american idiot', IDIOT).title], ['album', 'American Idiot']);
  assert.equal(best('american idiot', IDIOT).type, 'song');
  assert.equal(best('some jazz', JAZZ).type === 'playlist' || best('some jazz', JAZZ).type === 'other', true);
  assert.equal(best('jazz music', JAZZ).type === 'playlist' || best('jazz music', JAZZ).type === 'other', true);
  assert.equal(rank(parseRequest('zzqx flurb'), BOHEMIAN)[0].score < 0.35, true);   // nothing close: not played
});

test('rank: parseRequest', () => {
  assert.deepEqual(parseRequest('play bohemian rhapsody by queen on youtube music'), { title: 'bohemian rhapsody', artist: 'queen', kind: null, mood: false, query: 'bohemian rhapsody queen' });
  assert.equal(parseRequest('the album american idiot').kind, 'album');
  assert.equal(parseRequest('some lofi').mood, true);
  assert.deepEqual([parseRequest('songs by queen').title, parseRequest('songs by queen').artist], ['', 'queen']);
});

// ---- link: real sockets, real handshake ----
function client(port, origin, path = '/ytmusic') {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    s.once('error', reject);
    s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`);
    let head = '';
    const msgs = [];
    const onData = d => {
      head += d.toString('latin1');
      const i = head.indexOf('\r\n\r\n');
      if (i < 0) return;
      s.off('data', onData);
      if (!/^HTTP\/1\.1 101/.test(head)) { s.destroy(); return resolve({ refused: head.split('\r\n')[0] }); }
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');   // RFC 6455 GUID
      if (!head.includes(`Sec-WebSocket-Accept: ${accept}`)) { s.destroy(); return reject(new Error('bad Sec-WebSocket-Accept')); }
      const parse = createParser((fin, op, data) => { if (op === 1) msgs.push(JSON.parse(data.toString())); });
      s.on('data', parse);
      const rest = Buffer.from(head.slice(i + 4), 'latin1');   // a frame sent right behind the 101 arrives in the same chunk
      if (rest.length) parse(rest);
      const sendMasked = obj => {   // clients must mask
        const p = Buffer.from(JSON.stringify(obj)); const m = crypto.randomBytes(4);
        const f = frame(1, Buffer.from(p.map((b, k) => b ^ m[k & 3])));
        const hdr = f.subarray(0, f.length - p.length); hdr[1] |= 0x80;
        s.write(Buffer.concat([hdr, m, Buffer.from(p.map((b, k) => b ^ m[k & 3]))]));
      };
      resolve({ s, msgs, send: sendMasked });
    };
    s.on('data', onData);
  });
}
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

test('link: only the JARVIS extension may connect; requests round-trip', async () => {
  const link = startYtMusicLink({ ports: [47890, 47891] });
  const port = await link.started;
  assert.equal((await client(port, 'https://evil.example')).refused, 'HTTP/1.1 403 Forbidden');
  assert.equal((await client(port, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).refused, 'HTTP/1.1 403 Forbidden');
  assert.equal((await client(port, `chrome-extension://${EXTENSION_ID}`, '/other')).refused, 'HTTP/1.1 403 Forbidden');
  await assert.rejects(link.request('status'), /not connected/);
  const ext = await client(port, `chrome-extension://${EXTENSION_ID}`);
  await tick();
  assert.equal(link.connected, true);
  ext.send({ type: 'hello', version: '1.0.0' });
  const p = link.request('search', { query: 'x' });
  await tick();
  const req = ext.msgs.find(m => m.cmd === 'search');
  assert.deepEqual(req.args, { query: 'x' });
  ext.send({ id: req.id, ok: true, result: { candidates: [] } });
  assert.deepEqual(await p, { candidates: [] });
  const e = link.request('like', {});
  await tick();
  ext.send({ id: ext.msgs.find(m => m.cmd === 'like').id, ok: false, error: 'Sign in to YouTube Music to like songs' });
  await assert.rejects(e, /Sign in/);
  ext.s.destroy();
  for (let i = 0; i < 50 && link.connected; i++) await tick(20);
  try { assert.equal(link.connected, false); } finally { await link.close(); }
});

test('link with a key: nothing is accepted until the extension proves it, and the proof is checked both ways', async () => {
  const { proof } = require('../src/core/media/link-key');
  const KEY = 'ab'.repeat(32);
  const changes = [], plays = [];
  const link = startYtMusicLink({ ports: [47894, 47895], secret: KEY, authMs: 300, onChange: c => changes.push(c), onPlay: e => plays.push(e) });
  const port = await link.started;
  const origin = `chrome-extension://${EXTENSION_ID}`;
  const waitFor = async (ext, pred) => { for (let i = 0; i < 50 && !ext.msgs.find(pred); i++) await tick(10); return ext.msgs.find(pred); };

  // 1. a client that never answers the challenge is dropped, and nothing it sent counted
  const lazy = await client(port, origin);
  const ch = await waitFor(lazy, m => m.type === 'challenge');
  assert.ok(ch?.nonce);
  lazy.send({ type: 'play', event: { title: 'sneaky' } });
  await tick(20);
  assert.equal(link.connected, false);
  await assert.rejects(link.request('status'), /not connected/);
  for (let i = 0; i < 40 && !lazy.s.destroyed; i++) await tick(20);
  assert.equal(lazy.s.destroyed, true, 'dropped after authMs');
  assert.deepEqual(plays, []);

  // 2. a wrong key is dropped at once
  const wrong = await client(port, origin);
  const wc = await waitFor(wrong, m => m.type === 'challenge');
  wrong.send({ type: 'hello', version: '1', nonce: 'n2', proof: proof('cd'.repeat(32), 'ext', port, wc.nonce) });
  for (let i = 0; i < 40 && !wrong.s.destroyed; i++) await tick(20);
  assert.equal(wrong.s.destroyed, true);
  assert.equal(link.connected, false);

  // 3. a proof made for another port (a relay) is refused
  const relay = await client(port, origin);
  const rc = await waitFor(relay, m => m.type === 'challenge');
  relay.send({ type: 'hello', version: '1', nonce: 'n2', proof: proof(KEY, 'ext', port + 1, rc.nonce) });
  for (let i = 0; i < 40 && !relay.s.destroyed; i++) await tick(20);
  assert.equal(relay.s.destroyed, true);

  // 4. the right key: JARVIS answers with its own proof, then commands and plays work
  const ext = await client(port, origin);
  const c4 = await waitFor(ext, m => m.type === 'challenge');
  ext.send({ type: 'hello', version: '1.5.0', nonce: 'n2n2', proof: proof(KEY, 'ext', port, c4.nonce) });
  const auth = await waitFor(ext, m => m.type === 'auth');
  assert.equal(auth.proof, proof(KEY, 'srv', port, c4.nonce, 'n2n2'));
  await tick();
  assert.equal(link.connected, true);
  assert.deepEqual(changes, [true]);
  ext.send({ type: 'play', event: { title: 'ok' } });
  const p = link.request('status');
  const req = await waitFor(ext, m => m.cmd === 'status');
  ext.send({ id: req.id, ok: true, result: { fine: 1 } });
  assert.deepEqual(await p, { fine: 1 });
  assert.deepEqual(plays, [{ title: 'ok' }]);
  ext.s.destroy();
  for (let i = 0; i < 50 && link.connected; i++) await tick(20);
  try { assert.equal(link.connected, false); } finally { await link.close(); }
});

test('link key: made once, kept, and reused', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { loadOrCreateLinkKey, KEY_RE } = require('../src/core/media/link-key');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jc-key-')), 'link.key');
  const a = loadOrCreateLinkKey(file);
  assert.match(a, KEY_RE);
  assert.equal(loadOrCreateLinkKey(file), a);
  fs.writeFileSync(file, 'not a key');
  assert.match(loadOrCreateLinkKey(file), KEY_RE, 'a damaged file is replaced');
});

// ---- ytmusic + skill against a fake extension ----
function fakeExt({ startPlays = true } = {}) {
  const st = { playing: { videoId: 'OXhFMpmrP1s', title: 'Nightmare on the Northside', artist: 'Scrim', state: 1 },
    queue: { index: 0, items: [{ index: 0, videoId: 'OXhFMpmrP1s', title: 'Nightmare on the Northside', artist: 'Scrim', selected: true }], automix: [{ index: 1, videoId: 'jY', title: 'ugly sunday', artist: 'Scrim' }, { index: 2, videoId: 'Xn', title: '2nd Hand', artist: '$uicideboy$' }], repeat: 'NONE' } };
  const calls = [];
  const link = {
    connected: true,
    async request(cmd, args) {
      calls.push({ cmd, args });
      if (cmd === 'status') return st;
      if (cmd === 'search') return { candidates: BOHEMIAN };
      if (cmd === 'play') { const id = args.play.watchEndpoint?.videoId; st.playing = { videoId: id, title: 'Bohemian Rhapsody', artist: 'Queen', state: startPlays ? 1 : -1 }; return { playing: st.playing, started: startPlays }; }
      if (cmd === 'enqueue') { const item = { videoId: args.target.videoId, title: 'Bohemian Rhapsody', artist: 'Queen' }; st.queue.items.splice(args.position === 'next' ? 1 : st.queue.items.length, 0, item); return { queue: st.queue, added: 1 }; }
      if (cmd === 'repeat') { st.queue.repeat = args.mode; return { repeat: args.mode }; }
      if (cmd === 'like') return { like: args.value };
      if (cmd === 'clear') { const n = st.queue.items.length - 1; st.queue.items.length = 1; return { removed: n }; }
      if (cmd === 'remove') { const [r] = st.queue.items.splice(args.index, 1); return { removed: r }; }
      throw new Error('unknown ' + cmd);
    },
  };
  return { link, calls, st };
}
const noService = { state: async () => ({ sessions: [], system: { volume: 0.5, muted: false }, apps: [] }), pickSession: () => ({ none: 'nothing is playing' }), act: async () => ({ ok: false, message: 'x' }) };

test('skill: "play X" finds, plays and verifies; silent in voice when sure', async () => {
  const f = fakeExt();
  const skill = createMediaSkill({ service: noService, ytm: createYtMusic({ link: f.link }) });
  const v = await skill.handle('play bohemian rhapsody by queen', { source: 'voice' });
  assert.equal(v.reply, ''); assert.equal(v.record, 'Playing “Bohemian Rhapsody” by Queen.'); assert.equal(v.tool, 'youtube_music');
  const play = f.calls.find(x => x.cmd === 'play');
  assert.equal(play.args.videoId, 'BohemianRha');
  assert.equal(f.calls.filter(x => x.cmd === 'play').length, 1);
  const t = await skill.handle('play bohemian rhapsody', { source: 'text' });
  assert.equal(t.reply, 'Playing “Bohemian Rhapsody” by Queen.');
});

test('skill: autoplay blocked is reported, not claimed', async () => {
  const skill = createMediaSkill({ service: noService, ytm: createYtMusic({ link: fakeExt({ startPlays: false }).link }) });
  assert.match((await skill.handle('play bohemian rhapsody by queen', { source: 'voice' })).reply, /blocked autoplay/);
});

test('skill: queue next / end, up next, clear, remove, repeat, like', async () => {
  const f = fakeExt();
  const skill = createMediaSkill({ service: noService, ytm: createYtMusic({ link: f.link }) });
  assert.equal((await skill.handle('play bohemian rhapsody next', { source: 'voice' })).reply, 'Next up: Bohemian Rhapsody by Queen.');
  assert.equal(f.calls.find(x => x.cmd === 'enqueue').args.position, 'next');
  assert.equal((await skill.handle("what's up next", { source: 'voice' })).reply, 'Next: Bohemian Rhapsody by Queen, then ugly sunday, then 2nd Hand.');
  assert.equal((await skill.handle('add bohemian rhapsody to the queue', { source: 'text' })).reply, 'Added to the queue: “Bohemian Rhapsody” by Queen.');
  assert.equal((await skill.handle('remove the next song', { source: 'voice' })).reply, 'Removed Bohemian Rhapsody.');
  assert.equal((await skill.handle('clear the queue', { source: 'voice' })).reply, 'Queue cleared.');
  assert.equal((await skill.handle('repeat this song', { source: 'voice' })).reply, 'Repeat this track.');
  assert.equal(f.calls.find(x => x.cmd === 'repeat').args.mode, 'ONE');
  assert.equal((await skill.handle('like this song', { source: 'voice' })).reply, 'Liked.');
});

test('skill: honest when the extension is missing or another app is named', async () => {
  const skill = createMediaSkill({ service: noService, ytm: createYtMusic({ link: { connected: false, request: async () => { throw new Error('no'); } } }) });
  assert.match((await skill.handle('play bohemian rhapsody', { source: 'voice' })).reply, /extension isn't connected/);
  assert.match((await skill.handle('play bohemian rhapsody on spotify', { source: 'voice' })).reply, /only search YouTube Music, not Spotify/);
  assert.match((await skill.handle("what's up next", { source: 'voice' })).reply, /queue/);
});

test('link: plays reported by the extension (live and as a batch kept while JARVIS was closed) reach onPlay; junk is ignored', async () => {
  const got = [];
  const link = startYtMusicLink({ ports: [47892, 47893], onPlay: e => got.push(e) });
  const port = await link.started;
  const ext = await client(port, `chrome-extension://${EXTENSION_ID}`);
  await tick();
  ext.send({ type: 'play', event: { videoId: 'abc12345', startedAt: 1 } });
  ext.send({ type: 'plays', events: [{ videoId: 'def12345' }, { videoId: 'ghi12345' }] });
  ext.send({ type: 'plays', events: 'nope' });
  await tick();
  assert.deepEqual(got.map(e => e.videoId), ['abc12345', 'def12345', 'ghi12345']);
  ext.s.destroy();
  await link.close();
});

test('rank: a loosely spoken title and artist still win (no exact title needed)', () => {
  const { parseRequest, rank } = require('../src/core/media/rank');
  const cands = [
    { title: "5 'N the Mornin'", artists: ['$uicideboy$'], type: 'song', play: {} },
    { title: 'In the Morning', artists: ['Some Band'], type: 'song', play: {} },
    { title: '5 in the Morning', artists: ['Cover Guy'], type: 'song', play: {} },
  ];
  const r = rank(parseRequest('play 5 in the morning by suicide boys'), cands);
  assert.equal(r[0].c.artists[0], '$uicideboy$');
  assert.ok(r[0].score >= 0.35);
});

test('link with a key: an old extension (no proof) is dropped, reported once a minute, with a readable reason', async () => {
  const logs = [], rejects = [];
  const link = startYtMusicLink({ ports: [47896, 47897], secret: 'ab'.repeat(32), log: m => logs.push(m), onReject: r => rejects.push(r) });
  const port = await link.started;
  const origin = `chrome-extension://${EXTENSION_ID}`;
  for (let i = 0; i < 4; i++) {
    const old = await client(port, origin);
    for (let k = 0; k < 50 && !old.msgs.find(m => m.type === 'challenge'); k++) await tick(10);
    old.send({ type: 'hello', version: '1.4.0' });   // what a 1.4.0 extension sends
    for (let k = 0; k < 40 && !old.s.destroyed; k++) await tick(10);
    assert.equal(old.s.destroyed, true);
  }
  try {
    assert.equal(rejects.length, 1, 'one report, not one per retry');
    assert.equal(rejects[0].legacy, true);
    assert.equal(logs.filter(l => /old version/.test(l)).length, 1);
    assert.equal(link.connected, false);
  } finally { await link.close(); }
});
