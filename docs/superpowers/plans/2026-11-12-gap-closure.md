# Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 14 gaps found in the 2026-11-12 codebase review, in waves a controller can hand to fresh subagents.

**Architecture:** Wave 0 makes the tree reviewable (commit, baseline). Wave 1 is small, fully specified fixes (items 7-12, 14) that touch disjoint files and can run in parallel. Wave 2 is router/memory/live-state work that touches shared core files and runs serially. Wave 3 is new features (items 1-3, new tools), each of which gets its own spec and plan first (brainstorming, then writing-plans) because each is a subsystem; this document only fixes their order, file ownership and acceptance gates. Item 13 is a human verification checklist, not agent work.

**Tech Stack:** Node 22 (`node --test`), Electron 45, PowerShell hosts, SQLite cortex, local Ollama.

**Spec:** `docs/audit-2026-11-12.md`, `docs/audit-2026-11-12-results.md`, and the out-of-scope sections of `docs/superpowers/specs/*` and `docs/specs/*`.

## Global Constraints

- Local only: no cloud providers; Ollama host must stay `127.0.0.1`.
- Tools returning outside text (pages, files, clipboard) are `untrusted`; tainted turns cannot start `risk: 'confirm'` tools, write memory or write the clipboard.
- Anything that performs an action for the user goes through `confirm.propose` with the user's own yes.
- No personal data in web queries; nothing new on the public `/ai/stream` that carries words.
- `npm test` must stay green (1246 passing at the audit); every task adds tests first.
- One writer per file at a time. Subagents in the same wave must not share files (see File Ownership).
- Commit per task with the repo's `type(scope): subject` style.

## Review Focus

- A recurring reminder that fires while the PC was asleep or JARVIS was closed: fire once on next start, never a burst of missed occurrences.
- A shopping/to-do list item containing text from a tainted turn (page, clipboard): must be refused like memory writes.
- Background tasks and recurring timers surviving a restart without double-firing.
- `uncaughtException` handler must not hide a crash loop: log, flush, then exit non-zero after the first one.
- Per-speaker memory when the speaker gate is off or the voice is unknown: fall back to shared memory, never to another person's.

---

## File Ownership (for parallel dispatch)

| Wave | Task | Owns (only this task edits) |
|---|---|---|
| 1 | T1 crash handler | `src/main/main.js` (bottom handlers), `test/main-crash.test.js` |
| 1 | T2 log caps | `src/core/pc/actions-log.js`, `src/core/net/*` log writers, `src/main/main.js` log rotation call only if needed |
| 1 | T3 library path setting | `src/core/config.js`, `src/core/settings.js`, `src/ui/settings.*`, `scripts/install-library.ps1`, `src/core/knowledge/kiwix.js` |
| 1 | T4 untrusted flag single source | `src/core/brain/guard.js`, `src/core/orchestrator.js:446-448`, `src/core/tasks/runner.js:121`, `src/main/main.js:236` |
| 1 | T5 stream label leak | `src/core/bridge.js`, `src/core/orchestrator.js:65-70,428` |
| 1 | T6 param descriptions | `src/core/tools/*.js`, `src/core/skills/*/index.js` (description strings only), new `test/tool-schema-lint.test.js` |
| 1 | T7 housekeeping | `README.md`, `docs/*` only (after all Wave 1 commits) |
| 2 | T8, T9, T10 | see each task; serial |
| 3 | T11-T14 | new directories; each its own spec |

Verified before planning (re-check in Step 1 of the owning task, the working tree has 68 uncommitted files):
- `actions-log.js` already has `LIMIT`/`KEEP` rotation (lines 6-57). Item 8 may be done; T2 first proves it with a test, then covers the other unbounded logs (`jarvis.log` rotates at 512 KB per README; check `web-activity.jsonl`, `music-plays.jsonl`, `ytm-undo.json`).
- `UNTRUSTED_TOOLS` is a hardcoded set in `guard.js:68`; skills also carry `untrusted: true` on the tool (e.g. `clipboard_read`).
- `bridge.js:53` `publicEvent` blanks only `token` text, so `label` on tool events is still public.
- Only `unhandledRejection` is handled (`main.js:476`).

---

## Wave 0: Make the tree reviewable

### Task 0: Commit baseline

**Files:** none changed; git only.

- [ ] **Step 1:** Run `npm test`. Expected: all pass (about 1246).
- [ ] **Step 2:** Commit the 68 uncommitted files in the phase order of `docs/audit-2026-11-12-results.md` (connections, extension, skills, analytics, prompts/speech, memory/truth). One commit per phase; stage by path groups listed in the results table.
- [ ] **Step 3:** Run `npm test` again and `git status`. Expected: pass, clean tree.

