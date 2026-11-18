# Morning Brief and Routines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One spoken phrase gives a morning brief; one spoken phrase runs a saved routine (close apps, focus assist, volume, output device, playlist) and another undoes it.

**Architecture:** The brief is a provider plugged into the existing `proactive.briefing` hook plus a fast-path skill. Routines are stored step lists run through the existing task runner after one confirm; the state they change is snapshotted before the run so "undo" can put it back.

**Tech Stack:** Node (CommonJS), Electron main, `node --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-16-morning-brief-and-routines-design.md`

## Global Constraints

- Fast-path skills return `null` (not mine) or `{ reply, record, tool, ok }`; they never throw out to the orchestrator.
- Tools: `{ name, risk, hint, description, params, run }`; `run` returns text or throws. Existing tool names only: `get_time, get_weather, list_timers, news_headlines, connectivity_status, list_windows, close_app, open_app, focus_assist, set_system_volume, audio_output_set, brightness_set, power_plan_set, night_light, bluetooth_set, youtube_music`.
- Quiet hours (`proactive.quietStart/quietEnd`), `proactive.dnd` and `proactive.enabled` are never bypassed.
- Window titles are untrusted text: the brief names apps only.
- Close is polite (`host.closeMain`), never `host.kill`; the `PROTECTED` set in `src/core/tools/pc.js:12` still applies.
- A routine step tool must be in `STEP_TOOLS` (Task 4); never `power`, `delete_to_recycle_bin`, `lock_screen`, `wifi_set`, `task_run`, `task_control`.
- Undo snapshot kept until the next run of that routine or 7 days.
- Do not edit `src/core/tasks/*`.
- Tests: `npm test`; new files `test/<name>.test.js`, same style as `test/tasks-runner.test.js` (fake `tools.run`, temp dirs).

## Review Focus

- Two wakes in one day, or a restart after the brief ran: brief must not repeat (Task 3).
- A weather or news fetch that fails or hangs: brief still speaks the rest, never throws (Task 2).
- Routine name that is a prefix of another ("game" vs "game mode") or collides with a media phrase ("play music"): exact name match only (Task 8).
- App already closed or not open when the routine runs: skip, not failure; undo does not try to reopen it (Task 7).
- Undo with no run, run twice then undo, or snapshot older than 7 days: clear reply, no crash (Task 5).

---

### Task 1: Config for the brief

**Files:**
- Modify: `src/core/config.js` (DEFAULTS, `NESTED`, the validation switch near `okValue`)
- Test: `test/config.test.js` (append)

**Interfaces:**
- Produces: `config.brief = { auto: boolean, onFirstWake: boolean, newsCount: number (1-5), lastDate: string ('' or 'YYYY-MM-DD') }`, defaults `{ auto: true, onFirstWake: true, newsCount: 3, lastDate: '' }`.

