'use strict';
// Persistent task runner: plans become stored tasks and run step by step through the injected tools.run.
// Every step is saved as `running` before its tool is called and as `done`/`failed` after (write-ahead),
// so a crash leaves an accurate record. Report text is built only from stored step records.
const { validatePlan, resolveRefs, check } = require('./plan');
const { NEEDS_OK } = require('../brain/guard');

const NO_RETRY = /not running|not in Ollama|not allowed|must be local|timed out|aborted/i;
const LINE_CAP = 160;

const clip = (s, n = LINE_CAP) => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 3) + '...' : one;
};
const sleep = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

// Results of finished steps keyed by step id, the only source refs may read from.
function doneResults(task) {
  const m = new Map();
  for (const s of task.steps) if (s.status === 'done' && s.result) m.set(s.id, s.result.text);
  return m;
}

function stepLine(s) {
  const mark = s.status === 'done' ? clip(s.result?.text) : s.status;
  return `${s.id} ${s.tool}: ${mark}`;
}

function describe(task) {
  const done = task.steps.filter(s => s.status === 'done').length;
  return `Task ${task.id} "${task.title}" is ${task.status} (${done}/${task.steps.length} steps done).\n${task.steps.map(stepLine).join('\n')}`;
}

function reportDone(task) {
  const n = task.steps.length;
  return `Done: ${n}/${n} steps\n${task.steps.map(stepLine).join('\n')}`;
}

function reportFailed(task, step, why) {
  const completed = task.steps.filter(s => s.status === 'done');
  const head = `Task ${task.id} "${task.title}" stopped at ${step.id} (${step.tool}): ${why}`;
  const lines = completed.length ? `Completed: ${completed.map(stepLine).join('; ')}` : 'No steps completed.';
  return `${head}\n${lines}\nUse task_control with action replan to fix the remaining steps, or cancel to drop the task.`;
}

function createTaskRunner({ store, tools, bus, riskOf = () => undefined, confirmPending = () => null, now = Date.now, log = () => {}, retryDelayMs = 0 }) {
  const emit = (type, payload) => { try { bus?.emit(type, payload); } catch { /* observers must not break a run */ } };
  const toolId = (task, step) => `${task.id}:${step.id}`;

  function persist(task) {
    try { store.save(task); return null; } catch (err) {
      log(`task ${task.id} save failed: ${err.message}`);
      return `Task ${task.id} stopped: could not save progress (${err.message}). No further steps were run.`;
    }
  }

  // One tool call with at most one retry for transient errors.
  async function callWithRetry(step, args, ctx, signal) {
    let result;
    step.attempts = 0;
    step.result = null;
    while (step.attempts < 2) {
      step.attempts++;
      try { result = await tools.run(step.tool, args, ctx); } catch (err) { result = { ok: false, text: String(err?.message || err) }; }
      if (result?.ok || NO_RETRY.test(String(result?.text ?? '')) || signal?.aborted || step.attempts >= 2) break;
      await sleep(retryDelayMs);
    }
    return result || { ok: false, text: 'tool returned nothing' };
  }

  // Marks the step and the task failed; returns the run outcome.
  function fail(task, step, why) {
    step.status = 'failed';
    task.status = 'failed';
    const err = persist(task);
    if (!err) emit('task', { id: task.id, step: step.id, status: 'failed' });
    return { ok: false, text: err || reportFailed(task, step, why), task };
  }

  // Runs pending steps in order. Shared by start and (later) resume/replan.
  async function execute(task, { turn, signal } = {}) {
    task.status = 'running';
    for (const step of task.steps) {
      if (step.status === 'done') continue;
      if (signal?.aborted) {
        task.status = 'paused';
        const err = persist(task);
        if (!err) emit('task', { id: task.id, step: step.id, status: 'paused' });
        return { ok: false, text: err || `Task ${task.id} paused before ${step.id}. ${describe(task)}`, task };
      }
      const refs = resolveRefs(step.args, doneResults(task));
      if (!refs.ok) return fail(task, step, refs.text);

      step.status = 'running';
      const saveErr = persist(task);
      if (saveErr) return { ok: false, text: saveErr, task };
      emit('task', { id: task.id, step: step.id, status: 'running' });

      emit('tool', { id: toolId(task, step), name: step.tool, phase: 'start', ok: true });
      const result = await callWithRetry(step, refs.args, { signal, turn }, signal);
      const text = String(result.text ?? '');
      step.result = { ok: !!result.ok, text, t: now() };
      const awaiting = text.startsWith(NEEDS_OK);
      const verdict = awaiting ? { ok: false } : result.ok ? check(step.expect, result) : { ok: false, why: `the tool reported an error: ${clip(text, 200)}` };
      emit('tool', { id: toolId(task, step), name: step.tool, phase: 'end', ok: verdict.ok });

      if (awaiting || (!verdict.ok && signal?.aborted)) {
        step.status = 'pending';
        task.status = 'paused';
        const err = persist(task);
        if (!err) emit('task', { id: task.id, step: step.id, status: 'paused' });
        if (!awaiting) return { ok: false, text: err || `Task ${task.id} paused during ${step.id}. ${describe(task)}`, task };
        return { ok: false, text: err || `Task ${task.id} is waiting at ${step.id}: ${clip(text, 200)}`, task };
      }
      if (!verdict.ok) return fail(task, step, verdict.why);

      step.status = 'done';
      const err = persist(task);
      if (err) return { ok: false, text: err, task };
      emit('task', { id: task.id, step: step.id, status: 'done' });
    }
    task.status = 'done';
    const err = persist(task);
    if (!err) emit('task', { id: task.id, step: null, status: 'done' });
    return { ok: !err, text: err || reportDone(task), task };
  }

  async function start({ title, steps, turn, sessionId, signal } = {}) {
    const plan = validatePlan(steps, { resolves: n => tools.resolves(n), riskOf });
    if (!plan.ok) return { ok: false, text: plan.text };
    let task;
    try {
      task = store.create({ title: String(title || 'Untitled task').slice(0, 120), steps: plan.steps, origin: { turn, sessionId } });
    } catch (err) {
      return { ok: false, text: String(err?.message || err) };
    }
    return execute(task, { turn, signal });
  }

  return { start, describe, execute };
}

module.exports = { createTaskRunner };
