const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../extension/browser.js');
const SOURCE = fs.readFileSync(path.join(__dirname, '../extension/browser.js'), 'utf8');

// a fake `chrome`: records calls, grants the permissions it is given
function fakeChrome({ granted = [], pageText = 'x', tabs = null } = {}) {
  const calls = [];
  const rec = (name, out) => (...a) => { calls.push([name, ...a]); return Promise.resolve(typeof out === 'function' ? out(...a) : out); };
  const TABS = tabs || [
    { id: 1, windowId: 7, title: 'Docs', url: 'https://docs.example.com/', active: true, pinned: false, audible: false, extra: 'dropped' },
    { id: 2, windowId: 7, title: 'YouTube', url: 'https://www.youtube.com/watch?v=1', active: false, pinned: true, audible: true },
  ];
  return {
    calls,
    permissions: { contains: async q => { calls.push(['contains', q]); return [...(q.permissions || []), ...(q.origins || [])].every(p => granted.includes(p)); } },
    tabs: {
      query: rec('tabs.query', q => (q.active ? [TABS[0]] : TABS)),
      update: rec('tabs.update', (id, p) => ({ ...TABS.find(t => t.id === id), ...p })),
      create: rec('tabs.create', p => ({ id: 99, url: p.url, windowId: 7 })),
      remove: rec('tabs.remove', undefined),
      get: rec('tabs.get', id => TABS.find(t => t.id === id)),
    },
    windows: { update: rec('windows.update', {}) },
    search: { query: rec('search.query', undefined) },
    scripting: { executeScript: rec('scripting.executeScript', () => [{ result: { title: 'T', url: 'https://docs.example.com/', text: pageText } }]) },
    history: { search: rec('history.search', () => [{ id: '1', title: 'Result', url: 'https://r.example.com/', lastVisitTime: 1700000000000, visitCount: 3 }]) },
    bookmarks: { search: rec('bookmarks.search', () => [{ id: '5', title: 'Mark', url: 'https://m.example.com/', parentId: '1' }, { id: '6', title: 'Folder' }]) },
    downloads: { search: rec('downloads.search', () => [{ id: 3, filename: 'C:\\Users\\me\\Downloads\\report.pdf', url: 'https://x.example.com/report.pdf', state: 'complete', totalBytes: 1234, startTime: '2026-11-10T10:00:00.000Z', exists: true }]) },
  };
}

test('browser: unknown command is refused', async () => {
  const { browserCommand } = await load();
  await assert.rejects(browserCommand('browser_eval', { code: '1+1' }, fakeChrome()), /Unknown browser command/);
  await assert.rejects(browserCommand('ytm_play', {}, fakeChrome()), /Unknown browser command/);
  await assert.rejects(browserCommand(undefined, {}, fakeChrome()), /Unknown browser command/);
  await assert.rejects(browserCommand('__proto__', {}, fakeChrome()), /Unknown browser command/);
  await assert.rejects(browserCommand('constructor', {}, fakeChrome()), /Unknown browser command/);
});

test('browser_tabs: needs the optional tabs permission, then only the listed fields', async () => {
  const { browserCommand } = await load();
  await assert.rejects(browserCommand('browser_tabs', {}, fakeChrome()), /permission not granted: tab titles and addresses/);
  const r = await browserCommand('browser_tabs', {}, fakeChrome({ granted: ['tabs'] }));
  assert.deepEqual(r, [
    { id: 1, windowId: 7, title: 'Docs', url: 'https://docs.example.com/', active: true, pinned: false, audible: false },
    { id: 2, windowId: 7, title: 'YouTube', url: 'https://www.youtube.com/watch?v=1', active: false, pinned: true, audible: true },
  ]);
});

test('browser_tab_open: javascript:, file:, chrome:, data: and malformed URLs are refused', async () => {
  const { browserCommand } = await load();
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'file:///C:/Windows/win.ini', 'chrome://settings', 'chrome-extension://abc/x.html', 'data:text/html,<script>1</script>', 'about:blank', 'view-source:https://a.com', 'ftp://a.com/x', 'blob:https://a.com/1', 'not a url', '', '//evil.com', 'https://', ' javascript:alert(1)', 5, null, undefined, 'https://a.com/' + 'x'.repeat(2100)]) {
    const c = fakeChrome();
    await assert.rejects(browserCommand('browser_tab_open', { url }, c), /http|url/i, String(url).slice(0, 40));
    assert.ok(!c.calls.some(x => x[0] === 'tabs.create'), `${String(url).slice(0, 40)} opened a tab`);
  }
  const c = fakeChrome();
  const ok = await browserCommand('browser_tab_open', { url: 'https://example.com/a?b=1' }, c);
  assert.deepEqual(ok, { id: 99, url: 'https://example.com/a?b=1' });
  assert.deepEqual(c.calls.find(x => x[0] === 'tabs.create')[1], { url: 'https://example.com/a?b=1', active: true });
  await browserCommand('browser_tab_open', { url: 'http://localhost:3000/' }, fakeChrome());
});

