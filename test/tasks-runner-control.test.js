'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskStore } = require('../src/core/tasks/store');
const { createTaskRunner } = require('../src/core/tasks/runner');
const { NEEDS_OK } = require('../src/core/brain/guard');

const SUMMARY = 'Delete x';
const ASK = NEEDS_OK + SUMMARY + '. Say yes to confirm.';

function setup(script, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-ctl-'));
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const store = createTaskStore({ dir, now });
  const calls = [];
  const pending = { action: null };
  const tools = {
    resolves: n => n !== 'nope',
    async run(name, args, ctx) {
      calls.push({ name, args, ctx });
      const res = await script(name, args, calls.length);
      // like confirm.propose: a NEEDS_OK answer leaves its action pending
      if (String(res?.text ?? '').startsWith(NEEDS_OK)) pending.action = { tool: name, summary: SUMMARY };
      return res;
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

  const note = runner.onConfirmResolved({ tool: 'del', summary: SUMMARY, ok: true, text: 'Deleted x.' });
  assert.equal(note, `Task ${r.task.id} paused at s3; say "resume the task" to finish it.`);
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
  runner.onConfirmResolved({ tool: 'del', summary: SUMMARY, ok: true, text: 'Cancelled.', declined: true });
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
  const r = await runner.start({ title: 'T', steps: [{ tool: 'del' }, { tool: 'c' }], turn: 1 });
  pending.action = null;   // the question timed out or was dropped
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
  assert.equal(runner.cancel(r.task.id).ok, true);
  assert.equal(store.get(r.task.id).status, 'cancelled');
});

test('cancel of an awaiting_confirm task calls onCancel once; other cancels do not', async () => {
  const seen = [];
  const { runner, store } = setup(name => (name === 'del' ? { ok: true, text: ASK } : ok(name)), { onCancel: t => seen.push(t.id) });
  const r = await runner.start({ title: 'T', steps: [{ tool: 'del' }], turn: 1 });
  assert.equal(runner.cancel(r.task.id).ok, true);
  assert.deepEqual(seen, [r.task.id]);
  const other = seed(store, [step('s1', 'a', 'pending')]);
  runner.cancel(other);
  assert.deepEqual(seen, [r.task.id]);
});

test('a throwing onCancel does not stop the cancel', async () => {
  const { runner, store } = setup(name => (name === 'del' ? { ok: true, text: ASK } : ok(name)), { onCancel: () => { throw new Error('boom'); } });
  const r = await runner.start({ title: 'T', steps: [{ tool: 'del' }], turn: 1 });
  const c = runner.cancel(r.task.id);
  assert.equal(c.ok, true);
  assert.equal(store.get(r.task.id).status, 'cancelled');
});

test('confirm: a failed action marks the step and the task failed', async () => {
  const { runner, store } = setup(name => (name === 'del' ? { ok: true, text: ASK } : ok(name)));
  const r = await runner.start({ title: 'T', steps: [{ tool: 'del' }, { tool: 'c' }], turn: 1 });
  runner.onConfirmResolved({ tool: 'del', summary: SUMMARY, ok: false, text: 'That did not work: locked.' });
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

// Final review fixes: taint, proposal identity, maybeRan, origin.
test('taint: an untrusted step taints the outer turn and refuses a later confirm step', async () => {
  for (const [first, res] of [['read_page', { ok: true, text: 'page text', untrusted: true }], ['get_weather', { ok: true, text: 'sunny' }]]) {
    const { runner, calls, store } = setup(name => (name === first ? res : name === 'del' ? { ok: true, text: ASK } : ok(name)));
    const turn = { source: 'chat', tainted: false };
    const r = await runner.start({ title: 'T', steps: [{ tool: first }, { tool: 'b' }, { tool: 'del', args: { x: { $ref: 's1' } } }], turn });
    assert.equal(r.ok, false);
    assert.equal(turn.tainted, true, 'the shared turn object is tainted');
    assert.deepEqual(calls.map(c => c.name), [first, 'b']);
    assert.equal(calls[1].ctx.turn.tainted, true, 'later steps run in a tainted turn');
    const t = store.get(r.task.id);
    assert.equal(t.tainted, true);
    assert.equal(t.steps[2].status, 'failed');
    assert.match(r.text, /needs the user's OK/);
  }
});

test('taint: a tainted task resumed in a clean turn still refuses a confirm step', async () => {
  const { runner, calls, store } = setup(ok);
  const id = seed(store, [step('s1', 'read_page', 'done'), step('s2', 'del', 'pending')]);
  const t = store.get(id); t.tainted = true; store.save(t);
  const r = await runner.resume(id, { turn: { source: 'chat', tainted: false } });
  assert.equal(r.ok, false);
  assert.match(r.text, /untrusted/);
  assert.equal(calls.length, 0);
});

test('taint: a tainted task without confirm steps resumes and taints the turn', async () => {
  const { runner, calls, store } = setup(ok);
  const id = seed(store, [step('s1', 'read_page', 'done'), step('s2', 'b', 'pending')]);
  const t = store.get(id); t.tainted = true; store.save(t);
  const turn = { source: 'chat', tainted: false };
  const r = await runner.resume(id, { turn });
  assert.equal(r.ok, true);
  assert.equal(turn.tainted, true);
  assert.equal(calls[0].ctx.turn.tainted, true);
});

test('taint: replan of a tainted task refuses confirm steps', async () => {
  const { runner, calls, store } = setup(ok);
  const id = seed(store, [step('s1', 'read_page', 'done'), step('s2', 'b', 'failed')], 'failed');
  const t = store.get(id); t.tainted = true; store.save(t);
  const r = await runner.replan(id, [{ tool: 'del' }], { turn: { source: 'chat', tainted: false } });
  assert.equal(r.ok, false);
  assert.match(r.text, /needs the user's OK/);
  assert.equal(calls.length, 0);
  assert.equal(store.get(id).replans, 0);
});

test('identity: another proposal of the same tool never resolves or keeps alive a stale step', async () => {
  const seen = [];
  const { runner, store, pending } = setup(name => (name === 'del' ? { ok: true, text: ASK } : ok(name)), { onCancel: t => seen.push(t.id) });
  const r = await runner.start({ title: 'T', steps: [{ tool: 'del' }, { tool: 'c' }], turn: 1 });
  assert.equal(store.get(r.task.id).steps[0].askedFor, SUMMARY);
  pending.action = { tool: 'del', summary: 'Delete y' };   // the task's question was dropped; an unrelated one is pending
  assert.equal(runner.onConfirmResolved({ tool: 'del', summary: 'Delete y', ok: true, text: 'Deleted y.' }), undefined);
  assert.notEqual(store.get(r.task.id).steps[0].status, 'done');
  assert.match(runner.status(r.task.id).text, /paused/, 'a different pending proposal does not keep the task waiting');
  assert.equal(runner.cancel(r.task.id).ok, true);
  assert.deepEqual(seen, [], 'cancelling the stale task leaves the unrelated proposal alone');
  assert.equal(store.get(r.task.id).status, 'cancelled');
});

test('identity: cancel of a stale waiting task (question dropped) does not call onCancel', async () => {
  const seen = [];
  const { runner, store, pending } = setup(name => (name === 'del' ? { ok: true, text: ASK } : ok(name)), { onCancel: t => seen.push(t.id) });
  const r = await runner.start({ title: 'T', steps: [{ tool: 'del' }], turn: 1 });
  pending.action = null;
  assert.equal(runner.cancel(r.task.id).ok, true);
  assert.deepEqual(seen, []);
  assert.equal(store.get(r.task.id).status, 'cancelled');
});

test('onConfirmResolved: no note when the yes finished the task', async () => {
  const { runner, store } = setup(name => (name === 'del' ? { ok: true, text: ASK } : ok(name)));
  const r = await runner.start({ title: 'T', steps: [{ tool: 'a' }, { tool: 'del' }], turn: 1 });
  assert.equal(runner.onConfirmResolved({ tool: 'del', summary: SUMMARY, ok: true, text: 'Deleted x.' }), undefined);
  assert.equal(store.get(r.task.id).status, 'done');
});

test('maybeRan: a write step cut off by an abort asks on resume, survives status, runs on the second resume', async () => {
  const ac = new AbortController();
  let hang = true;
  const { runner, calls, store } = setup(name => { if (name === 'send_message' && hang) { ac.abort(); return { ok: false, text: 'aborted' }; } return ok(name); });
  const r = await runner.start({ title: 'T', steps: [{ tool: 'a' }, { tool: 'send_message' }, { tool: 'c' }], turn: 1, signal: ac.signal });
  const id = r.task.id;
  let t = store.get(id);
  assert.equal(t.status, 'paused');
  assert.equal(t.steps[1].status, 'pending');
  assert.equal(t.steps[1].maybeRan, true);
  hang = false;
  const ask = await runner.resume(id, { turn: 2 });
  assert.ok(ask.text.startsWith(NEEDS_OK));
  assert.match(ask.text, /may already have run/);
  assert.equal(calls.length, 2);
  runner.status(id);
  runner.current();
  t = store.get(id);
  assert.equal(t.status, 'paused');
  assert.equal(t.steps[1].maybeRan, 'asked');
  const go = await runner.resume(id, { turn: 3 });
  assert.equal(go.ok, true);
  assert.deepEqual(calls.map(c => c.name), ['a', 'send_message', 'send_message', 'c']);
  assert.equal(store.get(id).steps[1].maybeRan, undefined);
});

test('maybeRan: the restart question is recorded and asked again only until answered', async () => {
  const { runner, calls, store } = setup(ok);
  const id = seed(store, [step('s1', 'send_message', 'running')], 'interrupted');
  await runner.resume(id, { turn: 2 });
  assert.equal(store.get(id).steps[0].maybeRan, 'asked');
  assert.match(runner.status(id).text, /paused/);
  assert.equal(store.get(id).steps[0].maybeRan, 'asked');
  assert.equal(calls.length, 0);
  assert.equal((await runner.resume(id, { turn: 3 })).ok, true);
  assert.equal(calls.length, 1);
});

test('maybeRan: a read-only step cut off by an abort is simply re-run', async () => {
  const ac = new AbortController();
  let first = true;
  const { runner, calls, store } = setup(name => { if (first) { first = false; ac.abort(); return { ok: false, text: 'aborted' }; } return ok(name); });
  const r = await runner.start({ title: 'T', steps: [{ tool: 'get_time' }], turn: 1, signal: ac.signal });
  assert.equal(store.get(r.task.id).steps[0].maybeRan, undefined);
  assert.equal((await runner.resume(r.task.id, { turn: 2 })).ok, true);
  assert.equal(calls.length, 2);
});

test('origin keeps the source and a given sessionId, not the turn object', async () => {
  const { runner, store } = setup(ok);
  const a = await runner.start({ title: 'T', steps: [{ tool: 'a' }], turn: { source: 'voice', tainted: false, extra: 1 }, sessionId: 'S1' });
  assert.deepEqual(store.get(a.task.id).origin, { source: 'voice', sessionId: 'S1' });
  const b = await runner.start({ title: 'T', steps: [{ tool: 'a' }], turn: 1 });
  assert.deepEqual(store.get(b.task.id).origin, { source: null });
});

// Second fix wave: two-stage confirms, status taint, settled confirm steps, declined last step.
test('reask: a two-stage confirm follows the new summary; an unrelated summary still does not match', async () => {
  const { runner, store, pending } = setup(name => (name === 'del' ? { ok: true, text: ASK } : ok(name)));
  const r = await runner.start({ title: 'T', steps: [{ tool: 'del' }, { tool: 'c' }], turn: 1 });
  // first yes ran the action, which proposed a second question
  pending.action = { tool: 'del', summary: 'Force delete x' };
  runner.onConfirmReasked({ tool: 'del', from: 'Something else', summary: 'Force delete x' });
  assert.equal(store.get(r.task.id).steps[0].askedFor, SUMMARY, 'a re-ask of another proposal is ignored');
  runner.onConfirmReasked({ tool: 'del', from: SUMMARY, summary: 'Force delete x' });
  let t = store.get(r.task.id);
  assert.equal(t.steps[0].askedFor, 'Force delete x');
  assert.equal(runner.status(r.task.id).ok, true);
  t = store.get(r.task.id);
  assert.equal(t.status, 'awaiting_confirm', 'the new proposal keeps the task waiting');
  assert.equal(runner.onConfirmResolved({ tool: 'del', summary: SUMMARY, ok: true, text: 'x' }), undefined, 'the old summary no longer matches');
  runner.onConfirmResolved({ tool: 'del', summary: 'Force delete x', ok: true, text: 'Force deleted x.' });
  t = store.get(r.task.id);
  assert.equal(t.steps[0].status, 'done');
  assert.equal(t.steps[0].result.text, 'Force deleted x.');
  assert.equal(t.status, 'paused');
});

test('status of a tainted task taints the passed turn; a clean task does not', async () => {
  const { runner, store, clock } = setup(ok);
  const clean = seed(store, [step('s1', 'a', 'done')]);
  const turn1 = { source: 'chat', tainted: false };
  runner.status(clean, { turn: turn1 });
  assert.equal(turn1.tainted, false);
  clock.t += 10;
  const dirty = seed(store, [step('s1', 'read_page', 'done'), step('s2', 'b', 'pending')]);
  const t = store.get(dirty); t.tainted = true; store.save(t);
  const turn2 = { source: 'chat', tainted: false };
  runner.status(dirty, { turn: turn2 });
  assert.equal(turn2.tainted, true);
  const turn3 = { source: 'chat', tainted: false };
  runner.status(undefined, { turn: turn3 });   // newest open task is the tainted one
  assert.equal(turn3.tainted, true);
});

test('a settled confirm step does not make a tainted task unresumable or unreplannable', async () => {
  const { runner, calls, store } = setup(ok);
  const id = seed(store, [step('s1', 'del', 'done'), step('s2', 'read_page', 'done'), step('s3', 'b', 'pending')]);
  const t = store.get(id); t.tainted = true; store.save(t);
  const r = await runner.resume(id, { turn: { source: 'chat', tainted: false } });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map(c => c.name), ['b']);
  const f = seed(store, [step('s1', 'del', 'done'), step('s2', 'b', 'failed')], 'failed');
  const ft = store.get(f); ft.tainted = true; store.save(ft);
  const rp = await runner.replan(f, [{ tool: 'c' }], { turn: { source: 'chat', tainted: false } });
  assert.equal(rp.ok, true);
  const bad = seed(store, [step('s1', 'del', 'done'), step('s2', 'b', 'failed')], 'failed');
  const bt = store.get(bad); bt.tainted = true; store.save(bt);
  const rb = await runner.replan(bad, [{ tool: 'del' }], { turn: { source: 'chat', tainted: false } });
  assert.equal(rb.ok, false);
  assert.match(rb.text, /needs the user's OK/);
});

test('start without a turn object still refuses a confirm step after an untrusted one', async () => {
  const { runner, calls, store } = setup(name => (name === 'read_page' ? { ok: true, text: 'p', untrusted: true } : name === 'del' ? { ok: true, text: ASK } : ok(name)));
  const r = await runner.start({ title: 'T', steps: [{ tool: 'read_page' }, { tool: 'del' }] });
  assert.equal(r.ok, false);
  assert.deepEqual(calls.map(c => c.name), ['read_page']);
  assert.equal(store.get(r.task.id).steps[1].status, 'failed');
});

test('a no to the last step leaves the task paused', async () => {
  const { runner, store } = setup(name => (name === 'del' ? { ok: true, text: ASK } : ok(name)));
  const r = await runner.start({ title: 'T', steps: [{ tool: 'a' }, { tool: 'del' }], turn: 1 });
  runner.onConfirmResolved({ tool: 'del', summary: SUMMARY, ok: true, text: 'Cancelled.', declined: true });
  const t = store.get(r.task.id);
  assert.equal(t.steps[1].status, 'skipped');
  assert.equal(t.status, 'paused');
});