Subagents must not start before this commit; they branch from it.

---

## Wave 1: Parallel small fixes

Dispatch T1-T6 together (disjoint files), one fresh implementer and one reviewer each. T7 runs after.

### Task T1: uncaughtException handler (item 7)

**Files:** Modify `src/main/main.js` near line 476; Test `test/main-crash.test.js`.

**Interfaces:** Produces `installCrashHandlers({ log, flush, exit }) -> void` exported from a new `src/main/crash.js`; `main.js` calls it.

- [ ] **Step 1:** Test `'uncaughtException logs the stack, flushes, and exits non-zero once'` and `'a second exception during shutdown does not recurse'` using fake `log`, `flush`, `exit`.
- [ ] **Step 2:** Run it; expect FAIL (module missing).
- [ ] **Step 3:** Implement `installCrashHandlers` in `src/main/crash.js` (guard flag against re-entry; move the existing `unhandledRejection` log line into it).
- [ ] **Step 4:** Run the test and `npm test`; expect PASS.
- [ ] **Step 5:** Commit `fix(main): handle uncaughtException`.

### Task T2: Cap every growing file (item 8)

**Files:** Modify `src/core/pc/actions-log.js` (only if the test fails); Test `test/log-caps.test.js`.

- [ ] **Step 1:** Test `'actions log stays at or under LIMIT entries after 10x LIMIT writes'` and equivalent for `web-activity.jsonl` and `music-plays.jsonl` using temp dirs.
- [ ] **Step 2:** Run; record which fail. Passing ones prove the audit item stale: note that in the commit message.
- [ ] **Step 3:** For each failing writer, add the same keep-newest-N rewrite pattern used in `actions-log.js:31-38` (temp file then rename).
- [ ] **Step 4:** `npm test`; expect PASS. Commit `fix(logs): cap growing log files`.

### Task T3: Configurable library folder (item 9)

**Files:** Modify `src/core/config.js` (`merge()` default `library.dir`), `src/core/settings.js`, `src/ui/settings.html|js`, `src/core/knowledge/kiwix.js`, `scripts/install-library.ps1` (accept `-Dir`); Test `test/config.test.js` additions.

**Interfaces:** Produces config key `library.dir: string` (default `C:\JarvisData\library`), validated on load as an absolute path.

- [ ] **Step 1:** Tests: `'library.dir defaults to C:\\JarvisData\\library'`, `'relative library.dir is rejected with a reported key'`, `'kiwix reads zim files from config library.dir'`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement in `config.js` and thread `getConfig().library.dir` into `kiwix.js`; add a folder field to Settings; add `-Dir` to the installer script.
- [ ] **Step 4:** `npm test`; commit `feat(config): library folder setting`.

### Task T4: One source of truth for untrusted tools (item 10)

**Files:** Modify `guard.js:68`, `orchestrator.js:446-448`, `tasks/runner.js:121`, `main.js:236`; Test `test/untrusted-flags.test.js`.

**Interfaces:** Produces `isUntrustedTool(name, catalog) -> boolean` in `guard.js`, reading only the tool's `untrusted` flag; the hardcoded set is deleted after the six listed tools (`lookup_knowledge`, `read_article`, `news_headlines`, `get_weather`, `weather_alerts`, `sports_scores`, `find_files`, `list_windows`) get `untrusted: true` on their tool definitions.

- [ ] **Step 1:** Test: `'every tool in the former UNTRUSTED_TOOLS set carries untrusted:true'` iterating the catalog; `'isUntrustedTool is false for unknown names'`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Add flags in `src/core/tools/*.js`; implement `isUntrustedTool`; replace the three call sites; remove the set and its export.
- [ ] **Step 4:** `npm test` (the taint tests in `test/tasks*.test.js` must still pass); commit `refactor(guard): untrusted flag lives on the tool`.

### Task T5: Remove words from the public stream (item 12)

**Files:** Modify `src/core/bridge.js:53`, `src/core/orchestrator.js:65-70`; Test `test/bridge.test.js` addition.

- [ ] **Step 1:** Test `'public stream tool events carry no label or args text'` emitting a tool event with `label: 'search “secret”'` and asserting the public output lacks `label`; `'chat window still receives the label'`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Extend `publicEvent` to drop `label` (keep `name`, `phase`); leave the chat-window path unchanged.
- [ ] **Step 4:** `npm test`; commit `fix(bridge): no words on the public stream`.

### Task T6: Parameter descriptions (item 11)