- [ ] **Step 1: Write failing tests** in `test/config.test.js`: defaults equal the object above; a patch `{ brief: { newsCount: 9 } }` is rejected or clamped to 5 (follow how `proactive.maxPerHour` is treated in the same file); `{ brief: { lastDate: 'x' } }` rejected; `{ brief: { auto: false } }` accepted and other brief keys keep defaults.
- [ ] **Step 2: Run** `node --test test/config.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement**: add `brief` to `DEFAULTS` (frozen like its neighbours) and to `NESTED`; validate `lastDate` against `/^(?:|\d{4}-\d{2}-\d{2})$/`, `newsCount` via the existing `clampNumber`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Then `npm test`, all pass.
- [ ] **Step 5: Commit** `feat(config): brief settings`.

### Task 2: Brief provider

**Files:**
- Create: `src/core/brief/index.js`
- Test: `test/brief.test.js`

**Interfaces:**
- Produces: `createBrief({ tools, getConfig, now = () => new Date(), timeoutMs = 4000 }) → { build(): Promise<string> }`. `tools.run(name, args, ctx) → Promise<{ ok, text }>`.

Parts, in order, each from one tool call run in parallel with `Promise.allSettled` and a per-part timeout, joined by one space: greeting (by hour: before 12 "Good morning", before 18 "Good afternoon", else "Good evening") + weekday and date; `get_weather`; `list_timers`; `news_headlines` (args `{ count: getConfig().brief.newsCount }`, check the tool's real param name in `src/core/tools/knowledge.js`); `connectivity_status` reduced to the battery sentence only; `list_windows` reduced to a distinct list of app names, max 5. A part that fails, times out, or returns empty text is dropped. Parts are cut to the tool's text, never rewritten by a model.

- [ ] **Step 1: Write failing tests** in `test/brief.test.js`: (a) all tools ok → text starts with "Good morning" at 08:00, contains each tool's text in the order above; (b) `get_weather` rejects and `news_headlines` returns `{ok:false}` → text still has greeting and timers, no "undefined", no throw; (c) a tool that never resolves is dropped after `timeoutMs` (use `timeoutMs: 20`); (d) `list_windows` text `"Open windows: chrome: Secret Bank Tab; code: file.js."` → output has "chrome" and "code" and not "Secret Bank Tab"; (e) all tools fail → returns just the greeting line.
- [ ] **Step 2: Run** `node --test test/brief.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `createBrief` as described. Parse `list_windows` app names with the `app: title` format its tool prints (`src/core/tools/pc.js:129-138`).
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(brief): provider`.

### Task 3: Brief phrase, first wake, wiring

**Files:**
- Create: `src/core/skills/brief/index.js` (fast path, exports `createBriefSkill`), `src/core/brief/firstwake.js`
- Modify: `src/main/main.js` (after `ctx.proactive` is created ~line 449 and in the `fastPath` chain ~line 342)
- Test: `test/brief-skill.test.js`, `test/brief-firstwake.test.js`

**Interfaces:**
- Consumes: `createBrief` (Task 2); `ctx.proactive.briefing.set(fn)` / `.run()` (`proactive/engine.js:120`).
- Produces: `createBriefSkill({ brief }) → { handle(text, opts): Promise<null | { reply, record, tool: 'morning_brief', ok: true }> }`. Matches (after lowercasing, stripping punctuation and a leading "jarvis"/"please") exactly: `morning brief`, `my morning brief`, `brief me`, `give me the brief`, `what's my day look like`, `what does my day look like`.
- Produces: `createFirstWake({ bus, getConfig, saveBriefDate(date: string), run: () => Promise<void>, now = () => new Date(), isQuiet(config, date): boolean })` — subscribes to bus `wake`; on a wake where `config.brief.auto && onFirstWake`, `lastDate !== today (local YYYY-MM-DD)`, and not quiet hours: calls `saveBriefDate(today)` first, then `run()`. Returns `{ stop() }`. Export `inQuiet` from `proactive/engine.js` for `isQuiet` (add to its return value as a named export, no behaviour change).

