const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildAllowlist, resolveApp } = require('../src/core/pc/apps');
const { safePath, defaultRoots, rootNames } = require('../src/core/pc/paths');

const START = [
  { name: 'Google Chrome', appId: 'Chrome' },
  { name: 'Spotify', appId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
  { name: 'Visual Studio Code', appId: '{6D809377}\\Microsoft VS Code\\Code.exe' },
  { name: 'Visual Studio Code - Insiders', appId: '{6D809377}\\Microsoft VS Code Insiders\\Code - Insiders.exe' },
  { name: 'Notepad', appId: '{1AC14E77}\\notepad.exe' },
];

test('apps: allowlist from Start menu plus the user map; bad user entries dropped', () => {
  const list = buildAllowlist(START, { obs: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe', bad: 'notepad.exe && calc', rel: 'tools\\x.exe', nl: 'C:\\a.exe\nC:\\b.exe' });
  assert.equal(list.length, 6);
  assert.deepEqual(list[0], { name: 'obs', target: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe', source: 'user' });
  assert.ok(list.slice(1).every(e => e.source === 'start'));
});

test('apps: free text that is not on the allowlist is refused', () => {
  const list = buildAllowlist(START, {});
  for (const t of ['cmd.exe /c del C:\\', 'C:\\Windows\\System32\\calc.exe', 'powershell -enc AAAA', 'regedit', '']) assert.equal(resolveApp(t, list), null, t);
});

test('apps: fuzzy match picks the right app, says when it is ambiguous', () => {
  const list = buildAllowlist(START, {});
  assert.equal(resolveApp('chrome', list).entry.name, 'Google Chrome');
  assert.equal(resolveApp('the spotify app', list).entry.name, 'Spotify');
  assert.equal(resolveApp('Notepad', list).entry.target, '{1AC14E77}\\notepad.exe');
  const amb = resolveApp('code', list);
  assert.deepEqual(amb.ambiguous.map(e => e.name), ['Visual Studio Code', 'Visual Studio Code - Insiders']);
  assert.equal(resolveApp('visual studio code', list).entry.name, 'Visual Studio Code');
});

test('apps: the user map wins on an exact name', () => {
  const list = buildAllowlist(START, { spotify: 'C:\\Users\\me\\AppData\\Roaming\\Spotify\\Spotify.exe' });
  assert.equal(resolveApp('Spotify', list).entry.source, 'user');
});

const HOME = 'C:\\Users\\me';
const ROOTS = defaultRoots(HOME);
const real = (map = {}) => p => {
  // like the OS: a path under a link resolves through the link
  const k = Object.keys(map).find(x => p.toLowerCase() === x.toLowerCase() || p.toLowerCase().startsWith(x.toLowerCase() + '\\'));
  if (k) return map[k] + p.slice(k.length);
  if (p.toLowerCase().startsWith(HOME.toLowerCase()) || /^C:\\?$/i.test(p) || /^C:\\Users\\?$/i.test(p)) return p;
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};

test('paths: default roots and names', () => {
  assert.deepEqual(ROOTS, ['C:\\Users\\me\\Desktop', 'C:\\Users\\me\\Documents', 'C:\\Users\\me\\Downloads', 'C:\\Users\\me\\Projects']);
  assert.deepEqual(rootNames(ROOTS), ['Desktop', 'Documents', 'Downloads', 'Projects']);
});

test('paths: allowed paths resolve; root names work as shortcuts', () => {
  const o = { realpath: real() };
  assert.equal(safePath('C:\\Users\\me\\Documents\\notes.txt', ROOTS, o), 'C:\\Users\\me\\Documents\\notes.txt');
  assert.equal(safePath('c:/users/ME/downloads/a b/x.pdf', ROOTS, o), 'c:\\users\\ME\\downloads\\a b\\x.pdf');
  assert.equal(safePath('Downloads\\x.pdf', ROOTS, o), 'C:\\Users\\me\\Downloads\\x.pdf');
  assert.equal(safePath('documents/Sorted', ROOTS, o), 'C:\\Users\\me\\Documents\\Sorted');
  assert.equal(safePath('Desktop', ROOTS, o), 'C:\\Users\\me\\Desktop');
});

test('paths: traversal, UNC, device, drive-relative and other folders are refused', () => {
  const o = { realpath: real() };
  for (const p of ['C:\\Users\\me\\Documents\\..\\..\\..\\Windows\\System32', 'Documents\\..\\AppData\\Roaming', '\\\\server\\share\\x', '\\\\?\\C:\\Windows', '\\\\.\\PhysicalDrive0', 'C:Documents\\x', 'C:\\Windows\\win.ini', 'C:\\Users\\me\\AppData\\x', 'C:\\Users\\me\\DocumentsEvil\\x', 'random\\x.txt', '', 'a\0b']) {
    assert.throws(() => safePath(p, ROOTS, o), /Not allowed|Say which folder/, JSON.stringify(p));
  }
});

test('paths: a junction or symlink that leads outside the roots is refused, also for a new file under it', () => {
  const o = { realpath: real({ 'C:\\Users\\me\\Downloads\\link': 'C:\\Windows' }) };
  assert.throws(() => safePath('C:\\Users\\me\\Downloads\\link', ROOTS, o), /Not allowed/);
  assert.throws(() => safePath('C:\\Users\\me\\Downloads\\link\\new.txt', ROOTS, o), /Not allowed/);
});

test('paths: real junction on disk is caught (no fake)', { skip: process.platform !== 'win32' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jpath-'));
  const root = path.join(base, 'Downloads'), outside = path.join(base, 'Secret');
  fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'jump'), 'junction');
  assert.throws(() => safePath(path.join(root, 'jump', 'x.txt'), [root]), /Not allowed/);
  fs.writeFileSync(path.join(root, 'ok.txt'), 'x');
  assert.equal(safePath(path.join(root, 'ok.txt'), [root]), path.join(root, 'ok.txt'));
});

test('config: pc.apps keeps only clean entries', () => {
  const { loadConfig, DEFAULTS } = require('../src/core/config');
  assert.deepEqual(DEFAULTS.pc, { apps: {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpc-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ pc: { apps: { obs: 'C:\\obs\\obs64.exe', bad: 'calc && x', n: 5 } } }));
  assert.deepEqual(loadConfig(dir).pc.apps, { obs: 'C:\\obs\\obs64.exe' });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ pc: { apps: ['x'] } }));
  assert.deepEqual(loadConfig(dir).pc.apps, {});
});