**Files:** tool definitions in `src/core/tools/*.js`; Test `test/tool-schema-lint.test.js`.

- [ ] **Step 1:** Test `'every tool parameter has a non-empty description'` over the built catalog (`test/helpers/tool-deps.js`); it lists offenders. Run; expect 59 failures.
- [ ] **Step 2:** Add one-line descriptions (what it is, units, accepted values) per offender. Split across subagents by file if desired; they do not overlap.
- [ ] **Step 3:** Run the lint test and `npm test`; expect PASS.
- [ ] **Step 4:** If a GPU is free, `JARVIS_EVAL_GROUP=tools node eval/run.js` before and after; record in `docs/` (not a gate, JARVIS must be closed).
- [ ] **Step 5:** Commit `docs(tools): describe every parameter`.

### Task T7: Housekeeping (item 14)

**Files:** `README.md` (branch table, test count), `docs/source-of-truth.md`.

- [ ] **Step 1:** Update the branch table to current branches (`git branch -a`) and test count; add the new config key from T3 and the dashboard.
- [ ] **Step 2:** Commit `docs: refresh README branch table and counts`.

---

## Wave 2: Serial core work

Each task is its own branch and PR off the Wave 1 result. They share `select.js`, `cortex/*` and `livestate/*`, so do not parallelise.

### Task T8: Constrained routing for low-confidence requests (item 5)

**Files:** Modify `src/core/skills/select.js`, `src/core/providers/ollama.js` (`constrain()` already exists), `src/core/skills/clarify.js`; Test `test/skill-select.test.js`; Eval `scripts/skill-accuracy.js`, `test/fixtures/skill-requests-fresh.json`.

**Interfaces:** Consumes `select()` result `{ groups, confidence: 'low'|'high' }`. Produces `selectWithModel(request, deps) -> { action: 'act'|'ask'|'decline', groups, question? }`, called only when `confidence === 'low'`.

- [ ] **Step 1:** Tests with a fake provider: low-confidence request calls `constrain` once with an enum schema of group names plus `ask`/`decline`; high-confidence makes no model call; invalid model output falls back to the current rule result.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement `selectWithModel`; wire it into the orchestrator where `select` is called.
- [ ] **Step 4:** `node scripts/skill-accuracy.js --set fresh` (offline rule path) must not drop below 76.3%. Live accuracy with `node eval/run.js` is a recorded measurement, target at least 85% on the fresh set including ask/decline.
- [ ] **Step 5:** Write a NEW held-out set first (do not tune on it); commit `feat(routing): constrained decode for low-confidence selection`.

### Task T9: Live state persistence and active-window feed (item 4)

**Files:** Modify `src/core/livestate/index.js`, `sources.js`; Create `src/core/livestate/persist.js`, `src/core/livestate/active-window.js`; Test `test/livestate-persist.test.js`.

**Interfaces:** Produces `persist.load(dir) -> snapshot|null`, `persist.save(dir, snapshot) -> void` (debounced, atomic); `active-window` source `{ name: 'activeWindow', read() -> { app, title? } }` using the existing windows skill host (title stored only if the user has not disabled it in config; never sent on any stream).

- [ ] **Step 1:** Tests: snapshot round-trips; a corrupt file loads as `null` and boot continues; snapshot older than 24 h is discarded; active window source never exposes title on the bridge.
- [ ] **Step 2-4:** Fail, implement, pass. Commit `feat(livestate): persist and active-window source`.

### Task T10: Per-speaker memory and content memory (item 6)

**Files:** Modify `src/core/cortex/nodes.js`, `src/core/memory/system.js`, `src/core/voice/speaker/*`, `src/core/voice/controller.js`; Create `src/core/memory/profiles.js`; Cortex export in `src/core/cortex/index.js`. Needs its own short spec first (data model change).

**Interfaces:** Memory nodes gain `owner: profileId|'shared'`. `profiles.resolve(speakerResult) -> profileId`; unknown or gate-off resolves to `'shared'`.

- [ ] **Step 1:** Spec (brainstorming skill), covering: enrolling more than one voiceprint, recall filters by owner plus shared, migration of existing nodes to `'shared'`, and a user-initiated "remember this file/page" verb that stores a summary only, never raw content, via a `confirm` step.
- [ ] **Step 2:** Tests from the spec's Review Focus (unknown voice never sees another profile's facts; tainted turns cannot write).
- [ ] **Step 3:** Implement `cortex` export as a local JSON/JSONL backup only (the "no cloud sync" rule stands); skip cloud sync.
- [ ] **Step 4:** Run `node scripts/cortex-bench.js` and `scripts/cortex-quality.js`; gates must still pass (recall p95 under the spec limit).

