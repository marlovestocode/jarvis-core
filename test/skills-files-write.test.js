const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGroup } = require('../src/core/skills/files');
const { createPcTools } = require('../src/core/tools/pc');
const { writeZip, readZip, listZip } = require('../src/core/tools/zip');
const { createToolRunner } = require('../src/core/tools/registry');
const { createConfirm } = require('../src/core/pc/confirm');
const { createActionLog } = require('../src/core/pc/actions-log');
const { NEEDS_OK } = require('../src/core/brain/guard');
const { createFakePcHost } = require('./helpers/fake-pc-host');

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jsfw-'));
  const roots = ['Desktop', 'Documents', 'Downloads', 'Projects'].map(n => { const p = path.join(base, n); fs.mkdirSync(p); return p; });
  const binDir = path.join(base, 'bin'); fs.mkdirSync(binDir);
  const host = createFakePcHost({ binDir });
  const actionLog = createActionLog({ file: path.join(base, 'actions.log') });
  const confirm = createConfirm({ actionLog });
  const pc = { host, roots, confirm, actionLog, getAllowlist: async () => [], waitMs: 50, pollMs: 5 };
  const group = createGroup({ pc });
  const tools = [...group.tools, ...createPcTools(pc)];
  const runner = createToolRunner(tools);
  const ctx = { turn: { tainted: false } };
  const run = (name, args, c = ctx) => runner.run(name, args, c);
  const yes = async () => (await confirm.handle('yes'))?.reply ?? null;
  const p = rel => path.join(base, rel);
  const put = (rel, content = 'x') => { fs.mkdirSync(path.dirname(p(rel)), { recursive: true }); fs.writeFileSync(p(rel), content); return p(rel); };
  const names = rel => fs.readdirSync(p(rel)).sort();
  const lines = () => actionLog.list().length;
  return { base, roots, host, group, tools, runner, run, yes, p, put, names, lines, actionLog, confirm, binDir };
}
const asked = r => { assert.ok(r.ok && r.text.startsWith(NEEDS_OK), r.text); return r.text.slice(NEEDS_OK.length); };

test('files group: writer tools, risk tags, schemas, and the new undo_last description', () => {
  const { group, tools } = setup();
  const by = Object.fromEntries(group.tools.map(t => [t.name, t]));
  for (const n of ['rename_files', 'organize_by_type', 'zip_files', 'unzip', 'copy_files', 'make_folder']) assert.ok(by[n], n);
  assert.deepEqual(['rename_files', 'organize_by_type'].map(n => by[n].risk), ['confirm', 'confirm']);
  assert.deepEqual(['zip_files', 'unzip', 'copy_files', 'make_folder'].map(n => by[n].risk), ['safe', 'safe', 'safe', 'safe']);
  assert.ok(group.tools.every(t => t.params.additionalProperties === false));
  const undo = tools.find(t => t.name === 'undo_last');
  assert.equal(undo.description, 'Undo the last file change JARVIS made (moved, renamed, copied, zipped, unzipped or created): puts files back or sends new ones to the Recycle Bin. Asks the user first.');
});

// ---- zip primitives ----
test('zip: writeZip and readZip round-trip, listZip reports sizes, damaged input fails plainly', () => {
  const buf = writeZip([{ name: 'a.txt', data: Buffer.from('hello hello hello') }, { name: 'dir/', data: Buffer.alloc(0) }, { name: 'dir/b.bin', data: Buffer.from([1, 2, 3]) }]);
  const entries = readZip(buf);
  assert.deepEqual(entries.map(e => e.name), ['a.txt', 'dir/', 'dir/b.bin']);
  assert.equal(entries[0].data.toString(), 'hello hello hello');
  assert.deepEqual([...entries[2].data], [1, 2, 3]);
  assert.deepEqual(listZip(buf).map(e => e.size), [17, 0, 3]);
  assert.throws(() => readZip(Buffer.from('not a zip at all, just some bytes here')), /not a zip/);
  assert.throws(() => readZip(buf.subarray(0, buf.length - 10)), /not a zip|damaged/);
});

