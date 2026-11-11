const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open } = require('../src/core/cortex');
const { importTimersJson } = require('../src/core/timers/import');
const { createCortexTimerStore } = require('../src/core/timers/cortex-store');
const { createScheduler } = require('../src/core/timers/scheduler');
const { createBus } = require('../src/core/bus');

const T0 = Date.UTC(2026, 10, 11, 9, 0);
const TIMERS = [
  { id: 'tabc1', kind: 'alarm', label: 'wake', due: T0 - 3600e3, created: T0 - 86400e3 },
  { id: 'tabc2', kind: 'reminder', label: 'call mum', due: T0 + 7200e3, created: T0 - 600e3 },
  { id: 'tbad', kind: 'nope', due: 5 },
];
function setup(content = JSON.stringify({ timers: TIMERS })) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jtimp-'));
  const file = path.join(dir, 'timers.json');
  if (content !== null) fs.writeFileSync(file, content);
  return { dir, file, cortex: open({ now: () => T0 }) };
}

test('timer import: timers.json becomes pending reminder nodes with the same ids; the file is renamed', () => {
  const { dir, file, cortex } = setup();
  assert.deepEqual(importTimersJson({ cortex, file, now: () => T0 }), { imported: 2, skipped: 1 });
  const store = createCortexTimerStore({ cortex, now: () => T0 });
  assert.deepEqual(store.list().map(t => t.id).sort(), ['tabc1', 'tabc2']);
  assert.deepEqual(store.get('tabc2'), { id: 'tabc2', kind: 'reminder', label: 'call mum', due: T0 + 7200e3, created: T0 - 600e3 });
  assert.equal(fs.existsSync(file), false);
  assert.ok(fs.existsSync(path.join(dir, 'timers.json.imported.bak')));
  assert.ok(cortex.meta.get('import_timers'));
});

test('timer import: a second run adds nothing', () => {
  const { file, cortex } = setup();
  importTimersJson({ cortex, file, now: () => T0 });
  fs.writeFileSync(file, JSON.stringify({ timers: TIMERS }));   // the file came back somehow
  assert.deepEqual(importTimersJson({ cortex, file, now: () => T0 }), { imported: 0, skipped: 0, already: true });
  assert.equal(cortex.node.list({ kind: 'reminder' }).length, 2);
  assert.equal(fs.existsSync(file), false);
});

test('timer import: a crash after the commit and before the rename → the next boot only renames', () => {
  const { dir, file, cortex } = setup();
  const real = fs.renameSync;
  fs.renameSync = () => { throw new Error('crash'); };
  try { assert.throws(() => importTimersJson({ cortex, file, now: () => T0 })); } finally { fs.renameSync = real; }
  assert.ok(fs.existsSync(file));
  assert.deepEqual(importTimersJson({ cortex, file, now: () => T0 }), { imported: 0, skipped: 0, already: true });
  assert.equal(cortex.node.list({ kind: 'reminder' }).length, 2);
  assert.ok(fs.existsSync(path.join(dir, 'timers.json.imported.bak')));
});

test('timer import: an overdue timer fires once, as missed, at the next scheduler start', () => {
  const { file, cortex } = setup();
  importTimersJson({ cortex, file, now: () => T0 });
  const bus = createBus();
  const fired = [];
  bus.on('timer', e => fired.push(e));
  const s = createScheduler({ store: createCortexTimerStore({ cortex, now: () => T0 }), bus, now: () => T0, setTimer: () => 1, clearTimer: () => {} });
  assert.deepEqual(s.start(), { fired: 1, armed: 1 });
  assert.equal(fired[0].label, 'wake');
  assert.equal(fired[0].missed, true);
  const again = createScheduler({ store: createCortexTimerStore({ cortex, now: () => T0 }), bus, now: () => T0, setTimer: () => 1, clearTimer: () => {} });
  assert.equal(again.start().fired, 0);
});

test('timer import: a corrupt file imports nothing, goes to broken/ and sets no marker', () => {
  const { dir, file, cortex } = setup('{oops');
  const r = importTimersJson({ cortex, file, now: () => T0, log: () => {} });
  assert.equal(r.imported, 0);
  assert.equal(r.broken, true);
  assert.ok(fs.existsSync(path.join(dir, 'broken', 'timers.json')));
  assert.equal(cortex.meta.get('import_timers'), null);
});

test('timer import: no file → nothing, no marker; an existing .imported.bak gets a timestamped sibling', () => {
  const none = setup(null);
  assert.deepEqual(importTimersJson({ cortex: none.cortex, file: none.file }), { imported: 0, skipped: 0 });
  assert.equal(none.cortex.meta.get('import_timers'), null);
  const { dir, file, cortex } = setup();
  fs.writeFileSync(path.join(dir, 'timers.json.imported.bak'), 'older');
  importTimersJson({ cortex, file, now: () => T0 });
  assert.equal(fs.readFileSync(path.join(dir, 'timers.json.imported.bak'), 'utf8'), 'older');
  assert.ok(fs.existsSync(path.join(dir, `timers.json.${T0}.imported.bak`)));
});

test('timer import: a cortex running in memory imports nothing and leaves the file', () => {
  const { dir, file } = setup();
  fs.writeFileSync(path.join(dir, 'blocked'), 'x');
  const cortex = open({ file: path.join(dir, 'blocked', 'cortex.db') });
  assert.equal(importTimersJson({ cortex, file }).unavailable, true);
  assert.ok(fs.existsSync(file));
});

test('timer import: a label the guard refuses still imports (neutral label) and a long label is cut, so no reminder is lost', () => {
  const long = 'pick up ' + 'the groceries and '.repeat(15) + 'milk';
  const { file, cortex } = setup(JSON.stringify({ timers: [
    { id: 'tsec', kind: 'reminder', label: 'reset my bank password', due: T0 + 3600e3, created: T0 },
    { id: 'tlong', kind: 'reminder', label: long, due: T0 + 3600e3, created: T0 },
  ] }));
  assert.deepEqual(importTimersJson({ cortex, file, now: () => T0, log: () => {} }), { imported: 2, skipped: 0 });
  const store = createCortexTimerStore({ cortex, now: () => T0 });
  assert.match(store.get('tsec').label, /label not kept/);
  assert.ok(store.get('tlong').label.length <= 200);
  assert.ok(long.startsWith(store.get('tlong').label));
});
