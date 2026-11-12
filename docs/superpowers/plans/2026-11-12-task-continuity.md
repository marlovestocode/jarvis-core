# Task Continuity + Cross-System Task Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistent, model-planned multi-step tasks that run through the existing tool runner, pass results between steps, recover from failures, survive restarts, and keep confirmation for risky steps.

**Architecture:** New `src/core/tasks/` modules (pure plan validation, per-task file store, runner). The runner executes steps through `tools.run`, so arg checks, taint refusal, timeouts and stats still apply. Two tools (`task_run`, `task_control`) in the `core` group and a no-LLM fast-path skill expose it. Replans go through the model's normal tool loop.

**Tech Stack:** Node (CommonJS), `node:test` (`npm test` runs `test/**/*.test.js`), Electron main wiring in `src/main/main.js`.

**Spec:** `docs/superpowers/specs/2026-11-12-task-continuity-design.md`

## Global Constraints

- Extend, do not replace, the orchestrator and tool runner; `route()` and `selectGroups()` signatures and behaviour unchanged (sub-project 2). Task tools go in the always-loaded `core` group; no new skill triggers.
- Bounds: 12 steps per plan, 2 replans per task, 50 stored tasks, finished tasks pruned after 14 days, 4096 chars stored per step result.
- Task files: `<data>/tasks/<id>.json`, atomic temp-file-then-rename; corrupt file moves to `<data>/tasks/broken/`; ids match `/^[a-z0-9]{4,24}$/`.
- Task `status`: `planned | running | awaiting_confirm | paused | interrupted | failed | done | cancelled`. Step `status`: `pending | running | done | failed | skipped`.
- Confirm steps keep the existing flow (`NEEDS_OK` text, 60 s window, `confirm.handle`); a task planned in a tainted turn cannot contain confirm tools.
- Live state stays in-memory; it only gains one read-only `task` source.
- **Commit rule:** commit only files this plan creates. `src/main/main.js`, `src/core/skills/core/index.js`, `src/core/pc/confirm.js`, `src/core/orchestrator.js`, `src/core/tools/registry.js` and `eval/questions.json` already hold the user's uncommitted edits: edit them in place, never `git add` them, and never use `git add -A` or `git commit -a`. Always `git add <explicit new paths>` then `git commit <same paths> -m ...`.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- A plan whose tool name is unknown, whose ref points forward or at a missing step, or with more than 12 steps: refused with a plain error and nothing saved (Task 1).
- A task id that is a path (`../x`, `a/b`) or a corrupt/partial file: rejected or quarantined, never read outside `tasks/` (Task 2).
- A ref `pick` that matches nothing, or a result larger than 4096 chars: a failed step with evidence, never a crash or an unbounded file (Tasks 1, 3).
- Starting a task while another is `awaiting_confirm` (the single confirm slot would be overwritten): refused with a clear message (Task 4).
- `replan` on a task with no failed step, a third `replan`, `resume` of a `done` task, `cancel` of a finished task: plain refusals or no-ops, no state change (Task 4).

---

### Task 1: Plan validation, refs and expect checks

**Files:**
- Create: `src/core/tasks/plan.js`
- Test: `test/tasks-plan.test.js`

**Interfaces:**
- Produces:
  - `MAX_STEPS = 12`
  - `validatePlan(steps, { resolves, riskOf, tainted }) → { ok: true, steps: Step[] } | { ok: false, text: string }` — `steps` input is `[{ tool, args?, expect? }]`; output steps are `{ id: 's1'.., tool, args, expect, status: 'pending', attempts: 0, result: null }`. `resolves(name) → boolean`, `riskOf(name) → string|undefined`, `tainted: boolean`.
  - `resolveRefs(args, results) → { ok: true, args } | { ok: false, text }`; `results` is `Map<stepId, text>`.
  - `check(expect, result) → { ok: boolean, why?: string }`; `result` is `{ ok, text }`.

