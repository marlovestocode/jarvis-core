// The PC-action log and its undo on the cortex (W2 §2, §3, plan E4, E9).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cortexOn } = require('./helpers/cortex');
const { createActionLog, importActionsLog } = require('../src/core/pc/actions-log');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jacts-'));
const move = (from, to) => ({ what: 'move_files', args: {}, result: 'Moved 1 file.', ok: true, undo: [{ from, to }] });

test('actions-adapter: undo parity across a reopen — newest successful move not yet undone', () => {
  const d = dir();
  let c = cortexOn(d);
  const a = createActionLog({ cortex: c });
  const m1 = a.write(move('A', 'B'));
  const m2 = a.write(move('C', 'D'));
  assert.match(m1.id, /^a[0-9a-z]+$/); assert.equal(typeof m1.at, 'string');
  c.close(); c = cortexOn(d);
  const b = createActionLog({ cortex: c });
  assert.equal(b.lastUndoable().id, m2.id);
  b.write({ what: 'undo_last', args: {}, result: 'ok', ok: true, undid: m2.id });
  assert.equal(b.lastUndoable().id, m1.id);
  assert.deepEqual(b.lastUndoable().undo, [{ from: 'A', to: 'B' }]);
  assert.deepEqual(b.list().map(e => e.what), ['move_files', 'move_files', 'undo_last']);
});

test('actions-adapter: failed entries and entries with no undo are never undoable', () => {
  const a = createActionLog({ cortex: cortexOn() });
  a.write({ ...move('A', 'B'), ok: false });
  a.write({ what: 'focus', args: {}, result: 'ok', ok: true });
  assert.equal(a.lastUndoable(), null);
});

test('actions-adapter: retention keeps the newest 5,000 plus an old undoable move', () => {
  const c = cortexOn();
  const a = createActionLog({ cortex: c });
  const first = a.write(move('A', 'B')).id;
  c.transaction(() => { for (let i = 0; i < 5100; i++) a.write({ what: 'focus', args: { i }, result: 'ok', ok: true }); });
  assert.equal(a.prune(), 100);
  assert.equal(a.stats().entries, 5001);
  assert.equal(a.stats().cap, 5000);
  assert.equal(a.lastUndoable().id, first);
});

test('actions-adapter: a move links the destination file node to its folder; the event points at the file', () => {
  const c = cortexOn();
  const a = createActionLog({ cortex: c });
  a.write(move('C:\\Users\\u\\Downloads\\a.pdf', 'C:\\Users\\u\\Documents\\a.pdf'));
  const f = c.node.find({ kind: 'file', key: 'path:c:\\users\\u\\documents\\a.pdf' });
  const folder = c.node.find({ kind: 'folder', key: 'path:c:\\users\\u\\documents' });
  assert.ok(f && folder);
  assert.equal(c.neighbors(f.id, { types: ['touched'] })[0].id, folder.id);
  assert.equal(c.event.query({ kind: 'action' })[0].nodeId, f.id);
});

test('actions-adapter: an action with 21 paths makes 20 file nodes', () => {
  const c = cortexOn();
  const a = createActionLog({ cortex: c });
  a.write({ what: 'move_files', args: {}, result: 'x', ok: true, undo: Array.from({ length: 21 }, (_, i) => ({ from: `C:\\a\\${i}.txt`, to: `C:\\b\\${i}.txt` })) });
  assert.equal(c.node.list({ kind: 'file', limit: 100 }).length, 20);
});

test('actions-adapter: a file named like a secret is stored and undoable (Review Focus 3)', () => {
  const a = createActionLog({ cortex: cortexOn() });
  const m = a.write(move('C:\\Users\\u\\Desktop\\secret 1234567890123.pdf', 'C:\\Users\\u\\Documents\\password 1234567890123.pdf'));
  assert.equal(a.lastUndoable().id, m.id);
});

test('actions-adapter: import keeps undo/undid, skips a broken line, is idempotent and renames the file', () => {
  const d = dir();
  const file = path.join(d, 'actions.log');
  const e1 = { id: 'a1', at: '2026-11-01T10:00:00.000Z', what: 'move_files', args: {}, result: 'Moved', ok: true, undo: [{ from: 'A', to: 'B' }] };
  const e2 = { id: 'a2', at: '2026-11-01T11:00:00.000Z', what: 'move_files', args: {}, result: 'Moved', ok: true, undo: [{ from: 'C', to: 'D' }] };
  const e3 = { id: 'a3', at: '2026-11-01T12:00:00.000Z', what: 'undo_last', args: {}, result: 'ok', ok: true, undid: 'a2' };
  fs.writeFileSync(file, [e1, e2, e3].map(e => JSON.stringify(e)).join('\n') + '\nnot json\n');
  const c = cortexOn(d);
  assert.deepEqual(importActionsLog({ cortex: c, file }), { imported: 3, bad: 1 });
  assert.equal(fs.existsSync(file), false); assert.ok(fs.existsSync(file + '.imported.bak'));
  const a = createActionLog({ cortex: c });
  assert.equal(a.lastUndoable().id, 'a1');
  assert.equal(c.event.query({ kind: 'action' })[0].at, Date.parse(e1.at));
  fs.writeFileSync(file, JSON.stringify(e1) + '\n');
  assert.equal(importActionsLog({ cortex: c, file }).already, true);
  assert.equal(a.list().length, 3);
});
