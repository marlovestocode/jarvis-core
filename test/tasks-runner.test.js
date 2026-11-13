'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskStore } = require('../src/core/tasks/store');
const { createTaskRunner } = require('../src/core/tasks/runner');
const { READ_ONLY, isReadOnly } = require('../src/core/tasks/effects');

function setup(script, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-runner-'));
  const store = createTaskStore({ dir });
  const calls = [];
  const events = [];
  const tools = {
    resolves: n => n !== 'nope',
    async run(name, args, ctx) {
      calls.push({ name, args, ctx });
      return script(name, args, calls.length, store);
    },
  };
  const bus = { emit: (type, payload) => events.push({ type, payload }) };
  const runner = createTaskRunner({ store: opts.store || store, tools, bus, ...opts.runner });
  return { dir, store, calls, events, runner };
}
const steps3 = [{ tool: 'a' }, { tool: 'b', args: { x: { $ref: 's1' } } }, { tool: 'c' }];

test('effects: read-only set', () => {
  assert.ok(READ_ONLY instanceof Set);
  assert.ok(isReadOnly('get_time'));
  assert.ok(!isReadOnly('send_message'));
});

test('runs in order, refs get earlier result, done text', async () => {
  const { runner, calls, store } = setup((n) => ({ ok: true, text: `out-${n}` }));
  const r = await runner.start({ title: 'T', steps: steps3, turn: 1, sessionId: 's' });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map(c => c.name), ['a', 'b', 'c']);
  assert.equal(calls[1].args.x, 'out-a');
  assert.match(r.text, /^Done: 3\/3 steps/);
  assert.equal(r.text.split('\n').length, 4);
  assert.equal(store.get(r.task.id).status, 'done');
});

test('write-ahead: running before, done after', async () => {
  let seen;
  const { runner, store } = setup((n, a, i, st) => {
    const t = st.get(st.list()[0].id);
    if (i === 1) seen = t.steps[0].status;
    return { ok: true, text: 'ok' };
  });
  const r = await runner.start({ title: 'T', steps: [{ tool: 'a' }], turn: 1 });
  assert.equal(seen, 'running');
  assert.equal(store.get(r.task.id).steps[0].status, 'done');
});

test('expect failure stops run and names step, evidence, replan', async () => {
  const { runner, store, calls } = setup(() => ({ ok: true, text: 'hello' }));
  const r = await runner.start({ title: 'T', steps: [{ tool: 'a' }, { tool: 'b', expect: { contains: 'zzz' } }, { tool: 'c' }], turn: 1 });
  assert.equal(r.ok, false);
  const t = store.get(r.task.id);
  assert.equal(t.status, 'failed');
  assert.equal(t.steps[2].status, 'pending');
  assert.equal(calls.length, 2);
  assert.match(r.text, /s2/);
  assert.match(r.text, /zzz/);
  assert.match(r.text, /task_control/);
  assert.match(r.text, /replan/);
  assert.match(r.text, /s1/);
});

test('transient error retried once; no-retry error not', async () => {
  let n = 0;
  const a = setup(() => (++n === 1 ? { ok: false, text: 'flaky glitch' } : { ok: true, text: 'fine' }));
  const r = await a.runner.start({ title: 'T', steps: [{ tool: 'a' }], turn: 1 });
  assert.equal(r.ok, true);
  assert.equal(a.store.get(r.task.id).steps[0].attempts, 2);
  for (const msg of ['not allowed here', 'must be local', 'timed out', 'aborted', 'not running', 'not in Ollama']) {
    const b = setup(() => ({ ok: false, text: msg }));
    const r2 = await b.runner.start({ title: 'T', steps: [{ tool: 'a' }], turn: 1 });
    assert.equal(r2.ok, false);
    assert.equal(b.calls.length, 1, msg);
    assert.equal(b.store.get(r2.task.id).steps[0].attempts, 1);
  }
});

