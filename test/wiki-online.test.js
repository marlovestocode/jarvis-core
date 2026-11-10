const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeNet } = require('./helpers/fakenet');
const { searchWikiOnline, summaryOnline, lookupOnline, articleHtmlOnline } = require('../src/core/knowledge/wiki-online');

const ROUTES = [
  [/rest\.php\/v1\/search\/page\?q=photosynthesis&limit=5$/, 'wiki-search.json'],
  [/rest\.php\/v1\/search\/page\?q=/, '{"pages":[]}'],
  [/rest_v1\/page\/summary\/Photosynthesis$/, 'wiki-summary.json'],
  [/rest_v1\/page\/summary\/Mercury$/, 'wiki-summary-disambig.json'],
  [/rest_v1\/page\/summary\//, () => new Response('{"type":"not_found"}', { status: 404 })],
  [/rest_v1\/page\/html\/Photosynthesis$/, '<html><body><section><p>Plants make sugar.</p></section></body></html>'],
];

test('wiki online: search → titles and plain snippets', async () => {
  const n = fakeNet(ROUTES);
  const r = await searchWikiOnline(n.fetcher, 'photosynthesis');
  assert.equal(r[0].title, 'Photosynthesis');
  assert.match(r[0].snippet, /^Photosynthesis is a system/);
  assert.ok(!/<span/.test(r[0].snippet));
  assert.equal(r.length, 5);
});

test('wiki online: summary with url and updated time', async () => {
  const n = fakeNet(ROUTES);
  const s = await summaryOnline(n.fetcher, 'Photosynthesis');
  assert.equal(s.title, 'Photosynthesis');
  assert.equal(s.url, 'https://en.wikipedia.org/wiki/Photosynthesis');
  assert.equal(s.updated, '2026-11-01T19:09:13Z');
  assert.match(s.extract, /^Photosynthesis is a system/);
  assert.equal(s.disambiguation, false);
});

test('wiki online: disambiguation pages flagged', async () => {
  const n = fakeNet(ROUTES);
  const s = await summaryOnline(n.fetcher, 'Mercury');
  assert.equal(s.disambiguation, true);
});

test('wiki online: missing page → null', async () => {
  const n = fakeNet(ROUTES);
  assert.equal(await summaryOnline(n.fetcher, 'Nopenope Page'), null);
});

test('wiki online: lookup = search → best title → summary; nothing found → null', async () => {
  const n = fakeNet(ROUTES);
  const s = await lookupOnline(n.fetcher, 'photosynthesis');
  assert.equal(s.title, 'Photosynthesis');
  assert.equal(await lookupOnline(n.fetcher, 'qqzzxx'), null);
});

test('wiki online: titles are path-encoded; cached 7 days', async () => {
  const n = fakeNet(ROUTES);
  await summaryOnline(n.fetcher, 'Treaty of Westphalia');
  assert.ok(n.calls.at(-1).endsWith('/page/summary/Treaty_of_Westphalia'));
  await summaryOnline(n.fetcher, 'Photosynthesis');
  const before = n.calls.length;
  n.clock.t += 6 * 86400000;
  await summaryOnline(n.fetcher, 'Photosynthesis');
  assert.equal(n.calls.length, before);
  n.clock.t += 2 * 86400000;
  await summaryOnline(n.fetcher, 'Photosynthesis');
  assert.equal(n.calls.length, before + 1);
});

test('wiki online: article html for read_article', async () => {
  const n = fakeNet(ROUTES);
  const h = await articleHtmlOnline(n.fetcher, 'Photosynthesis');
  assert.match(h.html, /Plants make sugar/);
});
