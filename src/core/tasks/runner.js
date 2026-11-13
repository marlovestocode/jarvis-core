'use strict';
// Persistent task runner: plans become stored tasks and run step by step through the injected tools.run.
// Every step is saved as `running` before its tool is called and as `done`/`failed` after (write-ahead),
// so a crash leaves an accurate record. Report text is built only from stored step records.
const { validatePlan, resolveRefs, check } = require('./plan');
const { NEEDS_OK, UNTRUSTED_TOOLS } = require('../brain/guard');
const { isReadOnly } = require('./effects');

const NO_RETRY = /not running|not in Ollama|not allowed|must be local|timed out|aborted/i;
const LINE_CAP = 160;
const MAX_REPLANS = 2;
const FINISHED = ['done', 'cancelled', 'failed'];
const isFinished = t => FINISHED.includes(t.status);
// A failed task can still be replanned or cancelled; only done and cancelled are closed.
const isClosed = t => t.status === 'done' || t.status === 'cancelled';
const settled = s => s.status === 'done' || s.status === 'skipped';

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
  const done = task.steps.filter(s => s.status === 'done').length;
  return `Done: ${done}/${n} steps\n${task.steps.map(stepLine).join('\n')}`;
}

function reportFailed(task, step, why) {
  const completed = task.steps.filter(s => s.status === 'done');
  const head = `Task ${task.id} "${task.title}" stopped at ${step.id} (${step.tool}): ${why}`;
  const lines = completed.length ? `Completed: ${completed.map(stepLine).join('; ')}` : 'No steps completed.';
  return `${head}\n${lines}\nUse task_control with action replan to fix the remaining steps, or cancel to drop the task.`;
}

