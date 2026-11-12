# Live State + Follow-up Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One in-memory `LiveState` snapshot of what JARVIS is doing now, plus a pure follow-up resolver, so "again", "undo that", "yes", "pause" resolve with no extra LLM call.

**Architecture:** `livestate/index.js` subscribes to the bus (bounded event ring) and pulls current values from registered sync getters. `livestate/followup.js` is a pure function over a snapshot. The orchestrator calls it before routing; `main.js` creates and wires everything. All optional: no `live` option = today's behavior.

**Tech Stack:** Node (CommonJS), `node:test`, run with `npm test` (`node --test "test/**/*.test.js"`).

**Spec:** `docs/superpowers/specs/2026-11-12-live-state-design.md`

## Global Constraints

- CommonJS, `'use strict'`-free style like neighbours; header comment on each new file explaining the contract (repo style).
- Tests live in `test/<name>.test.js` using `node:test` + `node:assert/strict`.
- Never store tool args or tool output text in LiveState.
- Tool entries expire after 10 min (`TOOL_TTL_MS = 10 * 60 * 1000`); the ring holds at most 8 tool runs.
- Follow-up window: a tool run within 3 min (`FOLLOWUP_MS = 3 * 60 * 1000`); pronoun rule applies to text of at most 6 words.
- `snapshot()` is synchronous, returns a fresh plain object each call, and must never throw.
- **Working tree is dirty with the user's unrelated uncommitted changes** (including `orchestrator.js`, `main.js`, `prompt.js`). Commit only files you create or the test files you add, with explicit paths (`git add <path>`). Never `git add -A`, never stage or revert pre-existing modifications in modified files, never stash.
- Commit message trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- Text containing regex-special or non-string input to `resolveFollowUp` (`null`, `undefined`, number): returns `null`, never throws.
- A source getter that throws or returns a non-object: skipped, other sources still present.
- `bus` events with missing fields (`tool` event without `ok`, `state` without `state`): ring ignores or defaults, no throw.
- "play it again" / "skip" with no recent tool run / nothing playing: `null` (must not hijack normal requests).
- A new chat session or a `live` that throws inside the orchestrator: turn proceeds exactly as before.

---

### Task 1: LiveState core

**Files:**
- Create: `src/core/livestate/index.js`
- Test: `test/livestate.test.js`

**Interfaces:**
- Consumes: `createBus` from `src/core/bus.js` (`bus.on('*', fn)` returns an unsubscribe fn; events are `{ type, t, ...payload }`). Relevant events: `tool` `{ id, name, phase: 'start'|'end', ok?, soft? }`, `state` `{ state }`, `route` `{ tier, think, reason, model }`, `turn` `{ ms, ... }`.
- Produces: `createLiveState({ bus, now = Date.now, log = () => {} }) → { register(name: string, fn: () => object|null), snapshot() → Snapshot, close() }`.
  `Snapshot = { t: number, voice: string|null, tools: Array<{name, ok, soft, t}> (newest last, expired dropped), route: {tier, model, reason}|null, turn: {ms}|null, [sourceName]: object }` — a source's key is only present when its getter returned a plain object.
  Constants exported: `TOOL_TTL_MS`, `MAX_TOOLS`.

- [ ] **Step 1: Write failing tests** in `test/livestate.test.js`:
  - `fills the ring from bus events`: emit `state {state:'thinking'}`, `route`, a `tool` start then end (`name:'youtube_music', ok:true`), `turn {ms:420}`; assert `snap.voice==='thinking'`, `snap.tools` has one entry `{name:'youtube_music', ok:true}`, `snap.route.tier`, `snap.turn.ms===420`.
  - `only tool end events are recorded; start is ignored`.
  - `caps tools at MAX_TOOLS (8), newest last`: emit 12 ends, assert length 8 and last name is the 12th.
  - `expires tools older than TOOL_TTL_MS` with an injected `now` clock.
  - `never stores args or output`: emit a `tool` end with extra `args:{secret:1}` and `text:'x'`; assert `JSON.stringify(snap)` contains neither.
  - `register adds a source key; a throwing source is skipped and logged once`; a getter returning a string/null is skipped.
  - `snapshot returns a fresh object` (mutating it does not change the next snapshot).
  - `close() unsubscribes` (events after close do not change the snapshot).
  - `tolerates events with missing fields` (`bus.emit('tool', {phase:'end'})`, `bus.emit('state', {})` do not throw).