- [ ] **Step 1: Write failing tests** in `test/tasks-plan.test.js`: `validatePlan` accepts a 2-step plan and assigns ids `s1`, `s2`; rejects empty plan, 13 steps, an unknown tool (`resolves` false), a ref to a later or missing step, an `expect` with two keys or an unknown key, and a `riskOf(...) === 'confirm'` tool when `tainted` is true (accepted when false). `resolveRefs`: `{ $ref: 's1' }` becomes the whole text; `{ $ref: 's1', pick: 'a.b[0]' }` picks from JSON text; `{ $ref: 's1', pick: '/id=(\\d+)/' }` returns capture group 1 (whole match if no group); refs nested inside arrays/objects resolve; a pick that matches nothing, non-JSON text with a JSON-path pick, or a ref to a step with no result returns `{ ok: false }` with the step id in `text`. `check`: default requires `result.ok` and not `softFail(text)` (from `src/core/brain/guard.js`); `{ nonEmpty: true }`, `{ contains: 'x' }` (case-insensitive), `{ matches: '^ok' }` each pass and fail correctly; an invalid regex in `matches` fails the check, not throws.
- [ ] **Step 2: Run** `node --test test/tasks-plan.test.js` → FAIL (module not found).
- [ ] **Step 3: Implement** `src/core/tasks/plan.js` per the signatures. `expect` allows exactly one of `nonEmpty | contains | matches`. Only whole-value refs (no string interpolation). Error texts name the step id and are written for the model to act on.
- [ ] **Step 4: Run** the same command → PASS.
- [ ] **Step 5: Commit** `git add src/core/tasks/plan.js test/tasks-plan.test.js` then `git commit src/core/tasks/plan.js test/tasks-plan.test.js -m "feat(tasks): plan validation, refs and expect checks"`.

### Task 2: Per-task file store

**Files:**
- Create: `src/core/tasks/store.js`
- Test: `test/tasks-store.test.js`

**Interfaces:**
- Produces: `createTaskStore({ dir, now = Date.now, log = () => {} })` → `{ create({ title, steps, origin }) → Task, get(id) → Task|null, save(task) → void (throws on write failure), list() → [{ id, title, status, updated }] newest first, remove(id), sweep() → number }`. Constants exported: `MAX_TASKS = 50`, `TTL_MS = 14*24*3600*1000`, `RESULT_CAP = 4096`. `Task = { id, v: 1, title, status, origin, created, updated, replans: 0, steps }`; `create` sets `status: 'planned'`. `save` truncates each `steps[i].result.text` to `RESULT_CAP` and sets `updated`.
- Consumes: steps shape from Task 1.