// ---- rename_files ----
test('rename_files: confirm question shows the pairs; nothing moves until yes', async () => {
  const { run, yes, put, names, lines } = setup();
  for (const n of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt']) put(`Documents/${n}`);
  const q = asked(await run('rename_files', { from: 'Documents/*.txt', pattern: { prefix: 'old-' } }));
  assert.match(q, /Rename 7 files/);
  assert.match(q, /a\.txt → old-a\.txt/);
  assert.match(q, /e\.txt → old-e\.txt/);
  assert.doesNotMatch(q, /f\.txt → old-f/);
  assert.match(q, /and 2 more/);
  assert.deepEqual(names('Documents'), ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt']);
  assert.equal(lines(), 0);
  assert.match(await yes(), /Renamed 7 files/);
  assert.deepEqual(names('Documents'), ['old-a.txt', 'old-b.txt', 'old-c.txt', 'old-d.txt', 'old-e.txt', 'old-f.txt', 'old-g.txt']);
  assert.equal(lines(), 1);
});

test('rename_files: find/replace, suffix and numbering keep the extension', async () => {
  const { run, yes, put, names } = setup();
  put('Documents/IMG_1.jpg'); put('Documents/IMG_2.jpg');
  asked(await run('rename_files', { from: 'Documents/*.jpg', pattern: { find: 'IMG_', replace: 'holiday ', suffix: ' (web)', number: true } }));
  await yes();
  assert.deepEqual(names('Documents'), ['holiday 1 (web)-1.jpg', 'holiday 2 (web)-2.jpg']);
});

test('rename_files: reserved and invalid names are refused', async () => {
  const { run, put, names } = setup();
  put('Documents/file.txt'); put('Documents/readme');
  const bad = [
    { find: 'file', replace: 'NUL' }, { find: 'file', replace: 'con' }, { find: 'file', replace: 'COM1' }, { find: 'file', replace: 'lpt9' },
    { find: 'file', replace: 'a:b' }, { find: 'file', replace: 'a?b' }, { find: 'file', replace: 'a|b' }, { find: 'file', replace: 'a<b' },
    { find: 'file', replace: 'a/b' }, { find: 'file', replace: 'a\\b' }, { find: 'file', replace: 'x'.repeat(201) }, { find: 'file', replace: '' },
  ];
  for (const pattern of bad) {
    const r = await run('rename_files', { from: 'Documents/file.txt', pattern });
    assert.equal(r.ok, false, JSON.stringify(pattern).slice(0, 60));
    assert.match(r.text, /not a name Windows allows|too long|Nothing would change/, JSON.stringify(pattern).slice(0, 60));
  }
  for (const pattern of [{ suffix: '.' }, { suffix: ' ' }]) {
    const r = await run('rename_files', { from: 'Documents/readme', pattern });
    assert.equal(r.ok, false, JSON.stringify(pattern));
    assert.match(r.text, /not a name Windows allows/);
  }
  assert.deepEqual(names('Documents'), ['file.txt', 'readme']);
});

test('rename_files: case-only rename works and collisions get freeName', async () => {
  const { run, yes, put, names } = setup();
  put('Documents/Report.TXT', 'r');
  asked(await run('rename_files', { from: 'Documents/Report.TXT', pattern: { find: 'Report', replace: 'report' } }));
  await yes();
  assert.deepEqual(names('Documents'), ['report.TXT']);
  put('Downloads/a.txt', 'A'); put('Downloads/b.txt', 'B');
  asked(await run('rename_files', { from: 'Downloads/b.txt', pattern: { find: 'b', replace: 'a' } }));
  const out = await yes();
  assert.match(out, /Renamed 1 file/);
  assert.deepEqual(names('Downloads'), ['a (2).txt', 'a.txt']);
});

test('rename_files: outside the roots, folders and no-ops are refused; tainted turns cannot start it', async () => {
  const { run, put, p } = setup();
  put('Elsewhere/x.txt');
  put('Documents/a.txt');
  fs.mkdirSync(p('Documents/folder'));
  assert.equal((await run('rename_files', { from: p('Elsewhere/x.txt'), pattern: { prefix: 'a' } })).ok, false);
  assert.match((await run('rename_files', { from: 'Documents/folder', pattern: { prefix: 'a' } })).text, /folder|files/);
  assert.match((await run('rename_files', { from: 'Documents/a.txt', pattern: { find: 'zzz', replace: 'y' } })).text, /Nothing would change/);
  assert.match((await run('rename_files', { from: 'Documents/a.txt', pattern: {} })).text, /Say how to rename/);
  const t = await run('rename_files', { from: 'Documents/a.txt', pattern: { prefix: 'x' } }, { turn: { tainted: true } });
  assert.match(t.text, /won't start that from text I read/);
});

// ---- organize_by_type ----
test('organize_by_type: only top-level files, subfolders created, undone by undo_last', async () => {
  const { run, yes, put, names, p, lines } = setup();
  put('Downloads/photo.JPG'); put('Downloads/report.pdf'); put('Downloads/song.mp3'); put('Downloads/clip.mp4'); put('Downloads/data.zip'); put('Downloads/setup.exe'); put('Downloads/.hidden');
  put('Downloads/keep/nested.pdf');
  const q = asked(await run('organize_by_type', { folder: 'Downloads' }));
  assert.match(q, /Sort 6 files in Downloads into Images, Documents, Archives, Audio, Video and Other/);
  assert.deepEqual(names('Downloads'), ['.hidden', 'clip.mp4', 'data.zip', 'keep', 'photo.JPG', 'report.pdf', 'setup.exe', 'song.mp3']);
  assert.match(await yes(), /Sorted 6 files/);
  assert.deepEqual(names('Downloads'), ['.hidden', 'Archives', 'Audio', 'Documents', 'Images', 'Other', 'Video', 'keep']);
  assert.deepEqual(names('Downloads/Images'), ['photo.JPG']);
  assert.deepEqual(names('Downloads/Other'), ['setup.exe']);
  assert.ok(fs.existsSync(p('Downloads/keep/nested.pdf')), 'nested files are untouched');
  assert.equal(lines(), 1);
  asked(await run('undo_last', {}));
  assert.match(await yes(), /back/);
  assert.deepEqual(names('Downloads'), ['.hidden', 'clip.mp4', 'data.zip', 'keep', 'photo.JPG', 'report.pdf', 'setup.exe', 'song.mp3']);
});

test('organize_by_type: nothing to sort, too many items, outside roots, tainted', async () => {
  const { run, put, p } = setup();
  assert.match((await run('organize_by_type', { folder: 'Downloads' })).text, /No loose files/);
  for (let i = 0; i < 201; i++) fs.writeFileSync(p(`Desktop/f${i}.txt`), 'x');
  assert.match((await run('organize_by_type', { folder: 'Desktop' })).text, /at most 200/);
  put('Elsewhere/a.txt');
  assert.equal((await run('organize_by_type', { folder: p('Elsewhere') })).ok, false);
  put('Documents/a.txt');
  assert.match((await run('organize_by_type', { folder: 'Documents' }, { turn: { tainted: true } })).text, /won't start that from text I read/);
});

// ---- zip / unzip ----
test('zip_files + unzip round-trip', async () => {
  const { run, put, names, p, lines } = setup();
  put('Documents/proj/a.txt', 'alpha'); put('Documents/proj/sub/b.txt', 'beta'); put('Documents/notes.txt', 'notes');
  const z = await run('zip_files', { paths: ['Documents/proj', 'Documents/notes.txt'] });
  assert.equal(z.ok, true, z.text);
  assert.match(z.text, /Zipped 2 items into Documents\\Archive\.zip/);
  assert.equal(lines(), 1);
  const entries = readZip(fs.readFileSync(p('Documents/Archive.zip')));
  assert.deepEqual(entries.map(e => e.name).sort(), ['notes.txt', 'proj/', 'proj/a.txt', 'proj/sub/', 'proj/sub/b.txt']);
  const u = await run('unzip', { path: 'Documents/Archive.zip' });
  assert.equal(u.ok, true, u.text);
  assert.match(u.text, /Unzipped 3 files into Documents\\Archive/);
  assert.equal(fs.readFileSync(p('Documents/Archive/proj/sub/b.txt'), 'utf8'), 'beta');
  assert.equal(fs.readFileSync(p('Documents/Archive/notes.txt'), 'utf8'), 'notes');
  assert.equal(lines(), 2);
  // never overwrites: zipping again and unzipping again take new names
  await run('zip_files', { paths: ['Documents/proj', 'Documents/notes.txt'] });
  await run('unzip', { path: 'Documents/Archive.zip' });
  assert.deepEqual(names('Documents').filter(n => /Archive/.test(n)), ['Archive (2)', 'Archive (2).zip', 'Archive', 'Archive.zip'].sort());
});

test('zip_files: a single folder is named after it, an explicit .zip name is honoured and never overwritten', async () => {
  const { run, put, names } = setup();
  put('Documents/proj/a.txt');
  assert.match((await run('zip_files', { paths: 'Documents/proj' })).text, /proj\.zip/);
  assert.match((await run('zip_files', { paths: 'Documents/proj', to: 'Downloads/backup.zip' })).text, /Downloads\\backup\.zip/);
  assert.match((await run('zip_files', { paths: 'Documents/proj', to: 'Downloads/backup.zip' })).text, /backup \(2\)\.zip/);
  assert.deepEqual(names('Downloads'), ['backup (2).zip', 'backup.zip']);
  assert.match((await run('zip_files', { paths: 'Documents/proj', to: 'Downloads/backup.exe' })).text, /\.zip/);
  assert.equal((await run('zip_files', { paths: 'Documents/proj', to: 'C:\\Windows\\x.zip' })).ok, false);
  assert.equal((await run('zip_files', { paths: [] })).ok, false);
  assert.equal((await run('zip_files', { paths: 'Documents/missing' })).ok, false);
});

test('unzip: zip-slip entries (.., absolute, drive letters) are refused and nothing is written', async () => {
  const { run, put, names, p, base } = setup();
  for (const bad of ['../evil.txt', '..\\evil.txt', '/abs.txt', '\\abs.txt', 'C:\\x.txt', 'C:x.txt', 'a/../../b.txt', 'ok/../../c.txt', 'a/b.txt::$DATA', 'nul.txt\0x', 'dir/./../../d.txt']) {
    fs.writeFileSync(p('Documents/evil.zip'), writeZip([{ name: 'fine.txt', data: Buffer.from('ok') }, { name: bad, data: Buffer.from('pwn') }]));
    const r = await run('unzip', { path: 'Documents/evil.zip' });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.text, /unsafe|refus/i, JSON.stringify(bad));
    assert.deepEqual(names('Documents'), ['evil.zip'], `nothing written for ${JSON.stringify(bad)}`);
  }
  assert.ok(!fs.existsSync(path.join(base, 'evil.txt')) && !fs.existsSync(path.join(base, 'abs.txt')));
  put('Documents/other.txt');
});

test('unzip: too many entries or over 500 MB expanded is refused', async () => {
  const { run, p, names } = setup();
  const many = writeZip(Array.from({ length: 10001 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.alloc(0) })));
  fs.writeFileSync(p('Documents/many.zip'), many);
  const a = await run('unzip', { path: 'Documents/many.zip' });
  assert.equal(a.ok, false);
  assert.match(a.text, /10001 entries|at most 10000/);
  // a header that claims more than 500 MB once expanded
  const buf = writeZip([{ name: 'big.bin', data: Buffer.from('tiny') }]);
  const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buf.writeUInt32LE(600 * 1024 * 1024, cd + 24);
  fs.writeFileSync(p('Documents/bomb.zip'), buf);
  const b = await run('unzip', { path: 'Documents/bomb.zip' });
  assert.equal(b.ok, false);
  assert.match(b.text, /more than 500 MB/);
  assert.deepEqual(names('Documents'), ['bomb.zip', 'many.zip']);
});

test('unzip: only zip files inside the roots; a bad archive says so', async () => {
  const { run, put, p } = setup();
  put('Documents/notzip.zip', 'plain text');
  assert.match((await run('unzip', { path: 'Documents/notzip.zip' })).text, /not a zip/);
  put('Documents/a.txt');
  assert.match((await run('unzip', { path: 'Documents/a.txt' })).text, /\.zip/);
  assert.equal((await run('unzip', { path: 'C:\\Windows\\x.zip' })).ok, false);
  fs.writeFileSync(p('Documents/ok.zip'), writeZip([{ name: 'a.txt', data: Buffer.from('a') }]));
  assert.equal((await run('unzip', { path: 'Documents/ok.zip', to: 'Elsewhere\\out' })).ok, false);
  const r = await run('unzip', { path: 'Documents/ok.zip', to: 'Downloads/unpacked' });
  assert.match(r.text, /Downloads\\unpacked/);
  assert.equal(fs.readFileSync(p('Downloads/unpacked/a.txt'), 'utf8'), 'a');
});

// ---- copy_files / make_folder ----
test('copy_files: never overwrites', async () => {
  const { run, put, names, p, lines } = setup();
  put('Documents/a.txt', 'one'); put('Documents/b.txt', 'two'); put('Downloads/a.txt', 'already here');
  const r = await run('copy_files', { from: ['Documents/a.txt', 'Documents/b.txt'], to: 'Downloads' });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /Copied 2 files to Downloads/);
  assert.deepEqual(names('Downloads'), ['a (2).txt', 'a.txt', 'b.txt']);
  assert.equal(fs.readFileSync(p('Downloads/a.txt'), 'utf8'), 'already here');
  assert.equal(fs.readFileSync(p('Downloads/a (2).txt'), 'utf8'), 'one');
  assert.ok(fs.existsSync(p('Documents/a.txt')), 'the originals stay');
  assert.equal(lines(), 1);
  const missing = await run('copy_files', { from: 'Documents/none.txt', to: 'Downloads' });
  assert.equal(missing.ok, false);
  assert.equal((await run('copy_files', { from: 'Documents/a.txt', to: 'C:\\Windows' })).ok, false);
  fs.mkdirSync(p('Documents/dir'));
  assert.match((await run('copy_files', { from: 'Documents/dir', to: 'Downloads' })).text, /files, not folders/);
});

test('copy_files: a pattern, a new destination folder, and the 200 limit', async () => {
  const { run, put, names, p } = setup();
  put('Documents/a.pdf'); put('Documents/b.pdf'); put('Documents/c.txt');
  const r = await run('copy_files', { from: 'Documents/*.pdf', to: 'Downloads/copies' });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(names('Downloads/copies'), ['a.pdf', 'b.pdf']);
  for (let i = 0; i < 201; i++) fs.writeFileSync(p(`Desktop/f${i}.txt`), 'x');
  assert.match((await run('copy_files', { from: 'Desktop/*.txt', to: 'Projects' })).text, /at most 200/);
});

test('make_folder: creates inside the roots, reports an existing one, journals what it made', async () => {
  const { run, p, lines, actionLog } = setup();
  const r = await run('make_folder', { path: 'Documents/Taxes/2026' });
  assert.equal(r.ok, true, r.text);
  assert.ok(fs.statSync(p('Documents/Taxes/2026')).isDirectory());
  assert.match(r.text, /Created Documents\\Taxes\\2026/);
  assert.equal(lines(), 1);
  assert.deepEqual(actionLog.list()[0].undo.map(u => path.basename(u.created)), ['Taxes', '2026']);
  assert.match((await run('make_folder', { path: 'Documents/Taxes' })).text, /already exists/);
  assert.equal((await run('make_folder', { path: 'C:\\Windows\\New' })).ok, false);
  assert.match((await run('make_folder', { path: 'Documents' })).text, /already exists|root/);
  assert.equal((await run('make_folder', { path: 'Documents/bad:name' })).ok, false);
});

// ---- undo_last for created items ----
test('undo_last: removes files created by copy, zip, unzip and make_folder', async () => {
  const { run, yes, put, names, p, binDir } = setup();
  put('Documents/a.txt', 'one');
  // copy
  await run('copy_files', { from: 'Documents/a.txt', to: 'Downloads' });
  assert.match(asked(await run('undo_last', {})), /Send 1 new item to the Recycle Bin/);
  assert.match(await yes(), /Removed 1 item/);
  assert.deepEqual(names('Downloads'), []);
  assert.equal(fs.readdirSync(binDir).length, 1);
  // zip
  await run('zip_files', { paths: 'Documents/a.txt' });
  asked(await run('undo_last', {})); await yes();
  assert.deepEqual(names('Documents'), ['a.txt']);
  // unzip: files and the new folder both go
  fs.writeFileSync(p('Documents/pack.zip'), writeZip([{ name: 'x/y.txt', data: Buffer.from('y') }, { name: 'z.txt', data: Buffer.from('z') }]));
  await run('unzip', { path: 'Documents/pack.zip' });
  assert.ok(fs.existsSync(p('Documents/pack/x/y.txt')));
  asked(await run('undo_last', {}));
  assert.match(await yes(), /Removed 4 items/);
  assert.deepEqual(names('Documents'), ['a.txt', 'pack.zip']);
  // make_folder
  await run('make_folder', { path: 'Documents/New/Deep' });
  asked(await run('undo_last', {})); await yes();
  assert.deepEqual(names('Documents'), ['a.txt', 'pack.zip']);
});

test('undo_last: leaves a created file the user changed or already removed, and says so', async () => {
  const { run, yes, put, names, p } = setup();
  put('Documents/a.txt', 'one'); put('Documents/b.txt', 'two');
  await run('copy_files', { from: ['Documents/a.txt', 'Documents/b.txt'], to: 'Downloads' });
  fs.writeFileSync(p('Downloads/a.txt'), 'I edited this copy by hand');
  fs.unlinkSync(p('Downloads/b.txt'));
  asked(await run('undo_last', {}));
  const out = await yes();
  assert.match(out, /a\.txt/);
  assert.match(out, /changed since/);
  assert.match(out, /b\.txt is already gone/);
  assert.deepEqual(names('Downloads'), ['a.txt'], 'the edited copy stays');
});

test('undo_last: a created folder that is no longer empty stays', async () => {
  const { run, yes, put, names } = setup();
  await run('make_folder', { path: 'Documents/Keep' });
  put('Documents/Keep/mine.txt', 'mine');
  asked(await run('undo_last', {}));
  const out = await yes();
  assert.match(out, /Keep is not empty/);
  assert.deepEqual(names('Documents'), ['Keep']);
});

test('undo_last: a rename is undone by moving back, and the old text for moves is unchanged', async () => {
  const { run, yes, put, names } = setup();
  put('Documents/a.txt'); put('Documents/b.txt');
  asked(await run('rename_files', { from: 'Documents/*.txt', pattern: { prefix: 'x-' } })); await yes();
  assert.match(asked(await run('undo_last', {})), /^Move 2 files back to Documents/);
  await yes();
  assert.deepEqual(names('Documents'), ['a.txt', 'b.txt']);
});

// ---- cross-cutting ----
test('files writers: tainted turn cannot start the confirm ones', async () => {
  const { run, put, host, names } = setup();
  put('Documents/a.txt');
  const t = { turn: { tainted: true } };
  for (const [n, a] of [['rename_files', { from: 'Documents/a.txt', pattern: { prefix: 'x' } }], ['organize_by_type', { folder: 'Documents' }]]) {
    const r = await run(n, a, t);
    assert.equal(r.ok, false, n);
    assert.match(r.text, /won't start that from text I read/);
  }
  assert.deepEqual(names('Documents'), ['a.txt']);
  assert.ok(!host.calls.some(c => c[0] === 'recycle'));
});

test('every writer writes one action-log line', async () => {
  const { run, yes, put, p, lines } = setup();
  put('Documents/a.txt'); put('Downloads/s.mp3');
  let n = lines();
  const step = async (fn, label) => { await fn(); assert.equal(lines(), ++n, label); };
  await step(() => run('make_folder', { path: 'Documents/New' }), 'make_folder');
  await step(() => run('copy_files', { from: 'Documents/a.txt', to: 'Documents/New' }), 'copy_files');
  await step(() => run('zip_files', { paths: 'Documents/a.txt' }), 'zip_files');
  await step(() => run('unzip', { path: 'Documents/a.zip' }), 'unzip');
  await step(async () => { asked(await run('rename_files', { from: 'Documents/a.txt', pattern: { prefix: 'r-' } })); await yes(); }, 'rename_files');
  await step(async () => { asked(await run('organize_by_type', { folder: 'Downloads' })); await yes(); }, 'organize_by_type');
  const log = fs.readFileSync(p('actions.log'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.map(e => e.what), ['make_folder', 'copy_files', 'zip_files', 'unzip', 'rename_files', 'organize_by_type']);
  assert.ok(log.every(e => e.ok && Array.isArray(e.undo) && e.undo.length));
});

test('files writers: a failed or refused call writes no log line', async () => {
  const { run, lines } = setup();
  await run('copy_files', { from: 'Documents/none.txt', to: 'Downloads' });
  await run('make_folder', { path: 'C:\\Windows\\X' });
  await run('zip_files', { paths: 'Documents/none' });
  await run('unzip', { path: 'Documents/none.zip' });
  assert.equal(lines(), 0);
});
