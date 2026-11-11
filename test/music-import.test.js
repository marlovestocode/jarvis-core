// One-time import of music-plays.jsonl (W2 §5, plan E5): sliced, resumable, idempotent, then renamed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cortexOn } = require('./helpers/cortex');
const { createPlayLog } = require('../src/core/music/log');
const { createMusicImport } = require('../src/core/music/import');
const { trackKey } = require('../src/core/music/adapter');
const { makePlays } = require('./fixtures/music-plays');

const LATER = () => Date.UTC(2030, 0, 1);
function world({ plays = makePlays(), extra = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmimport-'));
  const file = path.join(dir, 'music-plays.jsonl');
  fs.writeFileSync(file, plays.map(p => JSON.stringify(p)).join('\n') + '\n' + extra);
  const cortex = cortexOn(dir);
  const playLog = createPlayLog({ cortex, now: LATER });
  const imp = (o = {}) => createMusicImport({ cortex, file, playLog, now: LATER, ...o });
  return { dir, file, cortex, playLog, plays, imp };
}
const run = im => { let r; for (let i = 0; i < 10000; i++) { r = im.step({ deadlineMs: 50 }); if (r.done) return r; } throw new Error('never done'); };

test('music-import: imports every valid line, skips and counts malformed ones, renames the file', () => {
  const w = world({ extra: 'not json\n{"videoId":"!!"}\n{"torn' });
  const r = run(w.imp());
  assert.equal(r.imported, w.plays.length);
  assert.equal(r.bad, 3);
  assert.equal(w.cortex.event.count({ kind: 'play' }), w.plays.length);
  assert.equal(fs.existsSync(w.file), false);
  assert.ok(fs.existsSync(w.file + '.imported.bak'));
  assert.ok(w.cortex.meta.get('import_music'));
});

test('music-import: next edges are rebuilt as a live replay builds them', () => {
  const plays = makePlays().slice(0, 200);
  const live = world({ plays });
  for (const p of [...plays].sort((a, b) => a.at - b.at)) live.playLog.add({ ...p, startedAt: p.at, listenedMs: p.listenedSec * 1000, duration: p.durationSec, like: p.liked === true ? 'LIKE' : p.liked === false ? 'DISLIKE' : null });
  const w = world({ plays: [...plays].sort((a, b) => a.at - b.at) });
  run(w.imp());
  const edges = c => plays.map(p => c.node.find({ kind: 'track', key: trackKey(p.videoId) }).id).flatMap(id => c.neighbors(id, { types: ['next'], limit: 50 }).map(n => `${id}>${n.id}:${n.weight.toFixed(4)}`)).sort();
  const textOf = (c, key) => c.node.find({ kind: 'track', key }).text;
  assert.ok(edges(w.cortex).length > 10);
  assert.equal(textOf(w.cortex, trackKey(plays[0].videoId)), textOf(live.cortex, trackKey(plays[0].videoId)));
  assert.deepEqual(edges(w.cortex).length, edges(live.cortex).length);
});

test('music-import: idempotent — a second run imports nothing', () => {
  const w = world();
  run(w.imp());
  fs.writeFileSync(w.file, fs.readFileSync(w.file + '.imported.bak'));   // the file is back (restored by hand)
  const r = run(w.imp());
  assert.equal(r.imported, 0);
  assert.equal(w.cortex.event.count({ kind: 'play' }), w.plays.length);
});

test('music-import: a quit mid-import resumes at the saved offset with no duplicates; the rename waits for the end', () => {
  const w = world();
  const first = w.imp({ chunkLines: 100 });
  const r1 = first.step({ deadlineMs: 0 });
  assert.equal(r1.done, false);
  assert.ok(fs.existsSync(w.file));
  const stored = w.cortex.event.count({ kind: 'play' });
  assert.ok(stored > 0 && stored < w.plays.length);
  const r = run(w.imp({ chunkLines: 100 }));   // a new boot
  assert.equal(r.done, true);
  assert.equal(w.cortex.event.count({ kind: 'play' }), w.plays.length);
  assert.equal(fs.existsSync(w.file), false);
});

test('music-import: marker present and file still there → rename only', () => {
  const w = world();
  w.cortex.meta.set('import_music', '1');
  const r = run(w.imp());
  assert.equal(r.imported, 0);
  assert.equal(w.cortex.event.count({ kind: 'play' }), 0);
  assert.ok(fs.existsSync(w.file + '.imported.bak'));
});

test('music-import: no file → done at once', () => {
  const w = world();
  fs.rmSync(w.file);
  assert.equal(w.imp().step({ deadlineMs: 50 }).done, true);
});

test('music-import: a step with a zero deadline does one chunk at most', () => {
  const w = world();
  const r = w.imp({ chunkLines: 50 }).step({ deadlineMs: 0 });
  assert.ok(r.imported <= 50 && r.imported >= 1, String(r.imported));
  assert.ok(r.pct < 100 && !r.done);
});

test('music-import: playLog.importing is on until done, then all() has the imported plays', () => {
  const w = world();
  assert.equal(w.playLog.all().length, 0);
  const im = w.imp({ chunkLines: 100 });
  im.step({ deadlineMs: 0 });
  assert.equal(w.playLog.importing.active, true);
  run(im);
  assert.equal(w.playLog.importing.active, false);
  assert.equal(w.playLog.all().length, w.plays.length);
});

test('music-import: a line the cortex refuses is counted bad; the import still finishes', () => {
  const plays = makePlays().slice(0, 50);
  plays[10] = { ...plays[10], album: 'x'.repeat(5000) };   // passes the shape check, too big for the cortex
  const w = world({ plays });
  const r = run(w.imp({ chunkLines: 20 }));
  assert.equal(r.done, true);
  assert.equal(r.bad, 1);
  assert.equal(r.imported, 49);
  assert.equal(fs.existsSync(w.file), false);
});
