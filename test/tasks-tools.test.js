const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskTools } = require('../src/core/tools/tasks');
const { createTasksSkill } = require('../src/core/tasks/skill');
const { NEEDS_OK } = require('../src/core/brain/guard');

function stubRunner({ failedId = null, exists = true, finished = null, text = 'ok' } = {}) {
  const calls = [];
  const rec = name => async (...a) => { calls.push([name, ...a]); return { ok: true, text: typeof text === 'function' ? text(name) : text }; };
  return {
    calls,
    start: rec('start'), resume: rec('resume'), replan: rec('replan'), pause: rec('pause'), cancel: rec('cancel'), status: (...a) => { calls.push(['status', ...a]); return exists ? { ok: true, text } : { ok: false, text: 'There are no tasks.' }; },
    active: () => null,   // never used by the skill: a failed task is not 'active'
    current: () => (exists ? { id: failedId || 't1', status: failedId ? 'failed' : 'paused' } : null),
    lastFinished: ms => { calls.push(['lastFinished', ms]); return finished; },
  };
}
const byName = (tools, n) => tools.find(t => t.name === n);

test('task_run forwards title, steps, turn, signal and returns the runner text', async () => {
  const r = stubRunner({ text: 'Done: 1/1 steps' });
  const [run] = createTaskTools({ runner: r });
  assert.equal(run.name, 'task_run');
  assert.equal(run.risk, 'safe');
  assert.equal(run.timeoutMs, 600000);
  assert.deepEqual(run.params.required, ['title', 'steps']);
  for (const w of ['s1', '$ref', 'pick', '12', 'expect']) assert.ok(run.description.includes(w), w);
  const turn = { source: 'voice' }, signal = new AbortController().signal;
  const steps = [{ tool: 'get_time', args: {} }];
  assert.equal(await run.run({ title: 'T', steps }, { turn, signal, sessionId: 'S' }), 'Done: 1/1 steps');
  assert.deepEqual(r.calls[0], ['start', { title: 'T', steps, turn, signal, sessionId: 'S' }]);
});

test('NEEDS_OK text is returned unchanged', async () => {
  const r = stubRunner({ text: NEEDS_OK + 'Delete it?' });
  const [run, ctl] = createTaskTools({ runner: r });
  assert.equal(await run.run({ title: 'T', steps: [] }, {}), NEEDS_OK + 'Delete it?');
  assert.equal(await ctl.run({ action: 'resume', id: 't1' }, {}), NEEDS_OK + 'Delete it?');
});

test('task_control dispatches each action', async () => {
  const r = stubRunner();
  const ctl = byName(createTaskTools({ runner: r }), 'task_control');
  assert.equal(ctl.timeoutMs, 600000);
  assert.deepEqual(ctl.params.required, ['action']);
  const turn = { source: 'chat' }, signal = new AbortController().signal;
  const ctx = { turn, signal, sessionId: 'S' };
  await ctl.run({ action: 'status', id: 't1' }, ctx);
  await ctl.run({ action: 'pause', id: 't1' }, ctx);
  await ctl.run({ action: 'cancel', id: 't1' }, ctx);
  await ctl.run({ action: 'resume', id: 't1' }, ctx);
  const steps = [{ tool: 'x', args: {} }];
  await ctl.run({ action: 'replan', id: 't1', steps }, ctx);
  assert.deepEqual(r.calls, [
    ['status', 't1', { turn }], ['pause', 't1'], ['cancel', 't1'],
    ['resume', 't1', { turn, signal, sessionId: 'S' }],
    ['replan', 't1', steps, { turn, signal, sessionId: 'S' }],
  ]);
});

test('task_control replan without steps is an error text', async () => {
  const r = stubRunner();
  const ctl = byName(createTaskTools({ runner: r }), 'task_control');
  const out = await ctl.run({ action: 'replan', id: 't1' }, {});
  assert.match(out, /steps/i);
  assert.equal(r.calls.length, 0);
  assert.match(await ctl.run({ action: 'dance' }, {}), /action/i);
});