- [ ] **Step 1: Write failing tests** (use `fs.mkdtempSync` temp dirs): create then reload with a new store instance returns equal data; `get('../x')`, `get('a/b')`, `get('')` return null and read nothing outside `dir`; a corrupt file is moved to `<dir>/broken/<id>.json`, `get` returns null, other tasks still load; `save` caps result text at 4096 chars; `sweep()` turns every `running` task into `interrupted` and returns the count, leaving `awaiting_confirm` and others untouched; `create` prunes finished (`done|cancelled|failed`) tasks older than 14 days (fake `now`) and, over 50 tasks, the oldest finished ones; with 50 active tasks `create` throws an error whose message mentions too many open tasks; `save` throws when the dir is made unwritable (stub `fs.renameSync` via a read-only path or pass a `dir` that is a file); `list()` order is by `updated` desc.
- [ ] **Step 2: Run** `node --test test/tasks-store.test.js` → FAIL.
- [ ] **Step 3: Implement** following `src/core/timers/store.js` and `src/core/session.js` patterns (atomic write, quarantine, id regex). Ids: `'k' + now().toString(36) + counter.toString(36)`, retried until unused.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/core/tasks/store.js test/tasks-store.test.js`; `git commit <same paths> -m "feat(tasks): per-task file store with bounds and quarantine"`.

### Task 3: Runner core — run flow, write-ahead, report

**Files:**
- Create: `src/core/tasks/effects.js`, `src/core/tasks/runner.js`
- Test: `test/tasks-runner.test.js`

**Interfaces:**
- Consumes: `validatePlan`, `resolveRefs`, `check` (Task 1); `createTaskStore` (Task 2); `NEEDS_OK`, `softFail` from `src/core/brain/guard.js`.
- Produces:
  - `effects.js`: `READ_ONLY` (a `Set` of tool names: `get_time, calculate, convert_units, date_calc, differentiate, integrate, solve_equation, statistics, physics_constant, list_timers, list_windows, media_status, find_files, file_info, folder_size, big_files, list_recent_files, read_document, search_file_text, get_system_stats, get_weather, weather_alerts, news_headlines, sports_scores, lookup_knowledge, web_search, read_article, jarvis_status, self_diagnostics, self_log, skills_list, music_stats, ytm_library, browser_tabs, browser_search, browser_history_search, browser_bookmark_search, browser_read_page, recall_chats, memory_about, find_song_by_lyric, get_lyrics, analytics_summary`) and `isReadOnly(name) → boolean`.
  - `runner.js`: `createTaskRunner({ store, tools, bus, riskOf = () => undefined, confirmPending = () => null, now = Date.now, log = () => {}, retryDelayMs = 0 })` with `tools = { run(name, args, ctx), resolves(name) }`. Methods: `start({ title, steps, turn, sessionId, signal }) → Promise<{ ok, text, task? }>`, `describe(task) → string`. A run returns `{ ok, text, task }` where `text` is built only from stored step records.
  - Bus events: `tool` `{ id, name, phase:'start'|'end', ok }` per step (so live state sees them) and `task` `{ id, step, status }`.

- [ ] **Step 1: Write failing tests** with fake `tools` (scripted results) and a temp-dir store:
  - steps run in order and a `$ref` arg receives the earlier result text;
  - the task file shows step `running` before the tool resolves (assert inside the fake tool by reading the store) and `done` after (write-ahead);
  - a done run returns text starting `Done: 3/3 steps` with one line per step, status `done`;
  - a step failing its `expect` stops the run: status `failed`, later steps stay `pending`, text names the failing step and its evidence and mentions `task_control` with `replan`;
  - a transient error text is retried once (`attempts` 2); an error matching `not allowed|must be local|timed out|aborted|not running|not in Ollama` is not retried;
  - an unresolvable ref fails the step without calling the tool;
  - an aborted `signal` between steps saves `paused` and runs no further step;
  - when `store.save` throws mid-run the run stops with an error text and calls no further tool;
  - bus receives `tool` start/end and `task` events per step;
  - an invalid plan returns `{ ok: false }` and `store.list()` stays empty.
- [ ] **Step 2: Run** `node --test test/tasks-runner.test.js` → FAIL.
- [ ] **Step 3: Implement** `effects.js` and the `start`/run loop in `runner.js`. The loop is a shared internal `execute(task, { turn, signal })` that later tasks reuse for resume and replan. Step results store `{ ok, text, t }`; refs resolve from stored `done` results only.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/core/tasks/effects.js src/core/tasks/runner.js test/tasks-runner.test.js`; `git commit <same paths> -m "feat(tasks): runner with refs, expect checks and write-ahead saves"`.

### Task 4: Runner control — resume, replan, pause, cancel, confirm, restart

**Files:**
- Modify (ours): `src/core/tasks/runner.js`
- Test: `test/tasks-runner-control.test.js`

**Interfaces:**
- Consumes: Task 3's `execute`, `isReadOnly`.
- Produces on the runner: `resume(id, { turn, signal }) → { ok, text, task? }`, `replan(id, steps, { turn, signal }) → { ok, text, task? }`, `pause(id) → { ok, text }`, `cancel(id) → { ok, text }`, `status(id?) → { ok, text }` (no id = the newest unfinished task, else the newest task), `onConfirmResolved({ tool, ok, text, declined }) → void`, `active() → { id, title, status, done, total } | null` (for live state). Step gains optional `asked: boolean` (confirm proposed, answer not yet received).