test('browser_tab_*: non-integer ids are refused', async () => {
  const { browserCommand } = await load();
  for (const cmd of ['browser_tab_switch', 'browser_tab_close', 'browser_tab_pin']) {
    for (const id of [undefined, null, '1', 1.5, -1, 0, NaN, Infinity, {}, [], '1; drop', true]) {
      const c = fakeChrome();
      await assert.rejects(browserCommand(cmd, { id, pinned: true }, c), /id/i, `${cmd} ${String(id)}`);
      assert.ok(!c.calls.some(x => /^tabs\.(update|remove)/.test(x[0])), `${cmd} acted on ${String(id)}`);
    }
  }
  await assert.rejects(browserCommand('browser_tab_pin', { id: 1, pinned: 'yes' }, fakeChrome()), /pinned/);
});

test('browser_tab_switch / close / pin act on the given tab', async () => {
  const { browserCommand } = await load();
  const c = fakeChrome();
  assert.deepEqual(await browserCommand('browser_tab_switch', { id: 2 }, c), { id: 2, title: 'YouTube' });
  assert.deepEqual(c.calls.find(x => x[0] === 'tabs.update'), ['tabs.update', 2, { active: true }]);
  assert.deepEqual(c.calls.find(x => x[0] === 'windows.update'), ['windows.update', 7, { focused: true }]);
  await browserCommand('browser_tab_close', { id: 2 }, c);
  assert.deepEqual(c.calls.find(x => x[0] === 'tabs.remove'), ['tabs.remove', 2]);
  await browserCommand('browser_tab_pin', { id: 1, pinned: true }, c);
  assert.deepEqual(c.calls.filter(x => x[0] === 'tabs.update').at(-1), ['tabs.update', 1, { pinned: true }]);
});

test('browser_search: needs the search permission and a short query', async () => {
  const { browserCommand } = await load();
  await assert.rejects(browserCommand('browser_search', { query: 'cats' }, fakeChrome()), /permission not granted: search/);
  const c = fakeChrome({ granted: ['search'] });
  await browserCommand('browser_search', { query: 'cats' }, c);
  assert.deepEqual(c.calls.find(x => x[0] === 'search.query')[1], { text: 'cats', disposition: 'NEW_TAB' });
  for (const query of ['', '   ', 'x'.repeat(201), 5, undefined]) await assert.rejects(browserCommand('browser_search', { query }, fakeChrome({ granted: ['search'] })), /query/);
});

test('browser_page_text: capped at 12000 chars, quoted fields only, needs all-sites access', async () => {
  const { browserCommand } = await load();
  await assert.rejects(browserCommand('browser_page_text', {}, fakeChrome({ pageText: 'hello' })), /permission not granted: page access/);
  const c = fakeChrome({ granted: ['<all_urls>'], pageText: 'a'.repeat(50000) });
  const r = await browserCommand('browser_page_text', {}, c);
  assert.equal(r.text.length, 12000);
  assert.deepEqual(Object.keys(r).sort(), ['text', 'title', 'url']);
  const exec = c.calls.find(x => x[0] === 'scripting.executeScript')[1];
  assert.deepEqual(exec.target, { tabId: 1 });
  assert.equal(typeof exec.func, 'function');
  assert.equal(exec.args, undefined, 'nothing from JARVIS is passed into the page');
  // a specific tab
  const c2 = fakeChrome({ granted: ['<all_urls>'] });
  await browserCommand('browser_page_text', { id: 2 }, c2);
  assert.deepEqual(c2.calls.find(x => x[0] === 'scripting.executeScript')[1].target, { tabId: 2 });
  await assert.rejects(browserCommand('browser_page_text', { id: 'x' }, fakeChrome({ granted: ['<all_urls>'] })), /id/i);
});

test('browser_page_text: browser pages and the web store cannot be read', async () => {
  const { browserCommand } = await load();
  const tabs = [{ id: 1, windowId: 1, title: 'Settings', url: 'chrome://settings/', active: true }, { id: 2, windowId: 1, title: 'Store', url: 'https://chromewebstore.google.com/x', active: false }, { id: 3, windowId: 1, title: 'F', url: 'file:///C:/x.txt', active: false }];
  for (const id of [1, 2, 3]) {
    const c = fakeChrome({ granted: ['<all_urls>'], tabs });
    await assert.rejects(browserCommand('browser_page_text', { id }, c), /cannot read/i);
    assert.ok(!c.calls.some(x => x[0] === 'scripting.executeScript'));
  }
});

