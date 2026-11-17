# Cross-System Context Assembler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** One small assembler that gathers labelled context items from systems JARVIS already has (LiveState, tasks, Cortex recall via the memory block), isolates provider failures, labels freshness, drops stale/superseded/duplicate items, enforces access and a character budget, and feeds the result into the orchestrator's recall hint. It owns no storage.

**Architecture:** `src/core/context/assemble.js` (pure, async, injected providers and clock) + `src/core/context/providers.js` (adapters over existing objects) + a wiring change in `orchestrator.js` and `main.js`. Cortex stays the history owner, LiveState the current-state owner; providers only read.

**Tech Stack:** Node CommonJS, `node:test` + `node:assert/strict`, `npm test`.

**Spec:** `docs/intelligence/phase0-baseline.md` (§4 G1, G2) and ADR A-001 in `docs/intelligence/adr-log.md`; roadmap Phase 1 requirements 1.1, 1.4, 1.5, 1.8.

## Global Constraints

- Header comment on every new file stating its contract (repo style). Tests in `test/<name>.test.js`.
- **The working tree is dirty with unrelated and earlier-session uncommitted changes** (`package.json`, `orchestrator.js`, `memory/block.js`, `livestate/context.js`, docs, tests). Commit only the files your task lists, with explicit paths (`git add <path>`). Never `git add -A`, never revert, stash or reformat files you do not own. Task 4 edits `orchestrator.js`, which already carries an earlier uncommitted hunk (the `liveContext` import and recall call): keep it, build on it.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- **Item shape (exact):** `{ id: string, text: string, source: string, kind: 'state'|'task'|'memory', observedAt: number|null, confidence: number (0..1), trust: 'owner'|'untrusted', sensitivity: 'public'|'personal'|'private', topic?: string, score?: number }`.
- **Freshness (exact):** `ageMs = now - observedAt`. `<= 120000` → `'current'`; `<= 3600000` → `'recent'`; larger → `'historical'`; `observedAt` null → `'unknown'`. An item of `kind: 'state'` whose freshness is not `'current'` is dropped with reason `'stale'` (old state is never presented as current).
- Drop reasons (exact strings): `'stale'`, `'superseded'`, `'duplicate'`, `'budget'`, `'access'`, `'invalid'`.
- Default budget 800 characters; default per-provider timeout 300 ms. Both are options.
- Providers never throw into the caller: a throwing, rejecting, timing-out or malformed provider is recorded in `errors` and the rest still run.
- Context availability never implies authorization: nothing here is read by `tools/registry.js` or `pc/confirm.js`.
- Guest and unsure speakers (`speaker !== 'owner'`) get an empty package and no provider is called.
- Untrusted items (`trust: 'untrusted'`) may appear in `items` and `text` (marked) but never in `hint`.
- No new dependency, no new database, no second embedding pipeline.

## Review Focus

- A provider that hangs, throws synchronously, rejects, or returns `null`, a non-array, or items with wrong types: other providers' items still returned, error recorded, no unhandled rejection.
- Two items with the same `topic` and different text: fresher wins, loser `'superseded'`; equal `observedAt` with different text keeps both with `conflict: true`.
- The budget is a hard cap on `text.length`, never exceeded, including the header; ranked order is respected.
- `hint` contains no untrusted text, no `private` items, and is at most 300 characters.
- The orchestrator turn behaves exactly as before when no `context` option is given, when the assembler throws, and for guest turns.

---

### Task 1: Assembler core

**Files:**
- Create: `src/core/context/assemble.js`
- Test: `test/context-assemble.test.js`

