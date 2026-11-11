const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPcTools } = require('../src/core/tools/pc');
const { createConfirm } = require('../src/core/pc/confirm');
const { createActionLog } = require('../src/core/pc/actions-log');
const { cortexOn } = require('./helpers/cortex');
const { buildAllowlist } = require('../src/core/pc/apps');
const { createToolRunner } = require('../src/core/tools/registry');
const { NEEDS_OK } = require('../src/core/brain/guard');
const { createFakePcHost } = require('./helpers/fake-pc-host');

const START = [
  { name: 'Spotify', appId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
  { name: 'Visual Studio Code', appId: '{6D809377}\\Microsoft VS Code\\Code.exe' },
  { name: 'Visual Studio Code - Insiders', appId: '{6D809377}\\Microsoft VS Code Insiders\\Code - Insiders.exe' },
  { name: 'Notepad', appId: '{1AC14E77}\\notepad.exe' },
];

function setup({ host: hostOpts = {}, media } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jpct-'));
  const roots = ['Desktop', 'Documents', 'Downloads', 'Projects'].map(d => path.join(base, d));
  roots.forEach(r => fs.mkdirSync(r));
  const binDir = path.join(base, 'bin'); fs.mkdirSync(binDir);
  const host = createFakePcHost({ binDir, ...hostOpts });
  const actionLog = createActionLog({ cortex: cortexOn(path.join(base, 'actions.log')) });
  const confirm = createConfirm({ actionLog });
  const tools = createPcTools({ host, getAllowlist: async () => buildAllowlist(START, {}), roots, confirm, actionLog, media, waitMs: 50, pollMs: 5 });
  const by = Object.fromEntries(tools.map(t => [t.name, t]));
  const runner = createToolRunner(tools);
  const ctx = { turn: { tainted: false } };
  const run = async (name, args) => { const r = await runner.run(name, args, ctx); return r.text; };
  const yes = async () => (await confirm.handle('yes'))?.reply ?? null;
  const file = (rel, text = 'x') => { const p = path.join(base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  return { base, roots, host, actionLog, confirm, tools, by, run, yes, file, binDir };
}
const asked = text => { assert.ok(text.startsWith(NEEDS_OK), text); return text.slice(NEEDS_OK.length); };

test('pc tools: names, risk tags and strict schemas', () => {
  const { tools } = setup();
  assert.deepEqual(tools.map(t => t.name), ['open_app', 'close_app', 'focus_window', 'list_windows', 'find_files', 'open_path', 'move_files', 'delete_to_recycle_bin', 'undo_last', 'set_system_volume', 'lock_screen', 'power']);
  const risk = Object.fromEntries(tools.map(t => [t.name, t.risk]));
  assert.deepEqual(Object.entries(risk).filter(([, r]) => r === 'confirm').map(([n]) => n), ['close_app', 'move_files', 'delete_to_recycle_bin', 'undo_last', 'power']);
  for (const t of tools) {
    assert.ok(['safe', 'confirm'].includes(t.risk), t.name);
    assert.equal(t.params.additionalProperties, false, t.name);
    assert.ok(t.description.length < 220, t.name);
  }
});

test('open_app: opens an allowlisted app and checks a window appeared', async () => {
  const { run, host } = setup({ host: { opens: { 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify': { app: 'Spotify', title: 'Spotify Premium' } } } });
  assert.equal(await run('open_app', { name: 'spotify' }), 'Opened Spotify.');
  assert.deepEqual(host.calls.find(c => c[0] === 'launch'), ['launch', 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify']);
});

test('open_app: free text off the allowlist is refused and nothing is launched', async () => {
  const { run, host } = setup();
  for (const name of ['cmd.exe /c del C:\\', 'C:\\Windows\\System32\\calc.exe', 'notepad.exe C:\\x', 'regedit']) {
    assert.match(await run('open_app', { name }), /^Error: .*not an app I can open/, name);
  }
  assert.equal(host.calls.filter(c => c[0] === 'launch').length, 0);
});

test('open_app: ambiguous asks which; no window means an honest failure', async () => {
  const { run } = setup();
  assert.match(await run('open_app', { name: 'code' }), /Which one: Visual Studio Code or Visual Studio Code - Insiders\?/);
  assert.equal(await run('open_app', { name: 'notepad' }), 'Error: I started Notepad but cannot see it running');
});

test('close_app: asks first; yes closes gracefully and checks it is gone', async () => {
  const { run, yes, host } = setup({ host: { windows: [{ hwnd: 1, pid: 11, app: 'Spotify', title: 'Spotify Premium' }] } });
  assert.equal(asked(await run('close_app', { name: 'spotify' })), 'Close Spotify. Say yes to confirm.');
  assert.equal(host.calls.filter(c => c[0] === 'closeMain').length, 0);
  assert.equal(await yes(), 'Closed Spotify.');
  assert.deepEqual(host.calls.filter(c => c[0] === 'closeMain'), [['closeMain', 11]]);
});

test('close_app: still open after a graceful close needs a second yes to force', async () => {
  const { run, yes, host } = setup({ host: { windows: [{ hwnd: 1, pid: 11, app: 'notepad', title: 'notes.txt - Notepad' }], stubborn: [11] } });
  asked(await run('close_app', { name: 'notepad' }));
  assert.equal(await yes(), 'Notepad is still open, maybe asking to save. Force close it? Unsaved work will be lost. Say yes to confirm.');
  assert.equal(host.calls.filter(c => c[0] === 'kill').length, 0);
  assert.equal(await yes(), 'Force closed Notepad.');
  assert.deepEqual(host.calls.filter(c => c[0] === 'kill'), [['kill', 11]]);
});

test('close_app: not open, or a protected app, is refused', async () => {
  const { run } = setup({ host: { windows: [{ hwnd: 2, pid: 22, app: 'explorer', title: 'Downloads' }] } });
  assert.match(await run('close_app', { name: 'spotify' }), /^Error: Spotify is not open/);
  assert.match(await run('close_app', { name: 'explorer' }), /^Error: I won't close explorer/);
});

test('focus_window and list_windows', async () => {
  const { run, host } = setup({ host: { windows: [{ hwnd: 1, pid: 11, app: 'chrome', title: 'YouTube - Google Chrome' }, { hwnd: 2, pid: 12, app: 'Code', title: 'main.js - jarvis-core - Visual Studio Code' }] } });
  assert.equal(await run('focus_window', { app: 'chrome' }), 'Switched to YouTube - Google Chrome.');
  assert.deepEqual(host.calls.filter(c => c[0] === 'focus'), [['focus', 1]]);
  assert.equal(await run('focus_window', { title: 'jarvis-core' }), 'Switched to main.js - jarvis-core - Visual Studio Code.');
  assert.match(await run('focus_window', { title: 'excel' }), /^Error: No open window matches "excel"/);
  assert.match(await run('focus_window', {}), /^Error: Say which window/);
  assert.equal(await run('list_windows', {}), 'Open windows: chrome: YouTube - Google Chrome; Code: main.js - jarvis-core - Visual Studio Code.');
});

test('focus_window: Windows refusing the focus is reported', async () => {
  const { run } = setup({ host: { windows: [{ hwnd: 1, pid: 11, app: 'chrome', title: 'YouTube' }], focusOk: false } });
  assert.match(await run('focus_window', { app: 'chrome' }), /^Error: Windows did not let me bring/);
});

test('find_files: searches only the roots, read-only, at most 10', async () => {
  const { run, file, base } = setup();
  for (let i = 0; i < 14; i++) file(`Downloads/report ${i}.pdf`);
  file('Documents/Taxes/tax report 2025.pdf');
  file('Outside/report secret.pdf');
  const r = await run('find_files', { query: 'report' });
  assert.match(r, /^Found 10 or more/);
  assert.equal(r.split('; ').length, 10);
  assert.doesNotMatch(r, /Outside/);
  assert.match(await run('find_files', { query: 'tax report', folder: 'Documents' }), /tax report 2025\.pdf/);
  assert.match(await run('find_files', { query: '*.pdf', folder: path.join(base, 'Outside') }), /^Error: Not allowed/);
  assert.match(await run('find_files', { query: 'zzz' }), /^No files match "zzz"/);
});

test('find_files: does not follow junctions out of the roots', { skip: process.platform !== 'win32' }, async () => {
  const { run, file, base, roots } = setup();
  file('Outside/hidden plan.txt');
  fs.symlinkSync(path.join(base, 'Outside'), path.join(roots[2], 'jump'), 'junction');
  assert.match(await run('find_files', { query: 'hidden plan' }), /^No files match/);
});

test('open_path: opens files in the roots, never programs or paths outside', async () => {
  const { run, host, file, base } = setup();
  const doc = file('Documents/notes.txt');
  assert.equal(await run('open_path', { path: doc }), 'Asked Windows to open notes.txt.');
  assert.deepEqual(host.calls.filter(c => c[0] === 'launch'), [['launch', doc]]);
  file('Downloads/setup.exe');
  for (const p of ['Downloads/setup.exe', 'Downloads\\..\\..\\x']) assert.match(await run('open_path', { path: p }), /^Error: (I won't open program files|Not allowed)/, p);
  assert.match(await run('open_path', { path: path.join(base, 'Downloads', 'missing.txt') }), /^Error: Not found/);
  assert.equal(host.calls.filter(c => c[0] === 'launch').length, 1);
});

test('move_files: asks first, moves on yes, never overwrites, logs, and undo_last moves back', async () => {
  const { run, yes, file, base, actionLog } = setup();
  const a = file('Downloads/a.pdf', 'A'), b = file('Downloads/b.pdf', 'B');
  file('Documents/Sorted/a.pdf', 'OLD');
  const q = asked(await run('move_files', { from: 'Downloads/*.pdf', to: 'Documents/Sorted' }));
  assert.equal(q, 'Move a.pdf and b.pdf from Downloads to Documents\\Sorted. Say yes to confirm.');
  assert.ok(fs.existsSync(a) && fs.existsSync(b));
  assert.equal(await yes(), 'Moved 2 files to Documents\\Sorted.');
  assert.ok(!fs.existsSync(a) && !fs.existsSync(b));
  assert.equal(fs.readFileSync(path.join(base, 'Documents/Sorted/a.pdf'), 'utf8'), 'OLD');
  assert.equal(fs.readFileSync(path.join(base, 'Documents/Sorted/a (2).pdf'), 'utf8'), 'A');
  assert.equal(actionLog.list().filter(e => e.what === 'move_files').length, 1);

  assert.equal(asked(await run('undo_last', {})), 'Move 2 files back to Downloads. Say yes to confirm.');
  assert.equal(await yes(), 'Moved 2 files back.');
  assert.equal(fs.readFileSync(a, 'utf8'), 'A');
  assert.equal(fs.readFileSync(b, 'utf8'), 'B');
  assert.match(await run('undo_last', {}), /^Error: There is no move to undo/);
});

test('move_files: refuses roots, outside paths, nothing to move and more than 200', async () => {
  const { run, file, base } = setup();
  file('Downloads/x.txt');
  assert.match(await run('move_files', { from: 'Downloads', to: 'Documents' }), /^Error: I won't move the whole Downloads folder/);
  assert.match(await run('move_files', { from: path.join(base, 'elsewhere.txt'), to: 'Documents' }), /^Error: Not allowed/);
  assert.match(await run('move_files', { from: 'Downloads/x.txt', to: 'C:\\Windows' }), /^Error: Not allowed/);
  assert.match(await run('move_files', { from: 'Downloads/*.zip', to: 'Documents' }), /^Error: No files match/);
  for (let i = 0; i < 201; i++) file(`Downloads/many/f${i}.log`);
  assert.match(await run('move_files', { from: 'Downloads/many/*.log', to: 'Documents' }), /^Error: That is 201 files/);
});

test('move_files: a turn with untrusted text cannot ask', async () => {
  const { tools, file } = setup();
  file('Downloads/a.pdf');
  const runner = createToolRunner(tools);
  assert.match((await runner.run('move_files', { from: 'Downloads/a.pdf', to: 'Documents' }, { turn: { tainted: true } })).text, /won't start that/);
});

test('delete_to_recycle_bin: asks first, then uses the Recycle Bin and checks the file is gone', async () => {
  const { run, yes, host, file, binDir } = setup();
  const p = file('Desktop/old.txt');
  assert.equal(asked(await run('delete_to_recycle_bin', { paths: ['Desktop/old.txt'] })), 'Move old.txt to the Recycle Bin. Say yes to confirm.');
  assert.ok(fs.existsSync(p));
  assert.equal(await yes(), 'Moved 1 item to the Recycle Bin.');
  assert.ok(!fs.existsSync(p));
  assert.deepEqual(host.calls.filter(c => c[0] === 'recycle'), [['recycle', p]]);
  assert.equal(fs.readdirSync(binDir).length, 1);
  assert.match(await run('delete_to_recycle_bin', { paths: ['Documents'] }), /^Error: I won't remove the whole Documents folder/);
});

test('set_system_volume: sets and reads back; lock_screen; power asks and "no" cancels', async () => {
  let vol = 0.3;
  const media = { async act(c) { vol = c.set; return { ok: true }; }, async state() { return { system: { volume: vol }, sessions: [] }; } };
  const { run, host, confirm } = setup({ media });
  assert.equal(await run('set_system_volume', { percent: 40 }), 'System volume is 40%.');
  assert.match(await run('set_system_volume', { percent: 140 }), /^Error: Volume is 0 to 100/);
  assert.equal(await run('lock_screen', {}), 'Locked the PC.');
  assert.equal(asked(await run('power', { mode: 'shutdown' })), 'Shut down the PC now. Say yes to confirm.');
  assert.equal((await confirm.handle('no')).reply, 'Cancelled.');
  assert.equal(host.calls.filter(c => c[0] === 'power').length, 0);
});

test('static: tool code never deletes permanently, edits the registry, or imports Electron', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const src = path.join(__dirname, '../src/core');
  for (const f of [...walk(path.join(src, 'pc')), ...walk(path.join(src, 'tools'))]) {
    const t = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /\b(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(|Remove-Item|Set-ItemProperty|New-ItemProperty|\breg(?:\.exe)?\s+(?:add|delete)|HKLM:|HKCU:/i, f);
  }
  for (const f of walk(src).filter(f => f.endsWith('.js'))) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /require\(\s*['"]electron['"]\s*\)/, f);
});

test('review #1: Windows erasing instead of recycling is reported, never called "Recycle Bin"', async () => {
  const { run, yes, host, file } = setup();
  host.recycle = async p => { fs.renameSync(p, p + '.gone'); fs.unlinkSync(p + '.gone'); return { gone: true, inBin: false }; };
  file('Desktop/huge.iso');
  asked(await run('delete_to_recycle_bin', { paths: ['Desktop/huge.iso'] }));
  assert.match(await yes(), /^That did not work: .*huge\.iso.*deleted it permanently/);
});

test('review #1: the host script lets Windows ask before a permanent delete', () => {
  const ps = fs.readFileSync(path.join(__dirname, '../src/core/pc/pc-host.ps1'), 'utf8');
  assert.doesNotMatch(ps, /OnlyErrorDialogs/);
  assert.match(ps, /AllDialogs/);
  assert.match(ps, /Namespace\(10\)/);
});

test('review #3: close_app matches the app process, not words in other window titles', async () => {
  const { run, yes, host } = setup({ host: { windows: [
    { hwnd: 1, pid: 11, app: 'chrome', title: 'Code review - Google Chrome' },
    { hwnd: 2, pid: 12, app: 'Code', title: 'main.js - jarvis-core - Visual Studio Code' },
  ] } });
  assert.equal(asked(await run('close_app', { name: 'code' })), 'Close Code. Say yes to confirm.');
  await yes();
  assert.deepEqual(host.calls.filter(c => c[0] === 'closeMain'), [['closeMain', 12]]);
});

test('review #3: close_app by full name finds the app by its exe, still not the Chrome tab', async () => {
  const { run, yes, host } = setup({ host: { windows: [
    { hwnd: 1, pid: 11, app: 'chrome', title: 'Code review - Google Chrome' },
    { hwnd: 2, pid: 12, app: 'Code', title: 'main.js - jarvis-core - Visual Studio Code' },
  ] } });
  assert.equal(asked(await run('close_app', { name: 'Visual Studio Code' })), 'Close Visual Studio Code. Say yes to confirm.');
  await yes();
  assert.deepEqual(host.calls.filter(c => c[0] === 'closeMain'), [['closeMain', 12]]);
});

test('review #5: alternate data stream paths are refused', async () => {
  const { run, file } = setup();
  file('Downloads/evil.exe');
  assert.match(await run('open_path', { path: 'Downloads/evil.exe::$DATA' }), /^Error: Not allowed/);
  assert.match(await run('open_path', { path: 'Downloads/evil.exe:x' }), /^Error: Not allowed/);
});