- [ ] **Step 1: Write failing tests:**
  - **resume** skips `done` steps (fake tool counts calls) and finishes the rest; `resume` of a `done`, `cancelled` task returns `{ ok: false }` plainly;
  - **restart**: a task with a `running` read-only step (tool in `READ_ONLY`) is re-run on `resume`; with a write step it ends `awaiting_confirm` and the returned text starts with `NEEDS_OK` and says the step may already have run, without calling the tool;
  - **replan** after a failure replaces only steps after the failed one, re-validates them (refs may point at done steps), `replans` becomes 1, and runs them; the failed step is retried as the first replanned step only if included in `steps`; a third replan is refused; `replan` on a task with no failed step is refused; done steps are untouched;
  - **confirm**: a step whose tool returns `NEEDS_OK + 'Delete x. Say yes to confirm.'` sets task `awaiting_confirm`, step `asked: true`, and the run's text equals that tool text (so the orchestrator turns it into the question); `onConfirmResolved({ tool, ok: true, text })` marks the step `done` with that text and the task `paused` (resume continues); `declined: true` marks the step `skipped` and the task `paused`; `status()`/`resume` on an `awaiting_confirm` task whose `confirmPending()` is null reconciles it to `paused`; `resume` of a paused task with an `asked` step re-calls the tool to re-propose it;
  - **tainted**: `resume` with `turn.tainted` true on a task containing a confirm step refuses before running anything;
  - **single slot**: `start` or `resume` while another task is `awaiting_confirm` is refused with a message naming that task;
  - **pause/cancel**: `pause` on a non-running unfinished task sets `paused`; `cancel` sets `cancelled`; both are no-ops with a plain message on finished tasks;
  - `active()` returns null with no unfinished task.
- [ ] **Step 2: Run** `node --test test/tasks-runner-control.test.js` → FAIL.
- [ ] **Step 3: Implement** the methods in `runner.js` reusing `execute`. `confirmPending` is the injected `() => confirm.pending()`; `onConfirmResolved` matches the awaiting step by tool name.
- [ ] **Step 4: Run** `node --test test/tasks-runner.test.js test/tasks-runner-control.test.js` → PASS.
- [ ] **Step 5: Commit** `git add test/tasks-runner-control.test.js src/core/tasks/runner.js`; `git commit <same paths> -m "feat(tasks): resume, replan, pause, cancel, confirm and restart handling"`.

### Task 5: Tools and fast-path skill

**Files:**
- Create: `src/core/tools/tasks.js`, `src/core/tasks/skill.js`
- Test: `test/tasks-tools.test.js`

**Interfaces:**
- Consumes: runner API (Tasks 3–4); `NEEDS_OK` from guard.
- Produces:
  - `createTaskTools({ runner }) → [Tool, Tool]`: `task_run` (params `{ title: string, steps: array of { tool: string, args: object, expect: object } }`, required `title`, `steps`; `risk: 'safe'`; `timeoutMs: 600000`; description states step ids are `s1, s2…` in order and refs are `{"$ref":"s1"}` / `{"$ref":"s1","pick":"a.b[0]"}`, max 12 steps) and `task_control` (params `{ id?: string, action: enum status|pause|resume|cancel|replan, steps?: array }`, required `action`; `timeoutMs: 600000`). Both call the runner with `{ turn: ctx.turn, signal: ctx.signal, sessionId: ctx.sessionId }` and return `res.text`.
  - `createTasksSkill({ runner }) → { handle(text, { source }) → null | { reply, record, tool: 'task_control', ok } }`. Matches only phrases containing "task": `task status`, `(what|how) is the task`, `pause|resume|continue|cancel|stop the task`, `resume|continue|cancel task`, and `what happened` / `what happened with the task` only when a task finished or failed in the last 10 minutes; bare `resume`, `pause`, `cancel` never match (they belong to media and live-state follow-ups). Runs with `turn: { source, tainted: false }`.