test('skill matches task phrases and runs with an untainted turn', async () => {
  const phrases = [['task status', 'status'], ['what is the task', 'status'], ['how is the task going', 'status'],
    ['pause the task', 'pause'], ['resume the task', 'resume'], ['continue the task', 'resume'], ['cancel the task', 'cancel'], ['stop the task', 'cancel'],
    ['resume task', 'resume'], ['continue task', 'resume'], ['cancel task', 'cancel']];
  for (const [text, action] of phrases) {
    const r = stubRunner({ text: 'Task t1 is running.' });
    const out = await createTasksSkill({ runner: r }).handle(text, { source: 'voice' });
    assert.ok(out, text);
    assert.equal(out.tool, 'task_control');
    assert.equal(out.ok, true);
    assert.equal(out.reply, 'Task t1 is running.');
    assert.ok(out.record, text);
    if (action !== 'status') {
      const c = r.calls.find(x => x[0] === action);
      assert.ok(c, `${text} -> ${action}`);
    }
  }
  const r = stubRunner();
  await createTasksSkill({ runner: r }).handle('resume the task', { source: 'voice' });
  const c = r.calls.find(x => x[0] === 'resume');
  assert.equal(c[1], 't1');
  assert.deepEqual(c[2].turn, { source: 'voice', tainted: false });
});

test('what happened matches only after a recent finished task', async () => {
  const r = stubRunner({ finished: { id: 't9', status: 'done' }, text: 'Task t9 done' });
  const out = await createTasksSkill({ runner: r }).handle('what happened with the task', { source: 'chat' });
  assert.ok(out);
  assert.ok(r.calls.some(c => c[0] === 'lastFinished' && c[1] === 600000));
  assert.deepEqual(r.calls.find(c => c[0] === 'status'), ['status', 't9']);
  assert.ok(await createTasksSkill({ runner: stubRunner({ finished: { id: 't9', status: 'failed' } }) }).handle('what happened', {}));
  assert.equal(await createTasksSkill({ runner: stubRunner() }).handle('what happened', {}), null);
  assert.equal(await createTasksSkill({ runner: stubRunner() }).handle('what happened with the task', {}), null);
});

test('skill never matches bare control words, other subjects, or when no task exists', async () => {
  const s = createTasksSkill({ runner: stubRunner({ finished: { id: 't9', status: 'done' } }) });
  for (const t of ['resume', 'pause', 'cancel', 'pause the music', 'stop', 'continue', 'what is the weather']) assert.equal(await s.handle(t, {}), null, t);
  const none = createTasksSkill({ runner: stubRunner({ exists: false }) });
  for (const t of ['task status', 'resume the task', 'cancel the task']) assert.equal(await none.handle(t, {}), null, t);
});

test('skill speaks a NEEDS_OK question without the marker and forwards the turn signal', async () => {
  const r = stubRunner({ text: NEEDS_OK + 'Run again?' });
  const signal = new AbortController().signal;
  const out = await createTasksSkill({ runner: r }).handle('resume the task', { source: 'chat', signal });
  assert.equal(out.reply, 'Run again?');
  assert.equal(out.record, 'Run again?');
  const resume = r.calls.find(c => c[0] === 'resume');
  assert.equal(resume[2].signal, signal);
  assert.equal(resume[2].turn.source, 'chat');
});

test('cancel and resume reach a failed task that active() does not report', async () => {
  for (const [text, action] of [['cancel the task', 'cancel'], ['resume the task', 'resume'], ['stop the task', 'cancel']]) {
    const r = stubRunner({ failedId: 't7', text: 'refusal text' });
    const out = await createTasksSkill({ runner: r }).handle(text, { source: 'chat' });
    assert.equal(out.reply, 'refusal text');
    assert.equal(r.calls.find(c => c[0] === action)[1], 't7');
  }
});
