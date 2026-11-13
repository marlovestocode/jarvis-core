# Task Continuity + Cross-System Task Execution — Design

Date: 2026-11-12
Roadmap items: 4 (persistent task continuity) and 7 (cross-system task execution), sub-project 3.

## Goal

Multi-step jobs that run several skills in one operation, pass structured results between steps, validate each step, recover from a failed step without restarting, and report what actually happened. Task state survives turns and app restarts. The user can inspect, pause, resume or cancel. Sensitive or destructive steps keep requiring confirmation. Completed steps are not repeated after a restart.

Success:
- A model-planned job of up to 12 steps runs to completion through the existing tool runner, with results passed between steps.
- A failed step stops the run with evidence; a replan changes only the remaining steps.
- After a crash or restart, `resume` skips done steps and never silently re-runs a step that changes something.
- Confirm-risk steps still need the user's yes; tainted turns cannot plan them.
- Behaviour of every non-task request is unchanged; full test suite and `eval/run.js` stay green.

## Decisions (from brainstorming)

1. The model plans, the runner executes. One tool call carries the whole plan; execution is deterministic.
2. Steps pass data with refs and are checked with `expect`; a failed step is recovered by up to 2 replans of the remaining steps, driven through the model's normal tool loop.
3. Persistence is one file per task, `<data>/tasks/<id>.json`, atomic and bounded.
4. A confirm step pauses the task and asks, using the existing confirm flow.
5. Tasks run inside the turn (single-flight preserved). Control is by fast-path commands and tools. A background executor is a later step; the file format does not change for it.

## Out of scope

Background execution, scheduled or recurring tasks, nested tasks, parallel steps, any change to `route()` / `selectGroups()` (sub-project 2), changes to live state persistence, Cortex.

## Constraints

- Extend, do not replace, the orchestrator and tool runner. Steps run through `tools.run`, so arg checks, taint refusal, timeouts and stats apply.
- Must not conflict with adaptive routing: `route` and `selectGroups` signatures and behaviour are untouched; the two task tools live in the always-loaded `core` group, so no skill triggers change.
- Live state stays in-memory; it gains one small read-only source for the active task.

## Components (all new, `src/core/tasks/`)

- `store.js` — `createTaskStore({ dir, now, log })` → `{ create, get, save, list, remove, sweep }`. One file per task, temp-file-then-rename. Bounds: 50 tasks (finished ones pruned oldest-first and after 14 days), 12 steps, 4 KB stored per step result. A corrupt file moves to `tasks/broken/` and only that task is lost. `sweep()` at startup turns `running` tasks into `interrupted`.
- `plan.js` — pure. `validatePlan(steps, { resolves, clean })`: at most 12 steps, every tool known, refs only to earlier steps, `expect` limited to `ok`, `nonEmpty`, `contains`, `matches`, confirm-risk tools refused when the turn is tainted. `resolveRefs(args, results)`: `{"$ref":"s1"}` is the whole text; `{"$ref":"s1","pick":...}` is a JSON path when the result is JSON, else a regex capture. `check(step, result)`.
- `effects.js` — allowlist of read-only tool names. Any tool not listed counts as "changes something". No new metadata on existing tools.
- `runner.js` — `createTaskRunner({ store, tools, bus, now })` → `{ run, resume, control }`. See Run flow.
- `src/core/tools/tasks.js` — `task_run({ title, steps })` and `task_control({ id?, action, steps? })` with action `status | pause | resume | cancel | replan`. Registered in the `core` group.
- `src/core/tasks/skill.js` — deterministic fast-path (not under `skills/`, which holds loadable groups): phrases containing "task" ("task status", "pause the task", "resume the task", "cancel the task") and "what happened" shortly after a task finished or failed; only when a task exists. Bare "resume", "pause" and "cancel" never match: they belong to media and live-state follow-ups.

### Task record