- [ ] **Step 1: Write failing tests** with a stub runner recording calls: `task_run` forwards `title`, `steps`, `turn`, `signal` and returns the runner's text; a runner text starting with `NEEDS_OK` is returned unchanged; `task_control` dispatches each action (`replan` passes `steps`); a missing `steps` on `replan` returns an error text; the skill matches each phrase above and returns null for `resume`, `pause the music`, `cancel`, `what happened` with no recent finished task, and any text when no task exists.
- [ ] **Step 2: Run** `node --test test/tasks-tools.test.js` → FAIL.
- [ ] **Step 3: Implement** both files; the skill takes a `runner.status()`-based check for "recent finished task".
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/core/tools/tasks.js src/core/tasks/skill.js test/tasks-tools.test.js`; `git commit <same paths> -m "feat(tasks): task_run and task_control tools, fast-path skill"`.

### Task 6: Wiring, orchestrator integration and eval cases

**Files:**
- Modify (user's uncommitted files, edit in place, do NOT stage): `src/main/main.js`, `src/core/skills/core/index.js`, `src/core/pc/confirm.js`, `eval/questions.json`
- Create (commit): `test/tasks-integration.test.js`

**Interfaces:**
- Consumes: everything above; `createOrchestrator`, `createToolRunner`, `createConfirm`, `test/helpers/fake-provider.js` (read it first for the provider shape).
- Wiring contract:
  - `confirm.js`: `createConfirm({ ..., onResolved })` optional; after the action ran (and not when `asksAgain`) or on a no, calls `onResolved({ tool: action.tool, ok, text: out, declined })` inside try/catch.
  - `core/index.js`: `createGroup({ getStatus, tasks })`, when `tasks` (the two tools) is present they are appended before `moreSkills`.
  - `main.js`: after `ctx.timerStore`/before `ctx.catalog`: `ctx.taskStore = createTaskStore({ dir: path.join(DATA_DIR, 'tasks'), log: ctx.log })`, `ctx.taskStore.sweep()`, `ctx.tasks = createTaskRunner({ store, bus: ctx.bus, tools: { run: (...a) => ctx.tools.run(...a), resolves: n => ctx.tools.resolves(n) }, riskOf: n => ctx.toolList?.find(t => t.name === n || t.aliases?.includes(n))?.risk, confirmPending: () => ctx.confirm.pending(), log: ctx.log })`; pass `tasks: createTaskTools({ runner: ctx.tasks })` into the catalog deps; pass `onResolved: r => ctx.tasks.onConfirmResolved(r)` to `createConfirm`; add `createTasksSkill({ runner: ctx.tasks })` to the `fastPath` chain immediately before `ctx.mediaSkill.handle`; register live source `ctx.live.register('task', () => ctx.tasks.active())`.
  - `eval/questions.json`: about 8 multi-step cases ("play something then set a timer for 10 minutes", "find my biggest files and tell me how big they are", "task status") following the file's existing entry shape; `test/eval-questions.test.js` must stay green.

- [ ] **Step 1: Write failing integration tests** in `test/tasks-integration.test.js` (real `createOrchestrator`, real `createToolRunner`, real runner and store on a temp dir, fake provider scripted to call `task_run`):
  - a scripted `task_run` of two fake read-only tools returns a reply built from the step records and the chat history holds the tool message;
  - a plan with a confirm-risk tool: the turn ends with the question (`pending: true`), `confirm.handle('yes')` runs it, the task is `paused` with the step `done`, a following `resume` finishes it;
  - after a simulated restart (new store/runner on the same dir, `sweep()`), `resume` does not re-run done steps;
  - a tainted turn (an untrusted tool ran first) cannot `task_run` a confirm step;
  - with the tasks option absent from the group, behaviour of a plain turn is identical (no task tools in specs).
- [ ] **Step 2: Run** `node --test test/tasks-integration.test.js` → FAIL.
- [ ] **Step 3: Apply the wiring edits** above in place. Keep each hook wrapped so a failure falls back to today's behaviour.
- [ ] **Step 4: Run** `npm test` → all tests PASS (including `eval-questions` and the tool-registry consistency test); then `node eval/run.js` and confirm no routing regressions versus before the edit.
- [ ] **Step 5: Commit** only the new test: `git add test/tasks-integration.test.js`; `git commit test/tasks-integration.test.js -m "test(tasks): orchestrator integration for task runs"`. Then `git diff -- src/main/main.js src/core/skills/core/index.js src/core/pc/confirm.js eval/questions.json` and report the wiring hunks to the user, unstaged, with a note that the integration test needs them in the same commit to pass on a clean checkout.