- [ ] **Step 2: Run** `node --test test/livestate.test.js` → FAIL (module not found).
- [ ] **Step 3: Implement** `src/core/livestate/index.js` per the Interfaces block. Use plain arrays/objects; copy on `snapshot()` (spread tool entries); wrap each getter in try/catch and call `log` once per source name on first failure.
- [ ] **Step 4: Run** `node --test test/livestate.test.js` → all PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add src/core/livestate/index.js test/livestate.test.js
  git commit -m "feat(livestate): in-memory live state snapshot"
  ```

---

### Task 2: Follow-up resolver

**Files:**
- Create: `src/core/livestate/followup.js`
- Test: `test/followup.test.js`

**Interfaces:**
- Consumes: a `Snapshot` as produced by Task 1 (fields used: `tools`, `groups` (`{ ids: string[] }`-free: the `groups` source returns `{ list: string[] }`), `media` (`{ playing: boolean }`), `confirm` (`{ summary, ageMs }` or absent), `t`).
- Produces: `resolveFollowUp(text, snap) → null | { kind: 'confirm' } | { kind: 'continue', groups: string[] } | { kind: 'media', action: string }`. Exports `FOLLOWUP_MS`.
  Rules in order (first match wins): (1) `snap.confirm` present and text is a bare yes/no (reuse `isYes`, `isNo` from `src/core/brain/guard.js`) → `confirm`; (2) text ≤ 6 words matching `/\b(it|that|this|again|undo|same|the other one|another one|one more)\b/i`, a tool run with `snap.t - run.t <= FOLLOWUP_MS`, and `snap.groups.list` non-empty → `continue` with `groups: snap.groups.list`; (3) text (trimmed, lowercased, trailing punctuation removed) is exactly one of `pause, play, resume, skip, next, previous, back, louder, quieter, mute, unmute` and `snap.media?.playing` is true (for `pause/skip/next/previous/back/louder/quieter/mute`) → `media` with `action` = that word; `play`/`resume`/`unmute` need `snap.media` present and `playing === false`; (4) else `null`.

- [ ] **Step 1: Write failing tests** in `test/followup.test.js`, table-driven with fixture snapshots:
  - `yes` with confirm pending → `{kind:'confirm'}`; `yes` with no confirm → `null`; `no thanks` with confirm pending → `confirm`... only if `isNo` says so (assert whatever `isNo('no thanks')` returns via the same helper, do not hardcode).
  - `"do it again"`, `"undo that"`, `"another one"` with a run 30 s ago and `groups.list=['media']` → `continue`, `groups:['media']`.
  - `"play it again"` with no tools → `null`; same text with run 5 min ago → `null`; same text with empty `groups.list` → `null`.
  - 7-word sentence containing "it" → `null`.
  - `"pause"` with `media.playing=true` → `{kind:'media', action:'pause'}`; with `media.playing=false` → `null`; `"resume"` with `playing=false` → media; `"skip"` with no `media` key → `null`.
  - Non-string input (`null`, `undefined`, `42`, `{}`) → `null` without throwing; empty string → `null`; snapshot `null`/`undefined` → `null`.
- [ ] **Step 2: Run** `node --test test/followup.test.js` → FAIL.
- [ ] **Step 3: Implement** `resolveFollowUp(text: unknown, snap: object|null): object|null` in `src/core/livestate/followup.js`. Whole function in try/catch returning `null`.
- [ ] **Step 4: Run** `node --test test/followup.test.js` → PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add src/core/livestate/followup.js test/followup.test.js
  git commit -m "feat(livestate): pure follow-up resolver"
  ```

