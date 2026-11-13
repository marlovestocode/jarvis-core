'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskStore } = require('../src/core/tasks/store');
const { createTaskRunner } = require('../src/core/tasks/runner');
const { NEEDS_OK } = require('../src/core/brain/guard');

const ASK = NEEDS_OK + 'Delete x. Say yes to confirm.';

function setup(script, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ctl-'));
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const store = createTaskStore({ dir, now });
  const calls = [];
  const pending = { action: null };
  const tools = {
    resolves: n => n !== 'nope',
    async run(name, args) {
      calls.push({ name, args });
      return script(name, args, calls.length);
    },
  };
  const runner = createTaskRunner({
    store, tools, now,
    riskOf: n => (n === 'del' ? 'confirm' : undefined),
    confirmPending: () => pending.action,
    ...opts,
  });
  return { store, calls, runner, clock, pending };
}

const ok = name => ({ ok: true, text: `out-${name}` });
const step = (id, tool, status, extra = {}) => ({ id, tool, args: {}, status, attempts: status === 'pending' ? 0 : 1, result: status === 'done' ? { ok: true, text: `old-${tool}`, t: 1 } : null, ...extra });

function seed(store, steps, status = 'paused') {
  const t = store.create({ title: 'Seeded', origin: {}, steps });
  t.status = status;
  store.save(t);
  return t.id;
}

test('resume skips done steps and finishes the rest', async () => {
  const { runner, calls, store } = setup(ok);
  const id = seed(store, [step('s1', 'a', 'done'), step('s2', 'b', 'pending', { args: { x: { $ref: 's1' } } }), step('s3', 'c', 'pending')]);
  const r = await runner.resume(id, { turn: 2 });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map(c => c.name), ['b', 'c']);
  assert.equal(calls[0].args.x, 'old-a');
  assert.equal(store.get(id).status, 'done');
});

test('resume of a done or cancelled task is refused plainly', async () => {
  const { runner, calls, store } = setup(ok);
  for (const st of ['done', 'cancelled']) {
    const id = seed(store, [step('s1', 'a', st === 'done' ? 'done' : 'pending')], st);
    const r = await runner.resume(id, { turn: 2 });
    assert.equal(r.ok, false);
    assert.match(r.text, new RegExp(st));
  }
  const missing = await runner.resume('zzzz9', { turn: 2 });
  assert.equal(missing.ok, false);
  assert.equal(calls.length, 0);
});

test('restart: a running read-only step is re-run on resume', async () => {
  const { runner, calls, store } = setup(ok);
  const id = seed(store, [step('s1', 'a', 'done'), step('s2', 'get_time', 'running')], 'interrupted');
  const r = await runner.resume(id, { turn: 2 });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map(c => c.name), ['get_time']);
  assert.equal(store.get(id).status, 'done');
});

test('restart: a running write step asks first and does not call the tool', async () => {
  const { runner, calls, store } = setup(ok);
  const id = seed(store, [step('s1', 'a', 'done'), step('s2', 'send_message', 'running')], 'interrupted');
  const r = await runner.resume(id, { turn: 2 });
  assert.equal(r.ok, false);
  assert.ok(r.text.startsWith(NEEDS_OK));
  assert.match(r.text, /s2/);
  assert.match(r.text, /may already have run/);
  assert.equal(calls.length, 0);
  assert.equal(store.get(id).status, 'awaiting_confirm');
  // Asking again ("resume the task") is the yes: no confirm is pending, so it reconciles and runs.
  const r2 = await runner.resume(id, { turn: 3 });
  assert.equal(r2.ok, true);
  assert.deepEqual(calls.map(c => c.name), ['send_message']);
});

test('replan after a failure replaces only later steps and runs them', async () => {
  const { runner, calls, store } = setup(name => (name === 'b' ? { ok: true, text: 'nope' } : ok(name)));
  const r = await runner.start({ title: 'T', steps: [{ tool: 'a' }, { tool: 'b', expect: { contains: 'out' } }, { tool: 'c' }], turn: 1 });
  assert.equal(r.ok, false);
  const id = r.task.id;
  const s1Before = JSON.stringify(store.get(id).steps[0]);
  const r2 = await runner.replan(id, [{ tool: 'b2', args: { x: { $ref: 's1' } } }, { tool: 'd' }], { turn: 2 });
  assert.equal(r2.ok, true);
  const t = store.get(id);
  assert.equal(t.replans, 1);
  assert.equal(t.status, 'done');
  assert.equal(JSON.stringify(t.steps[0]), s1Before);
  assert.deepEqual(t.steps.map(s => `${s.id}:${s.tool}`), ['s1:a', 's2:b2', 's3:d']);
  assert.deepEqual(calls.map(c => c.name), ['a', 'b', 'b2', 'd']);
  assert.equal(calls[2].args.x, 'out-a');
});