---

## Wave 3: New capabilities (each: spec, plan, then Wave-style tasks)

Each item below starts with `superpowers:brainstorming` to produce a spec in `docs/superpowers/specs/`, then `writing-plans`. Order by value and dependency:

### Task T11: Recurring reminders (item 1)

**Files:** Modify `src/core/timers/parse.js`, `store.js`, `scheduler.js`, `src/core/skills/timers/index.js`, `src/core/tools/timers.js`; Test `test/timers-recurring.test.js`.

**Interfaces:** Timer record gains `repeat: { kind: 'daily'|'weekly'|'monthly', days?: number[], at: 'HH:MM' } | null`. `parse(text) -> { ..., repeat }`. Scheduler on start fires a missed recurring reminder once, then computes the next occurrence.

- [ ] **Step 1:** Tests: "every Monday at 9am", "every day at 7:30", "every other week" (reject with a clarifying question), missed-while-closed fires once, cancel stops the series, quiet hours honoured, restart keeps the schedule.
- [ ] **Step 2-4:** Fail, implement, pass, commit `feat(timers): recurring reminders`.

### Task T12: Lists (item 2)

**Files:** Create `src/core/lists/store.js`, `src/core/tools/lists.js`, `src/core/skills/lists/index.js`; register in `src/core/skills/index.js` ORDER; Test `test/lists.test.js`.

**Interfaces:** `list_add { list, item }`, `list_show { list }`, `list_remove { list, item }`, `list_clear { list }` (`risk: 'confirm'`). Persisted in `lists.json`, tainted turns refused, items scanned by the same secret filter as memory.

- [ ] **Step 1:** Tests per tool plus the tainted-turn refusal and secret refusal; add rows to `test/fixtures/skill-requests*.json` ("add milk to my shopping list", "what's on my to-do list").
- [ ] **Step 2-4:** Fail, implement, pass, commit `feat(lists): to-do and shopping lists`.

### Task T13: Background and scheduled tasks (item 3)

**Files:** Modify `src/core/tasks/runner.js`, `store.js`, `plan.js`; depends on T11 (scheduling) and T9 (persistence). Own spec first.

Constraints to carry into the spec: a background step may not run a `risk: 'confirm'` tool without a stored, still-valid confirmation; every scheduled run is logged to `actions.log`; parallel and nested steps stay out until background runs are stable.

### Task T14: Data tools: processes, downloads, translate, currency, stocks, directions

One spec, several independent tools, each on the same pattern (tool file, skill group, fetch-policy allowlist entry, tests with recorded fixtures via `scripts/record-fixtures.js`).

| Tool group | Notes |
|---|---|
| `process_top`, `app_update_check` (read-only first) | PowerShell host, `risk: 'safe'`; install/update is `confirm` and winget only, off by default |
| `download_file` | `confirm`, destination inside configured downloads dir, size cap, saved filename reported |
| `translate` | local model first (no network); online only if allowlisted |
| `currency_convert`, `stock_quote` | keyless public endpoints behind `net/policy.js` allowlist; results `untrusted: true`; no trades, no advice |
| `directions` | open the route in the default maps URL (`web_open`) rather than computing locally |

- [ ] **Step 1:** Spec with the allowlist additions and privacy review (queries carry no personal data).
- [ ] **Step 2:** Tasks one per row; parallel subagents allowed because each owns a new file, but `src/core/net/policy.js` and `src/core/skills/index.js` edits are serialized through the controller.

---

## Item 13: Verification checklist (human, not agent work)

- [ ] Restart JARVIS, reload extension 1.6.0, watch Recent actions for a day; report missed YouTube prompts.
- [ ] Run `node eval/run.js` with JARVIS closed; save results to `eval/`.
- [ ] Listen to TTS for dialect, numbers and commas; note bad phrasings.

## Subagent-Driven Execution Notes

- Controller dispatches per task: implementer (fresh, sees only its task plus Global Constraints), then spec reviewer, then code-quality reviewer; next task only after both approve.
- Wave 1 tasks T1-T6 are dispatched in parallel in isolated worktrees (`superpowers:using-git-worktrees`); merge order T4, T5, T1, T2, T3, T6, T7 to keep `main.js`/`orchestrator.js` conflicts trivial (T1/T2/T3 touch different regions of `main.js`).
- Wave 2 and 3 tasks run serially unless the table says otherwise. Each starts by reading its spec; where a spec does not exist yet, the controller runs brainstorming with you first.
- Final step of each wave: whole-branch review plus `npm test`.