function createTaskRunner({ store, tools, bus, riskOf = () => undefined, confirmPending = () => null, onCancel = null, now = Date.now, log = () => {}, retryDelayMs = 0 }) {
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

  const inFlight = new Set();
  const stops = new Map();   // id → 'paused' | 'cancelled', requested while the task is running

  // Runs pending steps in order. Shared by start, resume and replan.
  async function execute(task, opts = {}) {
    inFlight.add(task.id);
    try { return await runSteps(task, opts); } finally { inFlight.delete(task.id); stops.delete(task.id); }
  }

  async function runSteps(task, { turn, signal } = {}) {
    task.status = 'running';
    for (const step of task.steps) {
      if (settled(step)) continue;
      if (signal?.aborted || stops.has(task.id)) {
        task.status = stops.get(task.id) || 'paused';
        const err = persist(task);
        if (!err) emit('task', { id: task.id, step: step.id, status: task.status });
        return { ok: false, text: err || `Task ${task.id} ${task.status} before ${step.id}. ${describe(task)}`, task };
      }
      // Results read so far may carry untrusted text into this step's args: no confirm tool from them.
      if ((turn?.tainted || task.tainted) && riskOf(step.tool) === 'confirm') return fail(task, step, `${step.tool} needs the user's OK, and this task read untrusted content. Do that action directly with the user instead`);
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
      if (result.untrusted || UNTRUSTED_TOOLS.has(step.tool)) {
        // The orchestrator's turn is shared by reference: later steps and the rest of the turn see the taint.
        if (turn && typeof turn === 'object') turn.tainted = true;
        task.tainted = true;
      }
      const awaiting = text.startsWith(NEEDS_OK);
      const verdict = awaiting ? { ok: false } : result.ok ? check(step.expect, result) : { ok: false, why: `the tool reported an error: ${clip(text, 200)}` };
      emit('tool', { id: toolId(task, step), name: step.tool, phase: 'end', ok: verdict.ok });

      delete step.asked;
      delete step.askedFor;
      delete step.maybeRan;
      if (awaiting || (!verdict.ok && signal?.aborted)) {
        // A confirm tool only proposed its action: nothing ran, the question goes to the user as is.
        step.status = 'pending';
        if (awaiting) {
          step.asked = true;
          step.askedFor = pendingAction()?.summary ?? null;   // which proposal this step waits on
        } else if (mayAct(step)) step.maybeRan = true;   // cut off mid-call: it may have acted
        task.status = awaiting ? 'awaiting_confirm' : 'paused';
        const err = persist(task);
        if (!err) emit('task', { id: task.id, step: step.id, status: task.status });
        return { ok: false, text: err || (awaiting ? text : `Task ${task.id} paused during ${step.id}. ${describe(task)}`), task };
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

  const pendingAction = () => { try { return confirmPending() || null; } catch { return null; } };
  // A step that may change something: not read-only, and not a confirm tool (which only proposes).
  const mayAct = step => !isReadOnly(step.tool) && riskOf(step.tool) !== 'confirm';
  const sameProposal = (step, tool, summary) => !!step.asked && step.tool === tool && (step.askedFor ?? null) === (summary ?? null);
  // A task that read untrusted content keeps that taint in every later turn that runs it.
  function runTurn(turn, task) {
    const t = turn && typeof turn === 'object' ? turn : {};
    if (task.tainted) t.tainted = true;
    return t;
  }

  const validate = (steps, turn) => validatePlan(steps, { resolves: n => tools.resolves(n), riskOf, tainted: !!turn?.tainted });

  // An awaiting_confirm task stays so only while confirm still holds its step's action; otherwise
  // the question was answered elsewhere, timed out or dropped, and the task is paused.
  function reconcile(task) {
    if (task?.status !== 'awaiting_confirm') return task;
    const p = pendingAction();
    const asked = task.steps.find(s => s.asked);
    if (asked && p && sameProposal(asked, p.tool, p.summary)) return task;
    task.status = 'paused';
    persist(task);
    return task;
  }

  function tasksNewestFirst() {
    try { return store.list().map(t => store.get(t.id)).filter(Boolean); } catch (err) {
      log(`task list failed: ${err.message}`);
      return [];
    }
  }

  // Only one task may wait on the user's answer at a time.
  function blocker(exceptId) {
    const t = tasksNewestFirst().find(x => x.id !== exceptId && reconcile(x).status === 'awaiting_confirm');
    return t ? `Task ${t.id} "${t.title}" is waiting for your answer. Answer it or cancel that task first.` : null;
  }

  async function start({ title, steps, turn, sessionId, signal } = {}) {
    const plan = validate(steps, turn);
    if (!plan.ok) return { ok: false, text: plan.text };
    const busy = blocker();
    if (busy) return { ok: false, text: busy };
    let task;
    try {
      task = store.create({ title: String(title || 'Untitled task').slice(0, 120), steps: plan.steps, origin: { source: turn?.source ?? null, ...(sessionId ? { sessionId } : {}) } });
    } catch (err) {
      return { ok: false, text: String(err?.message || err) };
    }
    return execute(task, { turn, signal });
  }

  // Loads a task for resume/replan; returns { task } or { refusal }.
  function loadUnfinished(id) {
    const task = reconcile(store.get(id));
    if (!task) return { refusal: `No task ${id}.` };
    if (task.status === 'done' || task.status === 'cancelled') return { refusal: `Task ${id} is already ${task.status}.`, task };
    if (inFlight.has(id)) return { refusal: `Task ${id} is already running.`, task };
    if (task.status === 'awaiting_confirm') return { refusal: `Task ${id} is waiting for your answer: say yes or no.`, task };
    const busy = blocker(id);
    return busy ? { refusal: busy, task } : { task };
  }

  async function resume(id, { turn, signal } = {}) {
    const { task, refusal } = loadUnfinished(id);
    if (refusal) return { ok: false, text: refusal };
    if (task.status === 'failed') return { ok: false, text: `Task ${id} failed. Use task_control with action replan to fix the remaining steps, or cancel it.` };
    turn = runTurn(turn, task);
    if (turn.tainted && task.steps.some(s => !settled(s) && riskOf(s.tool) === 'confirm')) {
      return { ok: false, text: `Task ${id} has a step that needs the user's OK, and this turn or task was influenced by untrusted content. Ask the user to resume it directly.` };
    }
    // A step cut off mid-call (running after a restart, or flagged maybeRan) may have acted. The first
    // resume asks; a resume after that question is the user's explicit go-ahead and runs it.
    // Read-only and confirm steps (a confirm tool only proposes) are simply run again.
    const mid = task.steps.find(s => s.status === 'running' || (s.status === 'pending' && s.maybeRan));
    if (mid?.maybeRan === 'asked') delete mid.maybeRan;
    else if (mid && mayAct(mid)) {
      mid.status = 'pending';
      mid.maybeRan = 'asked';
      task.status = 'awaiting_confirm';
      const err = persist(task);
      if (err) return { ok: false, text: err };
      emit('task', { id, step: mid.id, status: 'awaiting_confirm' });
      const what = `${mid.tool} ${clip(JSON.stringify(mid.args ?? {}), 80)}`;
      return { ok: false, text: `${NEEDS_OK}Step ${mid.id} of task ${id} may already have run: ${what}. Run it again? Say "resume the task" to run it, or "cancel the task" to drop it.`, task };
    }
    return execute(task, { turn, signal });
  }

  async function replan(id, steps, { turn, signal } = {}) {
    const { task, refusal } = loadUnfinished(id);
    if (refusal) return { ok: false, text: refusal };
    const k = task.steps.findIndex(s => s.status === 'failed');
    if (task.status !== 'failed' || k < 0) return { ok: false, text: `Task ${id} has no failed step to replan (it is ${task.status}).` };
    if ((task.replans || 0) >= MAX_REPLANS) return { ok: false, text: `Task ${id} was already replanned ${MAX_REPLANS} times. Cancel it and start a new task.` };
    if (!Array.isArray(steps) || !steps.length) return { ok: false, text: 'Replan needs at least one step.' };
    turn = runTurn(turn, task);
    const kept = task.steps.slice(0, k);
    // Kept steps are settled, so only the new ones are held to the taint rule.
    const plan = validate([...kept.map(s => ({ tool: s.tool, args: s.args, expect: s.expect })), ...steps], {});
    if (!plan.ok) return { ok: false, text: plan.text };
    const risky = turn.tainted ? plan.steps.slice(k).find(s => riskOf(s.tool) === 'confirm') : null;
    if (risky) return { ok: false, text: `Step ${risky.id} uses "${risky.tool}", which needs the user's OK, and this task read untrusted content. Do that action directly with the user instead.` };
    task.steps = [...kept, ...plan.steps.slice(k)];
    task.replans = (task.replans || 0) + 1;
    return execute(task, { turn, signal });
  }

  // Pause or cancel an unfinished task; one running in this process stops at its next step boundary.
  function control(id, to) {
    const task = reconcile(store.get(id));   // a stale question is not this task's: cancelling must not clear another
    if (!task) return { ok: false, text: `No task ${id}.` };
    if (to === 'paused' ? isFinished(task) : isClosed(task)) return { ok: false, text: `Task ${id} is already ${task.status}; nothing to ${to === 'paused' ? 'pause' : 'cancel'}.` };
    if (inFlight.has(id)) {
      stops.set(id, to);
      return { ok: true, text: `Task ${id} will be ${to} after its current step.` };
    }
    if (to === 'paused' && task.status === 'paused') return { ok: true, text: `Task ${id} is already paused.` };
    const wasAwaiting = task.status === 'awaiting_confirm';
    task.status = to;
    const err = persist(task);
    if (!err) emit('task', { id, step: null, status: to });
    // A cancelled task's question must not stay answerable: a later yes would run the dropped action.
    if (to === 'cancelled' && wasAwaiting && onCancel) { try { onCancel(task); } catch (e) { log(`task ${id} onCancel failed: ${e?.message || e}`); } }
    return { ok: !err, text: err || `Task ${id} "${task.title}" ${to}.` };
  }

  // The report quotes step results: a tainted task's text taints the turn that reads it.
  function status(id, { turn } = {}) {
    let task;
    if (id) task = store.get(id);
    else {
      const all = tasksNewestFirst();
      task = all.find(t => !isClosed(t)) || all[0];
    }
    if (!task) return { ok: false, text: id ? `No task ${id}.` : 'There are no tasks.' };
    if (task.tainted && turn && typeof turn === 'object') turn.tainted = true;
    return { ok: true, text: describe(reconcile(task)) };
  }

  // Told by confirm once a proposal was answered. Matches the waiting step by tool and the proposal's
  // summary, so another proposal never resolves a stale step. Returns a line for the user, or nothing.
  function onConfirmResolved({ tool, summary, ok, text, declined } = {}) {
    const task = tasksNewestFirst().find(t => t.status === 'awaiting_confirm' && t.steps.some(s => sameProposal(s, tool, summary)));
    if (!task) return undefined;
    const step = task.steps.find(s => sameProposal(s, tool, summary));
    delete step.asked;
    delete step.askedFor;
    step.status = declined ? 'skipped' : ok ? 'done' : 'failed';
    if (!declined) step.result = { ok: !!ok, text: String(text ?? ''), t: now() };
    const next = task.steps.find(s => !settled(s));
    // only a yes that settles the last step finishes the task; a no leaves it paused
    task.status = step.status === 'failed' ? 'failed' : step.status === 'done' && !next ? 'done' : 'paused';
    if (persist(task)) return undefined;
    emit('task', { id: task.id, step: step.id, status: step.status });
    return step.status === 'done' && next ? `Task ${task.id} paused at ${next.id}; say "resume the task" to finish it.` : undefined;
  }

  // A two-stage confirm (e.g. close, then "still open, force close it?"): the yes ran the first proposal
  // and a new one is pending. The waiting step follows it, so the second answer resolves the step.
  function onConfirmReasked({ tool, from, summary } = {}) {
    const task = tasksNewestFirst().find(t => t.status === 'awaiting_confirm' && t.steps.some(s => sameProposal(s, tool, from)));
    if (!task) return;
    task.steps.find(s => sameProposal(s, tool, from)).askedFor = summary ?? null;
    persist(task);
  }

  function active() {
    const t = tasksNewestFirst().find(x => !isFinished(x));
    if (!t) return null;
    return { id: t.id, title: t.title, status: t.status, done: t.steps.filter(s => s.status === 'done').length, total: t.steps.length };
  }

  // The newest task still open for control (a failed one counts: it can be replanned or cancelled).
  function current() {
    const t = tasksNewestFirst().find(x => !isClosed(x));
    return t ? { id: t.id, status: reconcile(t).status } : null;
  }

  function lastFinished(withinMs) {
    const t = tasksNewestFirst().find(x => x.status === 'done' || x.status === 'failed');
    return t && now() - (t.updated || 0) <= withinMs ? { id: t.id, status: t.status } : null;
  }

  return {
    start, resume, replan, status, onConfirmResolved, onConfirmReasked, active, current, lastFinished, describe, execute,
    pause: id => control(id, 'paused'),
    cancel: id => control(id, 'cancelled'),
  };
}

module.exports = { createTaskRunner };