test('replan retries the failed step only when included', async () => {
  let pass = false;
  const { runner, calls } = setup(name => (name === 'b' && !pass ? { ok: false, text: 'not allowed' } : ok(name)));
  const r = await runner.start({ title: 'T', steps: [{ tool: 'a' }, { tool: 'b' }], turn: 1 });
  pass = true;
  const r2 = await runner.replan(r.task.id, [{ tool: 'b' }, { tool: 'c' }], { turn: 2 });
  assert.equal(r2.ok, true);
  assert.deepEqual(calls.map(c => c.name), ['a', 'b', 'b', 'c']);
});

test('replan is refused: third time, no failed step, invalid steps', async () => {
  const { runner, calls, store } = setup(() => ({ ok: false, text: 'not allowed' }));
  const r = await runner.start({ title: 'T', steps: [{ tool: 'a' }], turn: 1 });
  const t = store.get(r.task.id);
  t.replans = 2;
  store.save(t);
  const third = await runner.replan(t.id, [{ tool: 'b' }], { turn: 2 });
  assert.equal(third.ok, false);
  assert.match(third.text, /2/);
  assert.equal(calls.length, 1);

  const done = setup(ok);
  const d = await done.runner.start({ title: 'T', steps: [{ tool: 'a' }], turn: 1 });
  const noFail = await done.runner.replan(d.task.id, [{ tool: 'b' }], { turn: 2 });
  assert.equal(noFail.ok, false);

  const bad = setup(name => (name === 'b' ? { ok: false, text: 'not allowed' } : ok(name)));
  const b = await bad.runner.start({ title: 'T', steps: [{ tool: 'a' }, { tool: 'b' }], turn: 1 });
  const before = JSON.stringify(bad.store.get(b.task.id).steps);
  const inv = await bad.runner.replan(b.task.id, [{ tool: 'c', args: { x: { $ref: 's3' } } }], { turn: 2 });
  assert.equal(inv.ok, false);
  assert.equal(JSON.stringify(bad.store.get(b.task.id).steps), before);
  assert.equal(bad.store.get(b.task.id).replans, 0);
});

