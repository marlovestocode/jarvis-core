# Adaptive Reasoning and Model Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Routing uses the LiveState snapshot to decide fast vs deep, which tools to offer and which Ollama model serves a turn, and avoids a tool or model that just failed.

**Architecture:** Two new pure modules (`brain/cooldown.js`, `brain/plan.js`) wrap the unchanged `route()` and `selectGroups()`. LiveState gains a bounded model-failure ring fed by a new `modelfail` bus event. The orchestrator calls `plan()` once when `live` is set; Ollama's `resolveModel` honors an optional `hints.prefer = 'fast'`. With `live` absent every path equals today's behaviour.

**Tech Stack:** Node (CommonJS), `node:test` (`npm test` runs `test/**/*.test.js`), Ollama provider, Electron main wiring in `src/main/main.js`.

**Spec:** `docs/superpowers/specs/2026-11-12-adaptive-routing-design.md`

## Global Constraints

- Every new input is optional; absent live state equals today's behavior.
- `route()` and `selectGroups()` keep their signatures and behavior.
- Live state stores metadata only: never tool args, output text or error text.
- Cooldown: a tool cools when its weighted failures in the last 2 min reach 2 (`ok:false` counts 1, `soft` counts 0.5, `ok:true` counts 0); a model cools by the same rule over `snap.models` (each entry weight 1). The cooldown applies only where an alternative exists.
- LiveState model ring: last 6 `{ name, t }`, same 10 min prune as tools; fed only by the `modelfail` bus event, reading only `model`.
- Pending confirm: `snap.confirm` exists, younger than 5 min (`confirm.pending()` exposes no age, so a missing `ageMs` counts as young), message is not a yes/no (`fu.kind !== 'confirm'`).
- Voice `prefer`: `source === 'voice'`, route deep, `depth === 1`, `steps === 1`, `think` false, at most one non-core group picked, no confirm pending. Never for thinking or multi-step requests.
- `plan()` and `cooling()` never throw out of the orchestrator: on failure log one warning and use the plain `route()`/`selectGroups()` output. All synchronous, under 1 ms.
- Out of scope: new skill handlers, answering state questions from the snapshot, per-tool or per-model health scores, persistence across restarts, voice caps on tool rounds or tool-spec counts, Cortex.
- Tests are `test/*.test.js` (`node:test`), not `.t` files. New files use LF line endings (`git ls-files --eol`).
- **Commit rule (critical):** `src/core/orchestrator.js`, `src/core/providers/ollama.js`, `src/main/main.js`, `eval/run.js`, `eval/questions.json` (and possibly `src/core/livestate/index.js`) already hold the user's uncommitted edits, and other sessions commit on this branch. Edit them in place with small targeted edits, preserving line endings; never `git add -A`, `git add .`, `git commit -a`, or a pathspec commit of those files. Commit only new files with `git add <explicit paths>` then `git commit <same paths> -m ...`. Task 7 isolates the hunks in existing files. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- A snapshot whose `tools`/`models` entries are missing `t`, non-numeric, or not objects, or a `snap` that is not an object: `cooling()` and `plan()` return the plain result without throwing (Tasks 1, 3).
- The only tool in scope is cooling (or every offered tool is): it is still offered, never an empty tool list (Task 5).
- A cooling tool must still run if the model calls it by name, and task-runner steps (`tools.run` direct) are never blocked by the cooldown (Task 5).
- `modelfail` with a missing or non-string `model`, or carrying extra text fields: ignored or stored as name only, ring stays bounded (Task 2).
- Voice `prefer: 'fast'` when the fast model is not installed, lacks `tools`, equals the main model, or is the avoided model: `resolveModel` returns exactly what it returns without the hint (Task 4).
- A pending confirm followed by a chat-like message ("thanks"): the route becomes a tools turn as the spec says (bounded by confirm's 60 s window); a yes/no never gets this rewrite (Task 3).

---

### Task 1: Cooldown

**Files:**
- Create: `src/core/brain/cooldown.js`
- Test: `test/cooldown.test.js`

**Interfaces:**
- Produces: `cooling(snap, now = Date.now()) → { tools: Set<string>, models: Set<string> }`; exports `COOLDOWN_MS = 120000` and `COOL_AT = 2`.

- [ ] **Step 1: Write failing tests** in `test/cooldown.test.js`: `ok:false` entry counts 1 and two `ok:false` of one tool within 2 min cool it; one `ok:false` alone does not; `soft:true` counts 0.5 (two softs do not reach 2, four do); `ok:true` counts 0; entries older than 2 min (relative to `now`) are ignored; failures of different tools do not add up; models cool from `snap.models` (`{name,t}`, weight 1 each: two entries cool it); a missing, null, non-object `snap`, non-array `tools`/`models`, and entries without a string `name` or numeric `t` return empty sets and never throw.
- [ ] **Step 2: Run** `node --test test/cooldown.test.js` → FAIL (module not found).
- [ ] **Step 3: Implement** `cooling` per the signature and constraints; wrap the body so any exception returns empty sets.
- [ ] **Step 4: Run** the same command → PASS.
- [ ] **Step 5: Commit** `git add src/core/brain/cooldown.js test/cooldown.test.js` then `git commit src/core/brain/cooldown.js test/cooldown.test.js -m "feat(routing): failure cooldown for tools and models"`.

### Task 2: LiveState model-failure ring

**Files:**
- Modify: `src/core/livestate/index.js` (check `git status`; if it holds the user's uncommitted edits, edit in place, do not stage)
- Test: `test/livestate-models.test.js` (new)

**Interfaces:**
- Consumes: the existing `createLiveState({ bus, now, log })`, its `onEvent`, `prune`, `snapshot`.
- Produces: `snapshot().models` = array of `{ name, t }` (fresh copies), fed by bus event `modelfail` `{ model }`; constants `MAX_MODELS = 6` exported alongside `MAX_TOOLS`.

- [ ] **Step 1: Write failing tests** (fake `now`, real `createBus`): `modelfail` events appear in `snapshot().models` with the model name and time; the ring keeps only the last 6; entries older than 10 min (`TOOL_TTL_MS`) are pruned; an event whose `model` is missing or not a string adds nothing; extra fields on the event (`text`, `error`) are never stored (`Object.keys` of an entry is exactly `['name','t']`); `snapshot().models` is a fresh copy (mutating it does not change the next snapshot); with no `modelfail` events `models` is `[]` and every other snapshot field is unchanged.
- [ ] **Step 2: Run** `node --test test/livestate-models.test.js` → FAIL.
- [ ] **Step 3: Implement** the ring in `createLiveState` (new `case 'modelfail'` in `onEvent`, prune with the same TTL, `models` in `snapshot()`), keeping existing fields and behaviour.
- [ ] **Step 4: Run** the new test and `node --test test/livestate*.test.js` → PASS.
- [ ] **Step 5: Commit** the new test: `git add test/livestate-models.test.js`; `git commit test/livestate-models.test.js -m "test(livestate): model-failure ring"`. Leave `index.js` unstaged if it was already modified by the user, otherwise commit it too with explicit paths.

### Task 3: plan()

**Files:**
- Create: `src/core/brain/plan.js`
- Test: `test/plan.test.js`

**Interfaces:**
- Consumes: `cooling(snap, now)` (Task 1). Injected `route(text, { source }) → hints` and `selectGroups(text, { lastGroups, source }) → string[]` (the array may carry extra props such as `.confidence`; return the same array object when it is not replaced). `fu` is the result of `resolveFollowUp` (`{ kind: 'continue', groups } | { kind: 'confirm' } | { kind: 'media', ... } | null`). `catalog.ids` lists group ids. `snap.confirm = { summary, group? }`.
- Produces: `plan(text, snap, { source, lastGroups, fu, catalog, route, selectGroups, now }) → { hints, picked, avoid: { tools: Set, models: Set }, notes: string[] }`; `picked` is `null` when `selectGroups` is absent.

- [ ] **Step 1: Write failing tests** with fake `route`/`selectGroups`:
  - `snap` absent (undefined/null/`{}`/not an object): result equals the direct `route()`/`selectGroups()` results (same hints object values, same picked), `avoid` empty sets, `notes` `[]`.
  - Rule 1 (`continue`): `fu.groups` is passed to `selectGroups` as `lastGroups`; when picked has nothing beyond `core`, `picked = fu.groups`; a chat route (`tools === false`) becomes `{ tier:'deep', tools:true, think:false, reason:'follow-up' }`; a non-chat route is untouched; a `media` follow-up changes nothing.
  - Rule 2 (confirm): pending confirm and `fu.kind !== 'confirm'` turns a `tools === false` route into `{ tier:'deep', tools:true, think:false, reason:'confirm pending' }` and adds `snap.confirm.group` to `picked` only when `catalog.ids` knows it; with `fu.kind === 'confirm'`, or no `snap.confirm`, nothing changes; note `confirm pending` present only when it fired.
  - Rule 3 (voice): `hints.prefer === 'fast'` only when every voice condition holds; negatives, one each: source `text`, `depth` 2 or `think` true, `steps` 2, two non-core groups picked, confirm pending, route not deep.
  - Rule 4 (cooldown): a tool with two `ok:false` runs inside 2 min appears in `avoid.tools`; `avoid.models` and `hints.avoid` is the most recent cooling model; notes `cooldown: <name>`; nothing cooling → empty and no `hints.avoid`.
  - Throwing `route()` or `selectGroups()` or `cooling`: `plan` rethrows nothing it cannot recover? No: `plan()` itself may throw; the caller (Task 5) catches. Test instead that `plan` does not mutate `snap` and returns fresh `avoid` sets each call.
- [ ] **Step 2: Run** `node --test test/plan.test.js` → FAIL.
- [ ] **Step 3: Implement** `plan` applying the rules in the spec's order (continue, confirm, voice, cooldown, notes) on top of the unchanged `route()`/`selectGroups()` outputs; `hints` is a copy when modified, never mutate the object `route()` returned.
- [ ] **Step 4: Run** the same command → PASS.
- [ ] **Step 5: Commit** `git add src/core/brain/plan.js test/plan.test.js`; `git commit src/core/brain/plan.js test/plan.test.js -m "feat(routing): plan() applies live state to route and tool selection"`.

### Task 4: resolveModel `prefer: 'fast'`

**Files:**
- Modify: `src/core/providers/ollama.js` (`resolveModel`, around line 125; user-modified file, in place, unstaged)
- Test: `test/ollama-prefer.test.js` (new; read `test/ollama.test.js` first for how it builds the provider with stubbed tags/models)

**Interfaces:**
- Consumes: existing `resolveModel(hints)` with `hints.avoid`, `hints.tier`, `hints.tools`, `hints.think`; `fastModel()`, `auto()`, `lastTags`, `lastModels` (`[{ name, size, caps }]`).
- Produces: with `hints.prefer === 'fast'` and `auto()`, `resolveModel` returns the fast model when it is configured, differs from the main model, is in `lastTags` (when known), has `tools` in its `caps` (when `lastModels` is known), and is not `hints.avoid`; otherwise it returns exactly what it returns without the hint.

- [ ] **Step 1: Write failing tests**: honored when installed, has `tools`, differs, not avoided (deep, tools turn returns the fast model); each negative returns the same value as the call without `prefer`: not installed, no `tools` cap, same as main, equals `hints.avoid`, `auto()` false, `fastModel` empty; no `prefer` hint: unchanged (spot-check three existing outcomes).
- [ ] **Step 2: Run** `node --test test/ollama-prefer.test.js` → FAIL.
- [ ] **Step 3: Implement** the `prefer` branch at the top of `resolveModel`, falling through to the existing logic.
- [ ] **Step 4: Run** the new test and `node --test test/ollama*.test.js` → PASS.
- [ ] **Step 5: Commit** only the new test (`git add test/ollama-prefer.test.js`, commit that path); the `ollama.js` hunk is committed in Task 7.

### Task 5: Orchestrator wiring

**Files:**
- Modify (in place, unstaged): `src/core/orchestrator.js` (the `live`/`fu` block near line 187-225, `currentSpecs()` near 238, the model-call `catch` near 328, the `route` event near 251), `src/main/main.js` (the `confirm` live source)
- Test: `test/routing-integration.test.js` (new; real `createOrchestrator` + real `createToolRunner`, fake provider from `test/helpers/fake-provider.js`, a stub `live = { snapshot: () => fixture }`, read `test/orchestrator.test.js` and `test/tasks-integration.test.js` for patterns)

**Interfaces:**
- Consumes: `plan()` (Task 3), `cooling` (Task 1), `bus.emit('modelfail', { model })`, `resolveModel(hints)` (Task 4).
- Produces: when `live` is set, one guarded `plan()` call replaces the direct `route()`/`selectGroups()` calls and the inline `continue` handling (the existing "skill match" and "escalated" upgrades stay); the snapshot already taken for `resolveFollowUp` is reused (one `live.snapshot()` per turn); `hints.avoid` flows into `resolveModel`; `currentSpecs()` drops `plan.avoid.tools` unless that would leave no tool; the model-call `catch` emits `modelfail` `{ model }` for the failed model (not for aborts or timeouts the user caused: only genuine call failures); `plan().notes` are appended to the `route` event `reason`; `main.js` confirm source adds `group: ctx.catalog.groupOf(a.tool)` when known. With `live` absent the old code path runs byte-for-byte.

- [ ] **Step 1: Write failing tests** in `test/routing-integration.test.js`: `live` absent → same tools/route events as today for a plain turn; a snapshot with two failed `web_search` runs → `web_search` missing from the specs sent to the provider while another tool remains, but a model call to `web_search` by name still runs; a cooling tool that is the only one in scope stays offered; a failing provider call emits `modelfail` with the model name, and a second turn with a snapshot listing it twice passes `hints.avoid` to `resolveModel`; a pending-confirm snapshot turns a chat-like message into a tools turn and the `route` event reason contains `confirm pending`; a `continue` follow-up behaves as the current inline code did (group seeded, tools forced); `plan` throwing (inject a bad `catalog`/snapshot) logs one warning and the turn proceeds with plain output; a task step (`tools.run` direct) of a cooling tool still executes.
- [ ] **Step 2: Run** `node --test test/routing-integration.test.js` → FAIL.
- [ ] **Step 3: Implement** the wiring as specified; keep every hook wrapped so any failure falls back to today's behaviour; keep each file's line endings.
- [ ] **Step 4: Run** the new test, then `npm test` → PASS (the existing orchestrator and live-state tests stay green).
- [ ] **Step 5: Commit** only `test/routing-integration.test.js`; the existing-file hunks are committed in Task 7. Note that the committed test needs those hunks to pass on a clean checkout.

### Task 6: Eval fixtures and cases

**Files:**
- Modify (in place, unstaged): `eval/run.js` (optional per-case `live` fixture), `eval/questions.json` (about 12 cases)
- Test: `test/eval-questions.test.js` stays green; add `test/eval-live-fixture.test.js` (new) for the fixture plumbing

**Interfaces:**
- Consumes: the `appFactory`/`make()` structure in `eval/run.js`, `createOrchestrator({ live })`.
- Produces: a question may carry `live` (a snapshot object); `appAsk` passes a stub `live = { snapshot: () => q.live }` to the orchestrator for that case only. Cases: confirm pending ("actually cancel that" → a tool pick), voice single-step (expects `prefer: 'fast'` in the route/model note), voice multi-step (none), failed tool dropped, failed model avoided, "do it again" → `continue`, and one negative per phrase with no `live` that routes as today. Check how `grade` and the existing `pick` field work before choosing the shape.

- [ ] **Step 1: Write failing test** `test/eval-live-fixture.test.js`: `grade` still grades existing cases unchanged; `questions.json` cases with `live` have an object fixture with only known keys (`voice`, `tools`, `models`, `confirm`, `groups`, `t`); ids unique.
- [ ] **Step 2: Run** `node --test test/eval-live-fixture.test.js test/eval-questions.test.js` → FAIL (new test).
- [ ] **Step 3: Implement** the `live` plumbing in `eval/run.js` and add the cases in the file's existing entry shape.
- [ ] **Step 4: Run** `npm test` → PASS. `node eval/run.js app` needs a live Ollama: run it only if available and report the group scores; otherwise say it was skipped.
- [ ] **Step 5: Commit** only `test/eval-live-fixture.test.js`; the `eval/` hunks are committed in Task 7.

### Task 7: Commit the hunks in existing files

**Files:** `src/core/orchestrator.js`, `src/core/providers/ollama.js`, `src/main/main.js`, `eval/run.js`, `eval/questions.json`, and `src/core/livestate/index.js` if it was edited.

**Interfaces:** Consumes the unstaged hunks from Tasks 2 and 4-6. Produces one commit containing only those hunks.

- [ ] **Step 1: List** each file's adaptive-routing hunks (`git diff -- <file>`); anything else in those files is the user's and stays out.
- [ ] **Step 2: Build the commit from a temporary index** so the working tree and anything staged by others are untouched: for each file take `git show HEAD:<file>`, apply only the routing hunks (mixed lines: HEAD line plus only our fragment), `node --check` each `.js` and `JSON.parse` the JSON, `git hash-object -w`, `GIT_INDEX_FILE=<tmp> git update-index --cacheinfo`, `git write-tree`, `git commit-tree -p <HEAD>` with the message `feat(routing): wire plan(), cooldown and model-failure memory into the orchestrator` plus the Co-Authored-By trailer, then `git update-ref HEAD <new> <old>` (fails if HEAD moved; redo on the new HEAD) and update the real index entries for exactly those paths. A hunk whose surrounding code does not exist at HEAD (it depends on the user's uncommitted work) is left out and reported, never committed.
- [ ] **Step 3: Verify**: `git diff HEAD~1 HEAD` has none of the user's unrelated hunks; working tree unchanged; `npm test` passes; extract HEAD (`git archive HEAD`) to a scratch dir and run the routing tests there, reporting any that need the user's uncommitted files.
