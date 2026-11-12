'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskStore, MAX_TASKS, TTL_MS, RESULT_CAP } = require('../src/core/tasks/store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-'));
const rm = d => fs.rmSync(d, { recursive: true, force: true });
const steps = () => [{ id: 's1', tool: 'x', args: {}, expect: null, status: 'pending', attempts: 0, result: null }];
const mk = (store, title = 't') => store.create({ title, steps: steps(), origin: 'voice' });

test('constants', () => {
  assert.equal(MAX_TASKS, 50);
  assert.equal(TTL_MS, 14 * 24 * 3600 * 1000);
  assert.equal(RESULT_CAP, 4096);
});

test('create then reload with a new instance returns equal data', () => {
  const dir = tmp();
  try {
    const a = createTaskStore({ dir });
    const t = mk(a, 'hello');
    assert.match(t.id, /^[a-z0-9]{4,24}$/);
    assert.equal(t.status, 'planned');
    assert.equal(t.v, 1);
    assert.equal(t.replans, 0);
    const b = createTaskStore({ dir });
    assert.deepEqual(b.get(t.id), t);
  } finally { rm(dir); }
});

test('bad ids return null and read nothing outside dir', () => {
  const parent = tmp();
  const dir = path.join(parent, 'tasks');
  fs.mkdirSync(path.join(dir, 'a'), { recursive: true });
  const planted = [
    [path.join(parent, 'x.json'), '../x'],
    [path.join(dir, 'a', 'b.json'), 'a/b'],
    [path.join(dir, '.json'), ''],
  ];
  const body = id => JSON.stringify({ id, status: 'planned', steps: [] });
  for (const [f, id] of planted) fs.writeFileSync(f, body(id));
  const orig = fs.readFileSync;
  const reads = [];
  fs.readFileSync = (p, ...rest) => { reads.push(String(p)); return orig.call(fs, p, ...rest); };
  try {
    const s = createTaskStore({ dir });
    for (const id of ['../x', 'a/b', '', 'a\b', null, undefined, 42]) assert.equal(s.get(id), null);
    for (const [f] of planted) {
      assert.ok(!reads.includes(f), `read ${f}`);
      assert.ok(fs.existsSync(f), `moved ${f}`);
      assert.equal(orig.call(fs, f, 'utf8').length > 0, true);
    }
    assert.ok(!fs.existsSync(path.join(dir, 'broken')));
  } finally { fs.readFileSync = orig; rm(parent); }
});

test('corrupt file is quarantined, others still load', () => {
  const dir = tmp();
  try {
    const s = createTaskStore({ dir });
    const good = mk(s);
    fs.writeFileSync(path.join(dir, 'bad1.json'), '{not json');
    assert.equal(s.get('bad1'), null);
    assert.ok(fs.existsSync(path.join(dir, 'broken', 'bad1.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'bad1.json')));
    assert.equal(s.get(good.id).id, good.id);
    assert.deepEqual(s.list().map(x => x.id), [good.id]);
  } finally { rm(dir); }
});

test('wrong-shape file is quarantined', () => {
  const dir = tmp();
  try {
    const s = createTaskStore({ dir });
    fs.writeFileSync(path.join(dir, 'oddy.json'), JSON.stringify({ id: 'other', steps: [] }));
    assert.equal(s.get('oddy'), null);
    assert.ok(fs.existsSync(path.join(dir, 'broken', 'oddy.json')));
  } finally { rm(dir); }
});

test('save caps result text and sets updated', () => {
  const dir = tmp();
  let n = 1000;
  try {
    const s = createTaskStore({ dir, now: () => n });
    const t = mk(s);
    t.steps[0].result = { ok: true, text: 'a'.repeat(10000) };
    n = 2000;
    s.save(t);
    const back = createTaskStore({ dir }).get(t.id);
    assert.equal(back.steps[0].result.text.length, RESULT_CAP);
    assert.equal(back.updated, 2000);
  } finally { rm(dir); }
});

test('sweep turns running into interrupted, leaves others', () => {
  const dir = tmp();
  try {
    const s = createTaskStore({ dir });
    const mkAs = status => { const t = mk(s); t.status = status; s.save(t); return t.id; };
    const r1 = mkAs('running'), r2 = mkAs('running'), c = mkAs('awaiting_confirm'), p = mkAs('paused'), d = mkAs('done');
    assert.equal(s.sweep(), 2);
    assert.equal(s.get(r1).status, 'interrupted');
    assert.equal(s.get(r2).status, 'interrupted');
    assert.equal(s.get(c).status, 'awaiting_confirm');
    assert.equal(s.get(p).status, 'paused');
    assert.equal(s.get(d).status, 'done');
    assert.equal(s.sweep(), 0);
  } finally { rm(dir); }
});

test('create prunes finished tasks older than TTL', () => {
  const dir = tmp();
  let n = 1_000_000;
  try {
    const s = createTaskStore({ dir, now: () => n });
    const old = mk(s); old.status = 'done'; s.save(old);
    const oldActive = mk(s); oldActive.status = 'paused'; s.save(oldActive);
    n += TTL_MS + 1;
    mk(s);
    assert.equal(s.get(old.id), null);
    assert.ok(s.get(oldActive.id));
  } finally { rm(dir); }
});

test('over MAX_TASKS the oldest finished are pruned', () => {
  const dir = tmp();
  let n = 1_000_000;
  try {
    const s = createTaskStore({ dir, now: () => n++ });
    const ids = [];
    for (let i = 0; i < MAX_TASKS; i++) { const t = mk(s); ids.push(t.id); }
    for (const id of ids.slice(0, 3)) { const t = s.get(id); t.status = 'cancelled'; s.save(t); }
    mk(s);
    assert.equal(s.list().length, MAX_TASKS);
    assert.equal(s.get(ids[0]), null);
    assert.ok(s.get(ids[1]));
    assert.ok(s.get(ids[2]));
  } finally { rm(dir); }
});

test('50 active tasks: create throws too many open tasks', () => {
  const dir = tmp();
  try {
    const s = createTaskStore({ dir });
    for (let i = 0; i < MAX_TASKS; i++) mk(s);
    assert.throws(() => mk(s), /too many open tasks/i);
    assert.equal(s.list().length, MAX_TASKS);
  } finally { rm(dir); }
});

test('save throws when dir is not writable', () => {
  const dir = tmp();
  try {
    const s = createTaskStore({ dir });
    const t = mk(s);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(dir, 'i am a file');
    assert.throws(() => s.save(t));
  } finally { rm(dir); }
});

test('list is newest-updated first; remove deletes', () => {
  const dir = tmp();
  let n = 1000;
  try {
    const s = createTaskStore({ dir, now: () => n });
    const a = mk(s, 'a'); n = 2000;
    const b = mk(s, 'b'); n = 3000;
    s.save(a);
    assert.deepEqual(s.list().map(x => x.id), [a.id, b.id]);
    assert.deepEqual(Object.keys(s.list()[0]).sort(), ['id', 'status', 'title', 'updated']);
    s.remove(a.id);
    assert.equal(s.get(a.id), null);
    assert.deepEqual(s.list().map(x => x.id), [b.id]);
  } finally { rm(dir); }
});