test('confirm: NEEDS_OK makes the task await, text is the question', async () => {
  const { runner, calls, store } = setup(name => (name === 'del' ? { ok: true, text: ASK } : ok(name)));
  const r = await runner.start({ title: 'T', steps: [{ tool: 'a' }, { tool: 'del' }, { tool: 'c' }], turn: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.text, ASK);
  const t = store.get(r.task.id);
  assert.equal(t.status, 'awaiting_confirm');
  assert.equal(t.steps[1].asked, true);
  assert.equal(t.steps[1].status, 'pending');

  runner.onConfirmResolved({ tool: 'del', ok: true, text: 'Deleted x.' });
  const t2 = store.get(r.task.id);
  assert.equal(t2.status, 'paused');
  assert.equal(t2.steps[1].status, 'done');
  assert.equal(t2.steps[1].result.text, 'Deleted x.');
  assert.ok(!t2.steps[1].asked);
  const r3 = await runner.resume(r.task.id, { turn: 2 });
  assert.equal(r3.ok, true);
  assert.deepEqual(calls.map(c => c.name), ['a', 'del', 'c']);
});

test('confirm: declined marks the step skipped and the task paused', async () => {
  const { runner, calls, store } = setup(name => (name === 'del' ? { ok: true, text: ASK } : ok(name)));
  const r = await runner.start({ title: 'T', steps: [{ tool: 'del' }, { tool: 'c' }], turn: 1 });
  runner.onConfirmResolved({ tool: 'del', ok: true, text: 'Cancelled.', declined: true });
  const t = store.get(r.task.id);
  assert.equal(t.status, 'paused');
  assert.equal(t.steps[0].status, 'skipped');
  const r2 = await runner.resume(r.task.id, { turn: 2 });
  assert.equal(r2.ok, true);
  assert.deepEqual(calls.map(c => c.name), ['del', 'c']);
});

test('confirm: unmatched tool and no awaiting task are ignored', async () => {
  const { runner, store } = setup(name => (name === 'del' ? { ok: true, text: ASK } : ok(name)));
  runner.onConfirmResolved({ tool: 'del', ok: true, text: 'x' });
  const r = await runner.start({ title: 'T', steps: [{ tool: 'del' }], turn: 1 });
  runner.onConfirmResolved({ tool: 'other', ok: true, text: 'x' });
  assert.equal(store.get(r.task.id).status, 'awaiting_confirm');
});

test('confirm: a dropped question reconciles to paused; resume re-proposes', async () => {
  const { runner, calls, store, pending } = setup(name => (name === 'del' ? { ok: true, text: ASK } : ok(name)));
  pending.action = null;
  const r = await runner.start({ title: 'T', steps: [{ tool: 'del' }, { tool: 'c' }], turn: 1 });
  const s = runner.status(r.task.id);
  assert.equal(s.ok, true);
  assert.equal(store.get(r.task.id).status, 'paused');
  assert.match(s.text, /paused/);
  const r2 = await runner.resume(r.task.id, { turn: 2 });
  assert.equal(r2.text, ASK);
  assert.deepEqual(calls.map(c => c.name), ['del', 'del']);
  assert.equal(store.get(r.task.id).status, 'awaiting_confirm');
});

test('single slot: start or resume while another task awaits is refused', async () => {
  const { runner, calls, store, pending } = setup(name => (name === 'del' ? { ok: true, text: ASK } : ok(name)));
  const r = await runner.start({ title: 'Cleanup', steps: [{ tool: 'del' }], turn: 1 });
  pending.action = { tool: 'del', summary: 'Delete x' };
  const other = await runner.start({ title: 'Other', steps: [{ tool: 'a' }], turn: 2 });
  assert.equal(other.ok, false);
  assert.match(other.text, new RegExp(r.task.id));
  const id2 = seed(store, [step('s1', 'a', 'pending')]);
  const res = await runner.resume(id2, { turn: 2 });
  assert.equal(res.ok, false);
  assert.match(res.text, /Cleanup/);
  const self = await runner.resume(r.task.id, { turn: 2 });
  assert.equal(self.ok, false);
  assert.equal(calls.length, 1);
});

test('tainted: resume refuses a task with a confirm step; start validates tainted', async () => {
  const { runner, calls, store } = setup(ok);
  const id = seed(store, [step('s1', 'a', 'pending'), step('s2', 'del', 'pending')]);
  const r = await runner.resume(id, { turn: { tainted: true } });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
  assert.equal(store.get(id).status, 'paused');
  const s = await runner.start({ title: 'T', steps: [{ tool: 'del' }], turn: { tainted: true } });
  assert.equal(s.ok, false);
  assert.equal(calls.length, 0);
});

test('pause and cancel; no-ops on finished tasks', async () => {
  const { runner, store } = setup(ok);
  const id = seed(store, [step('s1', 'a', 'pending')], 'interrupted');
  assert.equal(runner.pause(id).ok, true);
  assert.equal(store.get(id).status, 'paused');
  assert.equal(runner.cancel(id).ok, true);
  assert.equal(store.get(id).status, 'cancelled');
  const p = runner.pause(id);
  assert.equal(p.ok, false);
  assert.match(p.text, /cancelled/);
  assert.equal(runner.cancel(id).ok, false);
  assert.equal(store.get(id).status, 'cancelled');
  assert.equal(runner.pause('zzzz9').ok, false);
});

test('cancel drops a failed task; done and cancelled stay unchanged', async () => {
  const { runner, store, clock } = setup(ok);
  const failed = seed(store, [step('s1', 'a', 'failed')], 'failed');
  const c = runner.cancel(failed);
  assert.equal(c.ok, true);
  assert.equal(store.get(failed).status, 'cancelled');
  for (const st of ['done', 'cancelled']) {
    const id = seed(store, [step('s1', 'a', 'done')], st);
    const before = store.get(id);
    clock.t += 10;
    const r = runner.cancel(id);
    assert.equal(r.ok, false);
    assert.match(r.text, new RegExp(st));
    assert.deepEqual(store.get(id), before);
  }
});

test('cancel of an awaiting_confirm task', async () => {
  const { runner, store, pending } = setup(name => (name === 'del' ? { ok: true, text: ASK } : ok(name)));
  const r = await runner.start({ title: 'T', steps: [{ tool: 'del' }], turn: 1 });
  pending.action = { tool: 'del' };
  assert.equal(runner.cancel(r.task.id).ok, true);
  assert.equal(store.get(r.task.id).status, 'cancelled');
});

test('confirm: a failed action marks the step and the task failed', async () => {
  const { runner, store } = setup(name => (name === 'del' ? { ok: true, text: ASK } : ok(name)));
  const r = await runner.start({ title: 'T', steps: [{ tool: 'del' }, { tool: 'c' }], turn: 1 });
  runner.onConfirmResolved({ tool: 'del', ok: false, text: 'That did not work: locked.' });
  const t = store.get(r.task.id);
  assert.equal(t.status, 'failed');
  assert.equal(t.steps[0].status, 'failed');
  assert.equal(t.steps[0].result.text, 'That did not work: locked.');
});

test('restart: a running confirm step is re-proposed, not asked about', async () => {
  const { runner, calls, store } = setup(name => (name === 'del' ? { ok: true, text: ASK } : ok(name)));
  const id = seed(store, [step('s1', 'del', 'running')], 'interrupted');
  const r = await runner.resume(id, { turn: 2 });
  assert.equal(r.text, ASK);
  assert.deepEqual(calls.map(c => c.name), ['del']);
  assert.equal(store.get(id).status, 'awaiting_confirm');
});

test('status with no id reports a newest failed task over an older paused one', async () => {
  const { runner, store, clock } = setup(ok);
  seed(store, [step('s1', 'a', 'pending')]);
  clock.t += 10;
  const failed = seed(store, [step('s1', 'a', 'failed')], 'failed');
  assert.match(runner.status().text, new RegExp(failed));
});

test('pause requested during a run stops at the next step boundary', async () => {
  let runner;
  const s = setup((name, a, n) => { if (n === 1) runner.pause(s.store.list()[0].id); return ok(name); });
  runner = s.runner;
  const r = await runner.start({ title: 'T', steps: [{ tool: 'a' }, { tool: 'b' }], turn: 1 });
  assert.equal(r.ok, false);
  assert.equal(s.calls.length, 1);
  assert.equal(s.store.get(r.task.id).status, 'paused');
});

test('status: no id picks newest unfinished, else newest', async () => {
  const { runner, store, clock } = setup(ok);
  assert.equal(runner.status().ok, false);
  const a = seed(store, [step('s1', 'a', 'pending')]);
  clock.t += 10;
  const done = await runner.start({ title: 'Finished', steps: [{ tool: 'a' }], turn: 1 });
  assert.match(runner.status().text, new RegExp(a));
  runner.cancel(a);
  clock.t += 10;
  store.save(store.get(done.task.id));
  assert.match(runner.status().text, new RegExp(done.task.id));
});

test('active and lastFinished', async () => {
  const { runner, store, clock } = setup(ok);
  assert.equal(runner.active(), null);
  assert.equal(runner.lastFinished(60000), null);
  const id = seed(store, [step('s1', 'a', 'done'), step('s2', 'b', 'pending')]);
  assert.deepEqual(runner.active(), { id, title: 'Seeded', status: 'paused', done: 1, total: 2 });
  await runner.resume(id, { turn: 2 });
  assert.equal(runner.active(), null);
  assert.deepEqual(runner.lastFinished(60000), { id, status: 'done' });
  clock.t += 120000;
  assert.equal(runner.lastFinished(60000), null);
});

test('current: newest open task, failed included; closed tasks never', async () => {
  const { runner, store, clock } = setup(ok);
  assert.equal(runner.current(), null);
  const paused = seed(store, [step('s1', 'a', 'pending')]);
  assert.deepEqual(runner.current(), { id: paused, status: 'paused' });
  clock.t += 10;
  const failed = seed(store, [step('s1', 'a', 'failed')], 'failed');
  assert.deepEqual(runner.current(), { id: failed, status: 'failed' });
  assert.equal(runner.active().id, paused);
  runner.cancel(failed);
  assert.deepEqual(runner.current(), { id: paused, status: 'paused' });
  runner.cancel(paused);
  clock.t += 10;
  await runner.start({ title: 'D', steps: [{ tool: 'a' }], turn: 1 });
  assert.equal(runner.current(), null);
});

test('current: a failed-only task is returned', () => {
  const { runner, store } = setup(ok);
  const id = seed(store, [step('s1', 'a', 'failed')], 'failed');
  assert.deepEqual(runner.current(), { id, status: 'failed' });
});
