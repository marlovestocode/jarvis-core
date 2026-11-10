const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { fixture } = require('./helpers/fakenet');
const { createKiwix, parseSearch, pickZim } = require('../src/core/knowledge/kiwix');

const ZIM = 'wikipedia_en_all_nopic_2026-10.zim';
function fakeSpawn() {
  const kids = [];
  const spawn = (exe, args, opts) => {
    const k = new EventEmitter();
    k.exe = exe; k.args = args; k.opts = opts; k.stdout = new EventEmitter(); k.stderr = new EventEmitter();
    k.kill = () => { k.killed = true; k.emit('exit', null); };
    kids.push(k);
    return k;
  };
  spawn.kids = kids;
  return spawn;
}
function fakeFetch(up = () => true) {
  const f = async url => {
    f.calls.push(url);
    if (!up()) throw new TypeError('ECONNREFUSED');
    if (url.endsWith('/')) return new Response('home');
    if (url.includes('/search?')) return new Response(fixture('kiwix-search.html'));
    if (url.includes('/catalog/v2/entries')) return new Response('<feed><entry><name>wikipedia_en_all_nopic</name><articleCount>6912345</articleCount></entry></feed>');
    if (url.includes('/content/')) return new Response('<html><body><p>Article</p></body></html>');
    return new Response('nope', { status: 404 });
  };
  f.calls = [];
  return f;
}
function setup({ files = [ZIM], exe = true } = {}) {
  const spawn = fakeSpawn();
  const fetch = fakeFetch();
  const k = createKiwix({ exe: 'C:/x/kiwix-serve.exe', zimDir: 'C:/JarvisData/library', spawn, fetch, exists: p => (p.endsWith('.exe') ? exe : true), readdir: () => files, stat: () => ({ size: 51e9 }) });
  return { k, spawn, fetch };
}

test('kiwix: picks the newest complete wikipedia_en_all_nopic ZIM, ignores partial downloads', () => {
  assert.equal(pickZim(['wikipedia_en_all_nopic_2025-08.zim', 'wikipedia_en_all_nopic_2026-10.zim', 'wikipedia_en_all_nopic_2026-12.zim.part', 'other.zim']), 'wikipedia_en_all_nopic_2026-10.zim');
  assert.equal(pickZim(['x.zim.part']), null);
});

test('kiwix: not installed → available() false, search rejects, no spawn', async () => {
  for (const s of [setup({ files: [] }), setup({ exe: false })]) {
    assert.equal(s.k.available(), false);
    await assert.rejects(s.k.search('x'), /not installed/i);
    assert.equal(s.spawn.kids.length, 0);
  }
});

test('kiwix: starts one server on 127.0.0.1:47820 with the ZIM', async () => {
  const { k, spawn } = setup();
  assert.equal(k.available(), true);
  await Promise.all([k.warm(), k.warm(), k.search('photosynthesis')]);
  assert.equal(spawn.kids.length, 1);
  const a = spawn.kids[0].args;
  assert.equal(a[a.indexOf('--address') + 1], '127.0.0.1');
  assert.equal(a[a.indexOf('--port') + 1], '47820');
  assert.ok(a.at(-1).endsWith(ZIM));
  assert.equal(spawn.kids[0].opts.windowsHide, true);
});

test('kiwix: never binds a non-local address', () => {
  assert.throws(() => createKiwix({ exe: 'k', zimDir: 'd', address: '0.0.0.0' }), /127\.0\.0\.1/);
});

test('kiwix: search HTML → [{ title, path, snippet }]', async () => {
  const { k, fetch } = setup();
  const r = await k.search('photosynthesis', 5);
  assert.equal(r.length, 3);
  assert.deepEqual(r[0], { title: 'Photosynthesis', path: '/content/wikipedia_en_all_nopic_2026-10/A/Photosynthesis', snippet: '...Photosynthesis is a system of biological processes by which plants & algae convert light...' });
  assert.equal(r[2].snippet, '');
  const q = fetch.calls.find(u => u.includes('/search?'));
  assert.equal(q, 'http://127.0.0.1:47820/search?books.name=wikipedia_en_all_nopic_2026-10&pattern=photosynthesis&pageLength=5');
  assert.deepEqual(parseSearch('<html>no results</html>'), []);
});

test('kiwix: article fetch only for /content/ paths on the local server', async () => {
  const { k, fetch } = setup();
  const html = await k.article('/content/wikipedia_en_all_nopic_2026-10/A/Photosynthesis');
  assert.match(html, /Article/);
  assert.equal(fetch.calls.at(-1), 'http://127.0.0.1:47820/content/wikipedia_en_all_nopic_2026-10/A/Photosynthesis');
  await assert.rejects(k.article('https://evil.com/x'), /bad article path/);
  await assert.rejects(k.article('/content/../../etc'), /bad article path/);
  const byTitle = await k.articleByTitle('Treaty of Westphalia');
  assert.match(byTitle, /Article/);
  assert.equal(fetch.calls.at(-1), 'http://127.0.0.1:47820/content/wikipedia_en_all_nopic_2026-10/A/Treaty_of_Westphalia');
});

test('kiwix: crash → restarted once, then gives up', async () => {
  const { k, spawn } = setup();
  await k.warm();
  spawn.kids[0].emit('exit', 1);
  await k.search('a');
  assert.equal(spawn.kids.length, 2);
  spawn.kids[1].emit('exit', 1);
  await assert.rejects(k.search('a'), /stopped/i);
  assert.equal(spawn.kids.length, 2);
});

test('kiwix: info reports file, size and article count; close kills', async () => {
  const { k, spawn } = setup();
  await k.warm();
  const i = await k.info();
  assert.equal(i.installed, true);
  assert.equal(i.file, ZIM);
  assert.equal(i.sizeBytes, 51e9);
  assert.equal(i.articles, 6912345);
  assert.equal(i.running, true);
  k.close();
  assert.equal(spawn.kids[0].killed, true);
});