test('browser_history: missing permission returns a plain error', async () => {
  const { browserCommand } = await load();
  const c = fakeChrome();
  await assert.rejects(browserCommand('browser_history', { query: 'x', limit: 5 }, c), e => e.message === 'permission not granted: history');
  assert.ok(!c.calls.some(x => x[0] === 'history.search'), 'the API is not touched without the permission');
  const g = fakeChrome({ granted: ['history'] });
  const r = await browserCommand('browser_history', { query: 'result', limit: 5 }, g);
  assert.deepEqual(r, [{ title: 'Result', url: 'https://r.example.com/', lastVisit: 1700000000000 }]);
  assert.deepEqual(g.calls.find(x => x[0] === 'history.search')[1], { text: 'result', maxResults: 5, startTime: 0 });
});

test('browser_bookmarks and browser_downloads: permissions, limits and cleaned output', async () => {
  const { browserCommand } = await load();
  await assert.rejects(browserCommand('browser_bookmarks', { query: 'm', limit: 5 }, fakeChrome()), /permission not granted: bookmarks/);
  await assert.rejects(browserCommand('browser_downloads', { limit: 5 }, fakeChrome()), /permission not granted: downloads/);
  const c = fakeChrome({ granted: ['bookmarks', 'downloads'] });
  assert.deepEqual(await browserCommand('browser_bookmarks', { query: 'm', limit: 5 }, c), [{ title: 'Mark', url: 'https://m.example.com/' }]);
  const d = await browserCommand('browser_downloads', { limit: 5 }, c);
  assert.deepEqual(d, [{ name: 'report.pdf', url: 'https://x.example.com/report.pdf', state: 'complete', bytes: 1234, startTime: '2026-11-10T10:00:00.000Z' }]);
  assert.deepEqual(c.calls.find(x => x[0] === 'downloads.search')[1], { orderBy: ['-startTime'], limit: 5 });
});

test('browser: limits and queries are validated (1-25, text up to 200)', async () => {
  const { browserCommand } = await load();
  const g = ['history', 'bookmarks', 'downloads'];
  for (const limit of [0, 26, -1, 1.5, '5', NaN]) {
    await assert.rejects(browserCommand('browser_history', { query: 'x', limit }, fakeChrome({ granted: g })), /limit/, String(limit));
    await assert.rejects(browserCommand('browser_downloads', { limit }, fakeChrome({ granted: g })), /limit/, String(limit));
  }
  const c = fakeChrome({ granted: g });
  await browserCommand('browser_history', { query: 'x' }, c);   // default limit
  assert.equal(c.calls.find(x => x[0] === 'history.search')[1].maxResults, 10);
  await assert.rejects(browserCommand('browser_history', { query: 'x'.repeat(201), limit: 3 }, fakeChrome({ granted: g })), /query/);
  await assert.rejects(browserCommand('browser_bookmarks', { query: 5, limit: 3 }, fakeChrome({ granted: g })), /query/);
});

test('browser: no command evaluates a string from JARVIS', () => {
  assert.doesNotMatch(SOURCE, /\beval\s*\(/);
  assert.doesNotMatch(SOURCE, /new\s+Function\b|\bFunction\s*\(/);
  assert.doesNotMatch(SOURCE, /\bcode\s*:/);
  assert.doesNotMatch(SOURCE, /setTimeout\s*\(\s*['"`]/);
  const calls = SOURCE.match(/executeScript\s*\(\s*\{[^}]*\}/g) || [];
  assert.ok(calls.length >= 1);
  for (const c of calls) {
    assert.match(c, /func:\s*readPage\b/, c);
    assert.doesNotMatch(c, /args\s*:|files\s*:/, c);
  }
  // the page function is a fixed one and takes nothing
  assert.match(SOURCE, /function readPage\(\)/);
});

test('extension: manifest only asks for the browser permissions as optional, and the worker routes browser_ commands', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));
  assert.deepEqual([...m.optional_permissions].sort(), ['bookmarks', 'downloads', 'history', 'search', 'tabs']);
  assert.deepEqual(m.optional_host_permissions, ['<all_urls>']);
  for (const p of ['history', 'bookmarks', 'downloads', 'search', 'tabs']) assert.ok(!m.permissions.includes(p), `${p} must not be a required permission`);
  assert.deepEqual(m.host_permissions, ['https://music.youtube.com/*']);
  assert.ok(Number(m.version.split('.')[1]) >= 4, `version ${m.version} was not bumped`);
  const bg = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
  assert.match(bg, /import \{ browserCommand \} from '\.\/browser\.js'/);
  assert.match(bg, /startsWith\('browser_'\)/);
  const popup = fs.readFileSync(path.join(__dirname, '../extension/popup.js'), 'utf8');
  assert.match(popup, /permissions\.request/);
  assert.match(fs.readFileSync(path.join(__dirname, '../extension/popup.html'), 'utf8'), /Browser control/);
});
