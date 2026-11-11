// The wave 2 wiring (plan E17, E18): music, actions, journal and tool history on a lazily opened cortex.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cortexOn } = require('./helpers/cortex');
const { createHistorySystem } = require('../src/core/history/system');
const { makePlays } = require('./fixtures/music-plays');

function dataDir({ plays = makePlays() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jhist-'));
  fs.writeFileSync(path.join(dir, 'music-plays.jsonl'), plays.map(p => JSON.stringify(p)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'actions.log'), JSON.stringify({ id: 'a1', at: '2026-11-01T10:00:00.000Z', what: 'move_files', args: {}, result: 'Moved', ok: true, undo: [{ from: 'A', to: 'B' }] }) + '\n');
  fs.writeFileSync(path.join(dir, 'ytm-undo.json'), JSON.stringify([{ id: 1, at: 5, undone: false, playlistId: 'PLa', items: [] }]));
  return dir;
}

test('history: built before the cortex exists; the first use opens it', () => {
  let cortex = null, asked = 0;
  const h = createHistorySystem({ getCortex: () => { asked++; return cortex; }, dataDir: dataDir() });
  assert.equal(asked, 0);
  cortex = cortexOn();
  assert.equal(h.playLog.count(), 0);
  assert.ok(asked > 0);
});

test('history: start imports all three files over several slices, renames them, then music is complete', async () => {
  const dir = dataDir();
  const cortex = cortexOn(dir);
  const h = createHistorySystem({ getCortex: () => cortex, dataDir: dir, sliceMs: 1, chunkLines: 50 });
  h.start();
  assert.equal(h.playLog.importing.active, true);
  await h.imported;
  assert.equal(h.playLog.importing.active, false);
  assert.equal(h.playLog.all().length, makePlays().length);
  assert.equal(h.actionLog.lastUndoable().id, 'a1');
  assert.equal(h.journal.load().length, 1);
  for (const f of ['music-plays.jsonl', 'actions.log', 'ytm-undo.json']) {
    assert.equal(fs.existsSync(path.join(dir, f)), false, f);
    assert.ok(fs.existsSync(path.join(dir, f + '.imported.bak')), f);
  }
  assert.match(h.check().detail, new RegExp(`imported ${makePlays().length} plays, 1 action, 1 playlist edit`));
  h.stop();
});

test('history: stop() mid-import stops the slices; the next start resumes', async () => {
  const dir = dataDir();
  const cortex = cortexOn(dir);
  const h = createHistorySystem({ getCortex: () => cortex, dataDir: dir, sliceMs: 0, chunkLines: 20 });
  h.start();
  h.stop();
  await new Promise(r => setTimeout(r, 30));
  const n = cortex.event.count({ kind: 'play' });
  assert.ok(n < makePlays().length);
  assert.ok(fs.existsSync(path.join(dir, 'music-plays.jsonl')));
  const again = createHistorySystem({ getCortex: () => cortex, dataDir: dir, sliceMs: 5 });
  again.start();
  await again.imported;
  assert.equal(cortex.event.count({ kind: 'play' }), makePlays().length);
  again.stop();
});

test('history: check says importing with a percent, and ok after', async () => {
  const dir = dataDir();
  const cortex = cortexOn(dir);
  const h = createHistorySystem({ getCortex: () => cortex, dataDir: dir, sliceMs: 0, chunkLines: 20 });
  h.start();
  assert.match(h.check().detail, /importing music \d+%/);
  await h.imported;
  assert.equal(h.check().level, 'ok');
  assert.match(h.check().detail, /plays, \d+ actions?, \d+ tool calls/);
  h.stop();
});

test('history: retention runs after the imports', async () => {
  const dir = dataDir({ plays: makePlays().slice(0, 5) });
  const cortex = cortexOn(dir);
  cortex.event.add({ kind: 'tool', payload: { name: 'old', ok: true, ms: 1, args: {} }, at: 1000 });
  const h = createHistorySystem({ getCortex: () => cortex, dataDir: dir });
  h.start();
  await h.imported;
  assert.equal(cortex.event.count({ kind: 'tool' }), 0);
  h.stop();
});

test('history: a cortex that cannot open makes check() a problem, not a throw', () => {
  const h = createHistorySystem({ getCortex: () => { throw new Error('no db'); }, dataDir: dataDir() });
  assert.equal(h.check().level, 'bad');
});
