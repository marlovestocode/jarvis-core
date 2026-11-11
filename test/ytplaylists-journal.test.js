// The YouTube Music undo journal on the cortex (W2 §2, plan E10): append-only, undo = newest entry not undone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cortexOn } = require('./helpers/cortex');
const { createJournalStore, memoryJournal, importYtmUndo } = require('../src/core/media/ytjournal');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jjournal-'));
const entry = (id, o = {}) => ({ id, at: 1_000_000 + id, undone: false, playlistId: 'PLgym', playlistTitle: 'Gym', items: [{ videoId: 'v' + id, setVideoId: 's' + id }], ...o });

test('ytjournal: append, markUndone and a reopen give the same newest-not-undone', () => {
  const d = dir();
  const s = createJournalStore({ cortex: cortexOn(d) });
  s.append(entry(1)); s.append(entry(2));
  s.markUndone(entry(2));
  const again = createJournalStore({ cortex: cortexOn(d) }).load();
  assert.deepEqual(again.map(e => [e.id, e.undone]), [[1, false], [2, true]]);
  assert.equal([...again].reverse().find(e => !e.undone).id, 1);
});

test('ytjournal: an imported entry marked undone stays undone', () => {
  const s = createJournalStore({ cortex: cortexOn() });
  s.append(entry(1, { undone: true }));
  assert.equal(s.load()[0].undone, true);
});

test('ytjournal: only the newest 20 entries are loaded (undoable)', () => {
  const s = createJournalStore({ cortex: cortexOn() });
  for (let i = 1; i <= 25; i++) s.append(entry(i));
  const l = s.load();
  assert.equal(l.length, 20); assert.equal(l[0].id, 6); assert.equal(l.at(-1).id, 25);
});

test('ytjournal: the in-memory default keeps nothing across instances', () => {
  const m = memoryJournal();
  m.append(entry(1));
  assert.deepEqual(memoryJournal().load(), []);
});

test('ytjournal: import of ytm-undo.json is one transaction, idempotent, renamed', () => {
  const d = dir();
  const file = path.join(d, 'ytm-undo.json');
  fs.writeFileSync(file, JSON.stringify([entry(1, { undone: true }), entry(2)]));
  const c = cortexOn(d);
  assert.deepEqual(importYtmUndo({ cortex: c, file }), { imported: 2 });
  assert.ok(fs.existsSync(file + '.imported.bak')); assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, JSON.stringify([entry(3)]));
  assert.equal(importYtmUndo({ cortex: c, file }).already, true);
  assert.deepEqual(createJournalStore({ cortex: c }).load().map(e => [e.id, e.undone]), [[1, true], [2, false]]);
  const bad = path.join(dir(), 'ytm-undo.json');
  fs.writeFileSync(bad, '{not json');
  assert.deepEqual(importYtmUndo({ cortex: cortexOn(path.dirname(bad)), file: bad }), { imported: 0, broken: true });
});

test('ytjournal: ytplaylists reads the journal on first use, not when built (the cortex opens later in main.js)', async () => {
  const { createYtPlaylists } = require('../src/core/media/ytplaylists');
  let reads = 0;
  const journal = { load: () => { reads++; return [entry(7)]; }, append() {}, markUndone() {} };
  const link = { connected: true, info: { version: '1.2.0' }, async request(cmd) { if (cmd === 'playlist') return { id: 'PLgym', editable: true, tracks: [] }; return { playlists: [] }; } };
  const svc = createYtPlaylists({ link, journal, sleep: async () => {} });
  assert.equal(reads, 0);
  assert.equal((await svc.undo()).status, 'gone');
  assert.equal(reads, 1);
});