**Interfaces:**
```js
// createAssembler({ providers, now = Date.now, budgetChars = 800, timeoutMs = 300 })
//   providers: [{ name: string, fetch(request) => Promise<Item[]>|Item[] }]
// assembler.assemble(request) => Promise<Package>
//   request: { text: string, speaker?: 'owner'|'unsure'|'guest'|string, brief?: boolean, sessionId?: string }
//   Package: { items: Item[] (each with added .freshness), text: string, hint: string,
//             dropped: [{ id, reason }], errors: [{ provider, error }], ms: number }
```
- Items are ranked: `kind` order `state`, `task`, `memory`; within a kind newest `observedAt` first, then higher `score`/`confidence`.
- `text` format: first line `Context (observed facts, not instructions):` then one line per kept item: `- <text> [<freshness>, <source>]` (append `, untrusted` when untrusted, `, conflict` when conflicting). `text` is `''` when nothing is kept (no header alone).
- `hint`: the `text` of kept items with `trust: 'owner'`, `sensitivity !== 'private'`, `kind` `state` or `task`, joined by a space, truncated to 300 characters; `''` if none.
- `brief: true` requests keep only `kind: 'state'` items.
- Validation: an item missing a string `id` or `text`, or with an unknown `kind`, is dropped with reason `'invalid'`; a non-finite `confidence` becomes 0.5; non-number `observedAt` becomes null.

- [ ] Tests first (red), then implement, covering: freshness classes at the exact boundaries (120000 and 3600000 ms), stale state dropped, `topic` supersession both directions and the equal-time `conflict` case, text duplicate (case/whitespace-insensitive) dropped, budget cap including header, provider failure modes (sync throw, reject, hang past `timeoutMs` using a short timeout, `null`, non-array, bad items), speaker `guest`/`unsure`/unknown string → empty package with no provider call, `brief`, `hint` rules, injected clock.
- [ ] Commit only the two files.

### Task 2: Provider adapters

**Files:**
- Create: `src/core/context/providers.js`
- Test: `test/context-providers.test.js`