- [ ] **Step 1: Write failing tests**: skill — each phrase above returns the stub brief text as `reply`; "morning" alone, "brief" alone and "what's the weather" return `null`. First wake — emitting `wake` twice the same day runs once; a different next day runs again; `auto:false` never runs; quiet hour never runs and does not save the date; `saveBriefDate` is called before `run` (record order); `run` rejecting does not throw out of the bus handler.
- [ ] **Step 2: Run** `node --test test/brief-skill.test.js test/brief-firstwake.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules. In `main.js`: create `const brief = createBrief({ tools: ctx.tools, getConfig: ctx.getConfig })` after `ctx.tools` exists; `ctx.proactive.briefing.set(() => brief.build())`; `ctx.briefSkill = createBriefSkill({ brief })`; add `briefFast` to the `fastPath` chain right after `tasksFast` using the same try/catch pattern; `createFirstWake` with `saveBriefDate: d => ctx.saveConfig({ ...ctx.config, brief: { ...ctx.config.brief, lastDate: d } })` and `run: () => ctx.proactive.briefing.run()`.
- [ ] **Step 4: Run** the two tests, then `npm test`. Expected: PASS.
- [ ] **Step 5: Manual check** with `npm start`: type "morning brief" in chat and read the reply; say the wake word the first time and hear it once.
- [ ] **Step 6: Commit** `feat(brief): phrase, first-wake trigger, wiring`.

### Task 4: Routine store

**Files:**
- Create: `src/core/routines/store.js`
- Test: `test/routines-store.test.js`

**Interfaces:**
- Produces: `STEP_TOOLS: Set<string>` = `routine_close, open_app, focus_assist, set_system_volume, audio_output_set, brightness_set, power_plan_set, night_light, bluetooth_set, youtube_music`. `normName(s): string` (lowercase, strip punctuation, collapse spaces, drop leading "the"). `createRoutineStore({ file, now = Date.now, log }) → { list(): Routine[], get(name): Routine|null, save(routine): { ok, error? }, remove(name): boolean, setLastRun(name, run): void }`. `Routine = { name, steps: [{ tool, args }], lastRun?: { at, snapshot, token? } }`. File is JSON, atomic write (temp + rename), a corrupt file is moved to `<file>.broken` and treated as empty.

- [ ] **Step 1: Write failing tests**: save then get by `normName` ("Game Mode!" finds "game mode"); a step with tool `power` or `task_run` is rejected with the tool name in `error`; more than 12 steps rejected; empty name rejected; a name that equals a reserved phrase (`undo`, `list`, `stop`, `play`, `pause`, `resume`, `yes`, `no`) rejected; corrupt file → `list()` is `[]` and `.broken` exists; `setLastRun` survives reload.
- [ ] **Step 2: Run** `node --test test/routines-store.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the store.
- [ ] **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(routines): store`.

### Task 5: Snapshot and undo

**Files:**
- Create: `src/core/routines/snapshot.js`
- Test: `test/routines-snapshot.test.js`

**Interfaces:**
- Consumes: `host` (see `src/core/pc/host.js`: `audioDevices()`, `audioSetDefault(id)`, `brightness()`, `setBrightness(n)`, `powerPlans()`, `setPowerPlan(id)`, `focusAssist(on?)`, `nightLight(on?)`, `bluetooth()`), `media.state()` / `media.act` for volume (as in `set_system_volume`), `openApp: (name) => Promise<string>`.
- Produces: `takeSnapshot({ host, media, steps }) → Promise<Snapshot>`: reads only the state the steps touch: `volume` (0-100) for `set_system_volume`, `output` (device id + name) for `audio_output_set`, `focus` (bool) for `focus_assist`, `brightness`, `powerPlanId`, `nightLight`, `bluetooth`, and `apps: [{ name }]` for each `routine_close` step that is actually open at run time. Each read failure stores `null` for that key.
- Produces: `undoSnapshot({ host, media, openApp, snapshot, now }) → Promise<{ ok: boolean, lines: string[] }>`: restores in reverse of the order keys were captured; each line says "restored X" or "could not restore X: reason"; a `null` key says "skipped X (was not readable)"; reopens apps with `openApp`; `ok` is true only if no line says could not restore. Snapshot older than 7 days (`snapshot.at`) → `{ ok:false, lines:['That run is more than a week old; I will not undo it.'] }`.

- [ ] **Step 1: Write failing tests** with a fake host: snapshot of steps `[focus_assist, set_system_volume]` reads only focus and volume; undo sets focus back to the snapshotted value and volume to the snapshotted value, in reverse order; a setter that throws gives a "could not restore" line and `ok:false` while later restores still run; app list reopens via `openApp`, an `openApp` rejection gives a line not a throw; stale snapshot refused; empty snapshot → one line "nothing to undo".
- [ ] **Step 2: Run** `node --test test/routines-snapshot.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement**. Spoken lines come from this function only (no model text).
- [ ] **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(routines): snapshot and undo`.

### Task 6: Hidden polite close tool

**Files:**
- Create: `src/core/routines/close-tool.js`
- Test: `test/routines-close.test.js`

**Interfaces:**
- Consumes: the app-window lookup and `PROTECTED` set used by `close_app` in `src/core/tools/pc.js` (export `PROTECTED` and the `windowsFor`-style helper from `createPcTools` instead of copying them; keep `close_app` behaviour identical).
- Produces: `createRoutineClose({ pcTools, host, tokens }) → tool` with `name: 'routine_close'`, `risk: 'safe'`, params `{ name: string, token: string }`. `tokens: { issue(): string, valid(t): boolean, revoke(t): void }` from `createTokens()` in the same file (random, single run, 30 min expiry). Behaviour: invalid token → throws "Not allowed"; protected app → throws; app not open → returns "<name> was not open." (success); else `host.closeMain(pid)` for each pid, wait up to 5 s, return "Closed <name>." or throw "<name> is still open (it may be asking to save). I left it." Never calls `host.kill`.

- [ ] **Step 1: Write failing tests**: bad token throws and closes nothing; good token closes via `closeMain` only (assert `kill` never called); `explorer` refused; not-open returns ok text; still-alive after wait throws the "left it" message; revoked token refused.
- [ ] **Step 2: Run** `node --test test/routines-close.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement**; export the shared helpers from `pc.js` without changing its public tool list.
- [ ] **Step 4: Run** this test and `node --test test/pc-tools.test.js` (or the existing pc tool tests; find them with `ls test | grep pc`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(routines): polite close tool`.

### Task 7: Run a routine

**Files:**
- Create: `src/core/routines/run.js`
- Test: `test/routines-run.test.js`

**Interfaces:**
- Consumes: store (Task 4), `takeSnapshot`/`undoSnapshot` (Task 5), tokens (Task 6), `runner.start({ title, steps, turn, sessionId, signal })` (`src/core/tasks/runner.js`), `confirm.propose({ tool, summary, args, run })` (`src/core/pc/confirm.js`).
- Produces: `createRoutineRunner({ store, runner, confirm, tokens, snapshot, undo, log }) → { run(name, { turn, signal }): Promise<{ ok, text }>, undo(name?): Promise<{ ok, text }>, describe(routine): string }`.
- `describe` gives one line: "Game mode: close Discord and Chrome, focus assist on, volume 40, headphones, play Lo-fi." built from step args (not model text).
- `run`: unknown name → `{ ok:false }`; `turn.tainted` and routine has a `routine_close` step → refuse with a clear reason; routine with a `routine_close` step → `confirm.propose` with summary = `describe(routine)` + " Go?" and the run happens in its `run` callback; routine with none → runs at once. The run: take snapshot, issue token, replace `{{token}}` in `routine_close` step args, `runner.start`, `setLastRun(name, { at, snapshot })`, revoke token in `finally`. Result text = runner report text.
- `undo(name?)`: with no name, the routine with the newest `lastRun`; no lastRun → `{ ok:false, text:'There is nothing to undo.' }`; otherwise `undoSnapshot` and clear `lastRun.snapshot` so a second undo says "already undone".

- [ ] **Step 1: Write failing tests** with fakes: run of a no-close routine calls `runner.start` once and never `confirm.propose`; run with close step proposes first and does not start the runner until the proposal's `run` is called; the closed-app token in `runner.start` steps is valid during the run and revoked after; snapshot is taken before `runner.start` (record order); tainted turn refused; undo with no lastRun; double undo; routine whose app was not open: snapshot `apps` empty so undo does not reopen it.
- [ ] **Step 2: Run** `node --test test/routines-run.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run**. Expected: PASS.
- [ ] **Step 5: Commit** `feat(routines): run and undo`.

### Task 8: Routines fast path and wiring

**Files:**
- Create: `src/core/routines/skill.js`, `src/core/skills/routines/index.js`
- Modify: `src/core/skills/index.js` (`ORDER`), `src/main/main.js` (create store in `DATA_DIR`, tokens, routine tool in the catalog deps, `routinesFast` in the `fastPath` chain after `briefFast`)
- Test: `test/routines-skill.test.js`

**Interfaces:**
- Produces: `createRoutinesSkill({ store, routines }) → { handle(text, { source, signal }) }` returning `null` or `{ reply, record, tool: 'routine', ok }`. After `normName`: exact routine name, or `run <name>`, `start <name>`, `activate <name>`, `<name> mode` when the routine name is `<name> mode`, `undo <name>`, `undo that routine`, `undo the routine`, `what routines do i have` / `list routines` / `list my routines`. Anything else → `null` (so "undo that" stays with the media and file undo).
- Produces: group `routines` in `skills/index.js` containing only the hidden tool `routine_close`, `triggers: []`, `label: 'saved routines'`, so no turn loads it and `capsLine` lists it harmlessly. Tool resolves for the task runner via `ctx.tools`.

- [ ] **Step 1: Write failing tests**: "game mode", "Game mode!", "run game mode", "start game mode" all run `game mode`; "game" alone with a routine named `game mode` → `null`; "undo game mode" and "undo that routine" call `routines.undo`; "undo that" → `null`; "list routines" lists names or says there are none; a routine named `play music` is impossible (store reserved check, covered in Task 4) and "play music" → `null` when no such routine; a throw from `routines.run` becomes `{ ok:false }` with a short reply, not an exception.
- [ ] **Step 2: Run** `node --test test/routines-skill.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement**, wire into `main.js` with the same try/catch pattern as `tasksFast`.
- [ ] **Step 4: Run** the test, then `npm test`. Expected: PASS.
- [ ] **Step 5: Manual check** (`npm start`): save a routine by editing `routines.json` in the data folder (Task 9 adds the form), say "game mode", answer yes, then "undo game mode".
- [ ] **Step 6: Commit** `feat(routines): fast path and wiring`.

### Task 9: Settings form for routines

**Files:**
- Modify: `src/ui/settings.html`, `src/ui/settings.js`, `src/main/ipc.js`, `src/main/preload.js`
- Test: `test/ipc.test.js` (append)

**Interfaces:**
- Consumes: `store.list/save/remove` (Task 4).
- Produces: IPC channels `routines:list → Routine[]`, `routines:save(routine) → { ok, error? }`, `routines:remove(name) → boolean`, registered in `ipc.js` following how settings channels are registered; a "Routines" section in settings: list, add, delete, and per routine a name field plus ordered step rows (tool picker from `STEP_TOOLS` minus `routine_close` shown as "Close app", args fields per tool: app name, percent, device name, on/off, playlist query).

- [ ] **Step 1: Write failing tests** in `test/ipc.test.js`: the three channels exist and delegate; `routines:save` with a bad tool returns `{ ok:false, error }`.
- [ ] **Step 2: Run** `node --test test/ipc.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** IPC and the form, following the existing settings sections for structure and styling.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Manual check:** make "game mode" in the form, run it by voice, undo it.
- [ ] **Step 6: Commit** `feat(routines): settings form`.

### Task 10: Docs

**Files:**
- Modify: `README.md` (skill group table, "What it can do"), `docs/jarvis-prompt-rules.md` only if a prompt rule was added (none expected)

- [ ] **Step 1:** Add `routines` and the morning brief to the README group table and voice phrases, with the privacy note that nothing leaves the PC.
- [ ] **Step 2:** `npm test`, all pass.
- [ ] **Step 3: Commit** `docs: morning brief and routines`.

---

## Calls made in this plan (differ from or fill gaps in the spec)

- Snapshot is taken once before the run (only keys the routine touches), not per step. Same restore result, no change to `src/core/tasks/*`.
- The hidden close tool is protected by a single-run token rather than by hiding it from the model, so a model call without the token fails.
- Routines with no close step run without a question, as the spec says.
- Brief news count config is `brief.newsCount` (default 3); the real `news_headlines` param name is read from its source in Task 2.