test('unresolvable ref fails step without calling tool', async () => {
  const { runner, calls, store } = setup(() => ({ ok: true, text: 'x' }));
  const task = store.create({ title: 'T', origin: {}, steps: [
    { id: 's1', tool: 'a', args: {}, status: 'done', attempts: 1, result: null },
    { id: 's2', tool: 'b', args: { x: { $ref: 's1' } }, status: 'pending', attempts: 0, result: null },
  ] });
  const r = await runner.execute(task, { turn: 1 });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
  assert.equal(store.get(task.id).steps[1].status, 'failed');
});

test('ref pick failure fails step without tool call', async () => {
  const { runner, calls, store } = setup(() => ({ ok: true, text: 'not json' }));
  const r = await runner.start({ title: 'T', steps: [{ tool: 'a' }, { tool: 'b', args: { x: { $ref: 's1', pick: 'a.b' } } }], turn: 1 });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1);
  assert.equal(store.get(r.task.id).steps[1].status, 'failed');
});

test('abort between steps pauses', async () => {
  const ac = new AbortController();
  const { runner, calls, store } = setup((n) => { if (n === 'a') ac.abort(); return { ok: true, text: 'ok' }; });
  const r = await runner.start({ title: 'T', steps: steps3, turn: 1, signal: ac.signal });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1);
  assert.equal(store.get(r.task.id).status, 'paused');
});

test('save failure mid-run stops with error and no more tools', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-runner-'));
  const real = createTaskStore({ dir });
  let saves = 0;
  const store = { ...real, save(t) { if (++saves >= 3) throw new Error('disk full'); return real.save(t); } };
  const { runner, calls } = setup(() => ({ ok: true, text: 'ok' }), { store });
  const r = await runner.start({ title: 'T', steps: steps3, turn: 1 });
  assert.equal(r.ok, false);
  assert.match(r.text, /disk full/);
  assert.equal(calls.length, 1);
});

test('bus gets tool and task events', async () => {
  const { runner, events } = setup(() => ({ ok: true, text: 'ok' }));
  const r = await runner.start({ title: 'T', steps: [{ tool: 'a' }], turn: 1 });
  const tools = events.filter(e => e.type === 'tool').map(e => e.payload);
  assert.deepEqual(tools.map(t => t.phase), ['start', 'end']);
  assert.equal(tools[1].ok, true);
  assert.equal(tools[0].name, 'a');
  assert.equal(tools[0].id, r.task.id + ':s1');
  const tasks = events.filter(e => e.type === 'task').map(e => e.payload);
  assert.ok(tasks.some(t => t.id === r.task.id && t.step === 's1' && t.status === 'done'));
});

test('invalid plan and create failure return ok false', async () => {
  const { runner, store } = setup(() => ({ ok: true, text: 'x' }));
  const r = await runner.start({ title: 'T', steps: [{ tool: 'nope' }], turn: 1 });
  assert.equal(r.ok, false);
  assert.equal(store.list().length, 0);
  const bad = setup(() => ({ ok: true, text: 'x' }), { store: { create() { throw new Error('Too many open tasks (50).'); } } });
  const r2 = await bad.runner.start({ title: 'T', steps: [{ tool: 'a' }], turn: 1 });
  assert.equal(r2.ok, false);
  assert.match(r2.text, /Too many open tasks/);
});

test('execute can re-run a failed step with attempts already 2', async () => {
  let ok = false;
  const { runner, calls, store } = setup(() => (ok ? { ok: true, text: 'fine' } : { ok: false, text: 'flaky' }));
  const r = await runner.start({ title: 'T', steps: [{ tool: 'a' }], turn: 1 });
  assert.equal(r.task.steps[0].attempts, 2);
  ok = true;
  const before = calls.length;
  const r2 = await runner.execute(store.get(r.task.id), { turn: 2 });
  assert.equal(r2.ok, true);
  assert.equal(calls.length, before + 1);
});

test('abort during a tool call pauses instead of failing', async () => {
  const ac = new AbortController();
  const { runner, store } = setup(() => { ac.abort(); return { ok: false, text: 'aborted' }; });
  const r = await runner.start({ title: 'T', steps: [{ tool: 'a' }, { tool: 'b' }], turn: 1, signal: ac.signal });
  const t = store.get(r.task.id);
  assert.equal(t.status, 'paused');
  assert.equal(t.steps[0].status, 'pending');
  assert.doesNotMatch(r.text, /replan/);
});
