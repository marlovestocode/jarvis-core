const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTimerStore } = require('../src/core/timers/store');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jtim-'));
const item = (o = {}) => ({ kind: 'timer', label: 'pasta', due: 1e12, created: 1e12 - 600e3, ...o });

test('timer store: add persists and a new store sees it (restart)', () => {
  const file = path.join(tmpDir(), 'timers.json');
  const s = createTimerStore({ file });
  const t = s.add(item());
  assert.match(t.id, /^t/);
  const again = createTimerStore({ file });
  assert.deepEqual(again.list(), [t]);
  assert.deepEqual(again.get(t.id), t);
});

test('timer store: remove deletes from disk', () => {
  const file = path.join(tmpDir(), 'timers.json');
  const s = createTimerStore({ file });
  const a = s.add(item()), b = s.add(item({ label: 'tea' }));
  assert.notEqual(a.id, b.id);
  assert.equal(s.remove(a.id), true);
  assert.equal(s.remove(a.id), false);
  assert.deepEqual(createTimerStore({ file }).list().map(t => t.label), ['tea']);
});

test('timer store: corrupt file moved to broken/ and store starts empty', () => {
  const dir = tmpDir(), file = path.join(dir, 'timers.json');
  fs.writeFileSync(file, '{oops');
  const logs = [];
  const s = createTimerStore({ file, log: m => logs.push(m) });
  assert.deepEqual(s.list(), []);
  assert.equal(fs.readFileSync(path.join(dir, 'broken', 'timers.json'), 'utf8'), '{oops');
  assert.equal(fs.existsSync(file), false);
  assert.ok(logs.length);
});

test('timer store: bad entries dropped', () => {
  const file = path.join(tmpDir(), 'timers.json');
  fs.writeFileSync(file, JSON.stringify({ timers: [{ id: 't1', kind: 'timer', label: 'x' }, { id: 't2', kind: 'nope', due: 5 }, { id: 't3', kind: 'alarm', label: '', due: 5, created: 1 }] }));
  assert.deepEqual(createTimerStore({ file }).list().map(t => t.id), ['t3']);
});

test('timer store: atomic write leaves no .tmp and add throws when it cannot save', () => {
  const dir = tmpDir(), file = path.join(dir, 'timers.json');
  createTimerStore({ file }).add(item());
  assert.deepEqual(fs.readdirSync(dir), ['timers.json']);
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'a file, not a folder');
  const s = createTimerStore({ file: path.join(blocked, 'timers.json') });
  assert.throws(() => s.add(item()), /could not save/i);
  assert.deepEqual(s.list(), []);
});