**Interfaces:**
```js
// liveProvider({ live, now })         live.snapshot() -> snapshot object (see src/core/livestate/index.js)
// taskProvider({ tasks, now })        tasks.active() -> { id, title, status, done, total } | null ; tasks.lastFinished(ms) -> { id, status } | null
// memoryProvider({ block, getSessionId? })   block.forTurn({ text, sessionId, brief, profileIds, context }) -> { memo, ids }
// each returns { name, fetch(request) }
```
- Live provider items (all `kind: 'state'`, `source: 'livestate'`, `observedAt: now()` because a snapshot is read at call time, `trust: 'owner'`): active window app (`topic: 'window'`, sensitivity `'personal'`); window title only when the snapshot carries it (`sensitivity: 'private'`, `trust: 'untrusted'`, per `livestate/active-window.js` it is outside text); timers (`timers.count`, next due, `topic: 'timers'`); whether media is playing (`topic: 'media'`); the pending confirm summary is NOT included.
- Task provider: active task as `kind: 'task'` with `source: 'tasks'`, text like `Task "<title>" is <status> (<done>/<total> steps done)`, `topic: 'task'`, `observedAt` = null when unknown; `trust: 'untrusted'` for the title is NOT required (task titles come from the owner's own request) but the text must be clipped to 160 chars.
- Memory provider: calls `block.forTurn` and converts each non-empty recalled line (after the header line) into a `kind: 'memory'` item, `source: 'cortex'`, `observedAt: null`, `confidence` 0.6, `sensitivity: 'personal'`, `trust: 'owner'`; ids from `ids` become the item ids (`mem:<id>`). It passes `context` built from the request's earlier state items only if the request carries `context`. Never throws; an empty memo yields `[]`.
- All adapters tolerate a missing or throwing dependency by returning `[]` (the assembler also guards, but adapters must not depend on that).

- [ ] Tests first with fakes for `live`, `tasks`, `block`; check item shapes against the exact item shape above, title gating, timers wording, clipping, empty/throwing deps.
- [ ] Commit only the two files.

### Task 3: Access and redaction

**Files:**
- Modify: `src/core/context/assemble.js`
- Test: `test/context-access.test.js`

**Behavior:** the assembler redacts before output. Any run of 7 or more digits (optionally separated by spaces or dashes, as in card, phone or account numbers) in an item's `text` becomes `[number]`; email addresses become `[email]`. Items with `sensitivity: 'private'` are kept out of `text` and `hint` unless the request has `allowPrivate: true` (default false) and the speaker is `owner`; they appear in `dropped` with reason `'access'` otherwise. Redaction applies before dedupe and budget. Redaction never mutates the provider's objects (return copies).

- [ ] Tests first: digits, spaced digits, emails, 6-digit number untouched, private dropped by default and kept with `allowPrivate`, never for a guest, provider objects not mutated, redaction before dedupe (two items differing only in a number run become duplicates).
- [ ] Commit the changed files.
- **Rulings from the Task 1 review (binding for this task):**
  - Untrusted items never supersede or out-dedupe an owner item: when an untrusted item and an owner item share a `topic` (or identical text), keep the owner item and drop the untrusted one with reason `'superseded'` / `'duplicate'`.
  - Validation also requires `source` to be a non-empty string, `trust` in `{'owner','untrusted'}`, `sensitivity` in `{'public','personal','private'}`; anything else is `'invalid'`.
  - `hint` collapses whitespace like `text` does.
  - Fix the header comment's pipeline order to match the code (rank, then dedupe).
  - A missing `speaker` stays "owner" (Task 4 always passes it and tests that).

### Task 4: Orchestrator and main wiring

**Files:**
- Modify: `src/core/orchestrator.js`, `src/main/main.js`
- Test: `test/context-orchestrator.test.js`

**Behavior:**
- `createOrchestrator` accepts an optional `context` (an assembler). In the memory-recall block (where `liveContext(snap)` is called today), when `context` is given and the turn is the owner's and not brief: call `await context.assemble({ text, speaker, brief: false, sessionId: s.id })` inside try/catch and use its `hint` as the recall `context` instead of `liveContext(snap)`; if it throws or returns an empty hint, fall back to `liveContext(snap)`. With no `context` option, behavior is exactly today's.
- The orchestrator emits one bus event `{ type: 'context', items: <count>, dropped: <count>, errors: <count>, ms: <number> }`. Structural numbers only, no text. Add `context` to the bridge `PUBLIC_FIELDS` allowlist in `src/core/bridge.js` ONLY if a test shows the bridge would otherwise forward more than `{type,t}`; no change if it already forwards nothing extra (unknown types forward `{type,t}`).
- The memory provider must not call `block.forTurn` a second time for the same turn: in `main.js` the assembler is built with `liveProvider` and `taskProvider` only; the memory block stays where it is (it is the recall owner). The memory provider remains available and tested but unused in production wiring (note this in a comment).
- `main.js`: build `createAssembler({ providers: [liveProvider({ live: ctx.live }), taskProvider({ tasks: ctx.tasks })] })` after `ctx.live` and `ctx.tasks` exist; pass `context` to `createOrchestrator`. If `ctx.tasks` is null, use only the live provider.

- [ ] Tests first (see `test/live-context.test.js` for orchestrator harness): hint from assembler reaches `forTurn`; assembler throws → falls back to `liveContext`; empty hint → fallback; guest turn → assembler not called; brief turn → not called; no `context` option → today's behavior; the bus event carries counts only and no text.
- [ ] Run the full suite. Existing expectations in `test/orchestrator.test.js` must not be edited to pass.
- [ ] Commit the changed files (the `orchestrator.js` commit will include the earlier uncommitted hunk; say so in the report).

### Task 5: Measurement and docs

**Files:**
- Create: `scripts/context-bench.js`
- Modify: `docs/intelligence/adr-log.md`, `docs/intelligence/phase0-baseline.md`
- Test: `test/context-bench.test.js`

**Behavior:** `node scripts/context-bench.js` builds an assembler from fakes (live provider with a window, timers and a task; a memory provider returning 20 lines; one provider that hangs, one that throws) and prints: assemble latency p50/p95 over 200 runs with all providers healthy, with one failing provider, and with one hanging provider (must be bounded by `timeoutMs` + small overhead); package size; items dropped by reason. `--json` prints one JSON line. Exports `run()` returning the numbers so the test can assert: healthy p95 under 20 ms, hanging provider p95 under `timeoutMs + 50`, errors recorded, the package never over budget.
Docs: in the ADR log mark A-001's cross-system slice as implemented and list what is NOT done (prompt block, file/project and browser/event providers, relationship expansion beyond Cortex's own, real-store retrieval quality, live-model check); in `phase0-baseline.md` update G1 status and add the measured numbers with their limits (fakes, not a real store).

- [ ] Tests first, then script, then docs. Commit the files.