---

### Task 3: "Right now" prompt block

**Files:**
- Modify: `src/core/livestate/index.js` (add `liveLine`, export it)
- Modify: `src/core/brain/prompt.js` (`systemPrompt` and `briefPrompt` accept `live`)
- Test: `test/livestate.test.js` (append), `test/prompt-tools.test.js` or a new `test/livestate-prompt.test.js`

**Interfaces:**
- Consumes: `Snapshot` (Task 1).
- Produces: `liveLine(snap: object|null, { max = 5 } = {}) → string`. Empty string when there is nothing to say. Shape: lines starting `Right now:` then `- ` items, covering only: `voice` when not `idle`/null, `timers` (`{ count, nextInMs }` → "2 timers, next in 3 min"), `confirm` (`{ summary }` → "waiting for the user to confirm: <summary>"), and the last `max` tool runs ("last actions: youtube_music ok, set_volume failed"). Media is intentionally omitted (`mediaPromptLine` already renders it). `systemPrompt({ ..., live })` and `briefPrompt` append `live` right after the existing `media` line when it is a non-empty string.

- [ ] **Step 1: Write failing tests**: `liveLine` returns `''` for `null`, `{}` and an idle snapshot with no tools; renders timers, confirm, and last actions in order; never mentions media; honors `max`; a prompt built with `live: 'Right now:\n- x'` contains that text after the media line, and one built without `live` is byte-identical to the current output (compare against `systemPrompt` called with the same other args).
- [ ] **Step 2: Run** `node --test test/livestate.test.js test/prompt-tools.test.js` → new tests FAIL.
- [ ] **Step 3: Implement** `liveLine` in `index.js` and add the `live` param to both prompt builders in `src/core/brain/prompt.js` (read how `media` is rendered at present and mirror it).
- [ ] **Step 4: Run** `npm test` → PASS (all pre-existing tests still green).
- [ ] **Step 5: Commit** only your new test file and `src/core/livestate/index.js`; leave `prompt.js` unstaged (pre-existing user changes) and say so in your report.
  ```bash
  git add src/core/livestate/index.js test/livestate.test.js
  git commit -m "feat(livestate): Right now prompt block"
  ```

---

### Task 4: Orchestrator wiring

**Files:**
- Modify: `src/core/orchestrator.js` (`createOrchestrator` options and the turn function around the `fastPath` / `selectGroups` / `hints` code)
- Test: `test/livestate-orchestrator.test.js` (copy the harness style of `test/coherence.test.js`: fake provider, `createBus`, in-memory sessions)

**Interfaces:**
- Consumes: `resolveFollowUp` (Task 2); `live.snapshot()` (Task 1); existing `selectGroups(text, { lastGroups, source })`, `lastGroups` map.
- Produces: new optional option `live = null` on `createOrchestrator`. When set, per turn: `fu = safe(resolveFollowUp(text, live.snapshot()))`. If `fu` is set, `bus.emit('followup', { kind: fu.kind })`. If `fu.kind === 'continue'`: pass `lastGroups: fu.groups` to `selectGroups`; if the picked list has no non-`core` group, use `fu.groups` as `picked`; if `hints.tools === false`, upgrade to `{ ...hints, tier:'deep', tools:true, think:false, reason:'follow-up' }`. `confirm` and `media` kinds only emit the event (the fast-path chain already handles them). Any exception from `live`/resolver is swallowed with a `log` warn event and the turn continues unchanged.