```
{ id, v: 1, title, status, origin: { sessionId }, created, updated, replans,
  steps: [{ id: 's1', tool, args, expect, status, attempts, result: { ok, text, t } }] }
```
`status`: `planned | running | awaiting_confirm | paused | interrupted | failed | done | cancelled`.
Step `status`: `pending | running | done | failed | skipped`.

## Run flow

1. `validatePlan`; an invalid plan returns an error text to the model and nothing is saved.
2. Save the task `running`. For each pending step: resolve refs (an unresolvable ref is a failed step); mark the step `running` and save (write-ahead); call `tools.run(tool, args, { signal, turn })`; store the capped result; mark `done` or `failed`; check `expect`. One retry for a transient failure; errors matching the orchestrator's `NO_RETRY` pattern are not retried. A failed step ends the run.
3. Emit `tool` bus events per step (live state keeps seeing them) and a `task` event (`id`, `step`, `status`).
4. Result text is built only from stored step records. Done: "Done: n/n steps" plus one line per step, returned as the tool result; the model words the final answer from it (the existing figure-grounding guard applies), there is no direct-reply path. Failed: the failing step and its evidence, the completed steps, and the instruction to call `task_control(replan)` or stop.
5. `replan` replaces only the pending steps after the failure (up to 2 per task) and continues. The runner never calls the provider.
6. Pause is checked between steps and on the turn's abort signal; the task is saved `paused`.

## Restart and crash

- Startup `sweep()`: `running` becomes `interrupted`. Nothing auto-resumes.
- `resume` skips `done` steps. A step found `running` is retried automatically only if its tool is in `effects.js`; otherwise the task goes `awaiting_confirm` with "Step n may already have run: <summary>. Run it again?".
- A write failure aborts the run: a task that cannot persist must not keep running.

## Confirm steps

- A step whose tool returns `NEEDS_OK` saves the task `awaiting_confirm` with the question, and the turn ends with that question as it does today.
- The user's yes goes to `confirm.handle`; an optional `onResolved(action, ok)` callback tells the runner the outcome. A no marks the step `skipped` and the task `paused`. Timeout (60 s) or any other message drops the question and leaves the task `paused`.
- After a restart, `resume` re-proposes the step. A confirmation never survives a crash.
- A task planned in a tainted turn cannot contain confirm tools; checked at plan time and again at each step.

## Errors and bounds

Corrupt file quarantined; one task lost at most. A task cannot start another task. Result text capped at 4 KB per step; plan at 12 steps; 2 replans; 50 stored tasks; 14-day pruning of finished tasks. Every new hook is wrapped: a failure falls back to today's behaviour.

## Wiring (only edits to existing files)

- `src/main/main.js`: create store and runner, register tools and the fast-path skill, add the live-state source `task`.
- `src/core/tools/registry.js` or the core skill's tool list: add the two tools to `core`.
- `src/core/pc/confirm.js`: optional `onResolved` callback.
- `src/core/orchestrator.js`: no loop change expected; at most forwarding `task` events.

These files carry the user's uncommitted edits, so they are edited in place and left unstaged.

## Testing (`test/*.test.js`, `node:test`)

A confirm step caught awaiting its answer carries `asked: true`; `resume` re-calls its tool to re-propose it (nothing ran, so it is not treated as a mid-flight write).


- `tasks-store`: atomic write and reload; pruning; 4 KB cap; corrupt file quarantined with others intact; sweep.
- `tasks-plan`: validation, forward refs rejected, pick (JSON and regex), every `expect`, tainted confirm refusal.
- `tasks-runner` with fake tools: ordering and result passing; failed `expect` stops with evidence; replan swaps only pending steps and caps at 2; restart skips done steps, retries a read-only mid-flight step, asks before a write step; pause at a boundary; confirm yes, no and timeout; persist failure aborts.
- `tasks-skill`: fast-path phrases with and without a task.
- Orchestrator: tasks option absent leaves behaviour identical; a `task_run` call goes through the existing loop.
- `eval/questions.json`: about 8 multi-step request cases for routing regressions via `eval/run.js`.