- [ ] **Step 1: Write failing tests**:
  - without `live`: a plain turn behaves as before (reuse an assertion pattern from `coherence.test.js`).
  - with a fake `live = { snapshot: () => ({...}) }` whose snapshot makes `"do it again"` resolve to `continue` with `groups:['media']`: assert a `followup` bus event with `kind:'continue'`, `selectGroups` (injected spy) received `lastGroups:['media']`, and the provider call had tools enabled even though `route` returned `tools:false`.
  - `live.snapshot` that throws: turn completes, a `log` warn event is emitted, result identical to the no-`live` case.
  - `"pause"` resolving to `media`: a `followup` event with `kind:'media'` is emitted and no hint changes.
- [ ] **Step 2: Run** `node --test test/livestate-orchestrator.test.js` → FAIL.
- [ ] **Step 3: Implement** in `src/core/orchestrator.js`. Resolve once right after the `bus.emit('state', { state: 'thinking' })` line, before `fastPath`; reuse the value at the `selectGroups` / `hints` block.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** only `test/livestate-orchestrator.test.js` (leave the modified `orchestrator.js` unstaged; the user has other uncommitted edits in it) and say so in your report.
  ```bash
  git add test/livestate-orchestrator.test.js
  git commit -m "test(livestate): orchestrator follow-up wiring"
  ```

---

### Task 5: App wiring and eval cases

**Files:**
- Modify: `src/main/main.js` (create `ctx.live`, register sources, pass to orchestrator, add `live` to `promptInfo`, close on quit)
- Modify: `eval/questions.json` (about 10 follow-up cases; read `eval/run.js` and `test/eval-questions.test.js` first for the schema)
- Test: `test/eval-questions.test.js` must still pass; extend it only if the schema check needs it.

**Interfaces:**
- Consumes: `createLiveState`, `liveLine` (Tasks 1, 3); `ctx.bus`, `ctx.confirm.pending()` (returns an action with `summary`, or `null`), `ctx.scheduler.list()` (items with `due` ms), `ctx.media` state.
- Produces: `ctx.live`. Sources registered: `media` → `{ playing: boolean }` from the last media state `promptInfo` already fetches (store it in a module variable with a timestamp; return `null` when older than 60 s); `timers` → `{ count, nextInMs }` or `null` when empty; `confirm` → `{ summary, ageMs }` or `null`; `groups` → `{ list: string[] }` — add an optional `getLastGroups(): string[]` to the orchestrator's returned API (current chat's last groups) and use it here (if awkward, expose via a small accessor on the orchestrator object). `promptInfo` result gains `live: liveLine(ctx.live.snapshot())`. `ctx.onQuit` gains `() => ctx.live.close()`.

- [ ] **Step 1: Add eval cases** to `eval/questions.json`: follow-up phrases ("again", "undo that", "do the same for the other one", "yes", "pause", "skip it") with expected routing per the file's existing schema. Run `node --test test/eval-questions.test.js` → PASS.
- [ ] **Step 2: Wire `main.js`** as in Interfaces. Guard everything so a missing service leaves the source out.
- [ ] **Step 3: Run** `npm test` → all PASS. Then launch smoke check: `node -e "require('./src/core/livestate'); require('./src/core/livestate/followup')"` exits 0 (the Electron app itself is not started).
- [ ] **Step 4: Commit** `eval/questions.json` only if the pre-existing diff in that file is empty of user changes; otherwise leave it unstaged and report. (`eval/questions.json` already has uncommitted user changes: do not stage it.) Report which files remain modified-uncommitted.

---

## Self-review

- Spec coverage: LiveState ring, sources, snapshot (T1); resolver rules (T2); `liveLine` and prompt (T3); orchestrator wiring and failure mode (T4); `main.js` sources, eval cases, quit cleanup (T5). Out-of-scope items are untouched.
- Spec deviations recorded in the spec: tool entries carry no `group` (follow-up groups come from the `groups` source); `media` kind only emits an event; `liveLine` omits media.
- Types: `groups` source is `{ list: string[] }` everywhere (T2 consumes, T5 produces); `Snapshot.t` used by T2 matches T1.
