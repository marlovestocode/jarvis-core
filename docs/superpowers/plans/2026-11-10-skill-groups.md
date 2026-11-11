# JARVIS Skill Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat ~40-tool list with skill groups loaded per turn by keyword scoring (plus `more_skills` and auto-load recovery), then add Windows/apps, Files and Browser skills.

**Architecture:** Tools are regrouped into `src/core/skills/<id>/index.js` factories (`createGroup(deps) → Group`). A catalog maps names and aliases to tools and groups. `selectGroups()` scores utterances; the orchestrator opens a per-turn scope (`runner.turn(ids)`) that exposes only the loaded groups' specs and can load more mid-turn. Existing tool files stay where they are; groups import them.

**Tech Stack:** Node (CommonJS), `node:test` (`npm test`), PowerShell host (`src/core/pc/pc-host.ps1`), Chrome MV3 extension in `extension/`.

**Spec:** `docs/superpowers/specs/2026-11-10-skill-groups-design.md` (build order = its section 8). Prompt rules: `docs/jarvis-prompt-rules.md`.

## Global Constraints

- Tool shape is unchanged: `{ name, description, params, run, risk: 'safe'|'confirm', timeoutMs }`; new optional fields `aliases: string[]` and `untrusted: true`.
- `risk: 'confirm'` is confirmed from the user's own next utterance in code (`pc/confirm.js`), never from a tool argument.
- Tainted turns cannot start `confirm` tools (`registry.run`, `brain/guard.js`). Auto-load and `more_skills` never bypass `risk` or taint.
- File skills go through `pc/paths.js` `safePath`, write `pc/actions-log.js`, and journal undo data.
- Claim guard (`brain/guard.js` `unbackedClaim`) must keep working: tools that return outside text are `untrusted` and do not count as backing an action.
- Cap: at most 2 extra group loads per turn (`more_skills` and auto-load share it). Selection threshold 2, top 2 groups, follow-up bonus +1, no match on a deep turn = `core` + `knowledge`, fast tier = no tools.
- Browser group is **off by default** behind `config.browser.enabled`; the extension command set is a fixed switch (JARVIS never sends code).
- Branch `feat/skill-groups`. `src/core/media/rank.js` and `test/ytmusic.test.js` have unrelated uncommitted edits: never `git add` them; always `git add <explicit paths>`.
- One commit per task, `npm test` green before each. Real-PC behaviour (window moves, screenshots, clipboard, Wi-Fi, desktops, extension) is only listed in `docs/superpowers/plans/2026-11-10-skill-groups-checklist.md`, never claimed verified.

## Review Focus

Inputs the spec implies but no obvious test covers, most likely first. Each has a pinning test in the named task.

1. Model calls a `confirm` tool from an unloaded group in a tainted turn: auto-load must still refuse (Task 2).
2. Two groups tie on score, or three score above threshold: result is deterministic (score, then catalog order) and capped at 2 (Task 2).
3. `more_skills` with wrong case, an alias, a group already loaded, or a third call: no double count, clear message (Task 2).
4. `unzip` with `..` or absolute entry names (zip-slip), `rename_files` to Windows-reserved names (`CON`, `NUL`), trailing dots, case-only renames and collisions, paths via junction/UNC/`file.txt::$DATA` (Tasks 4a, 4b).
5. Browser: `open_url` with `javascript:`, `file:`, `chrome:` schemes; extension drops mid-call; page text containing "ignore previous instructions" returns quoted and taints the turn; optional permission not granted (Task 5).
6. `clipboard_write` during a tainted turn is refused (Task 3d).

## File Structure

| Path | Responsibility |
|---|---|
| `src/core/skills/index.js` | `loadGroups(deps)`, `buildCatalog(groups)`, `capsLine(catalog, state)` |
| `src/core/skills/select.js` | `selectGroups(text, { lastGroups, source }, catalog)` scoring |
| `src/core/skills/util.js` | `own(tool, aliases)`, `trig(...)` helpers |
| `src/core/skills/<id>/index.js` | one group each: `core`, `media`, `ytmusic`, `timers`, `knowledge`, `system`, `pc`, `math`, `memory`; new: `windows`, `audio-display`, `connectivity`, `clipboard-capture`, `files`, `browser` |
| `src/core/tools/registry.js` | `createToolRunner(tools, { groups })`, `runner.turn(ids)`, tool-owned aliases |
| `src/core/orchestrator.js` | per-turn scope, per-round specs, `lastGroups` |
| `src/core/brain/prompt.js` | `groupHints` param, `more_skills` hint |
| `src/core/pc/pc-host.ps1`, `host.js` | new host commands (windows, display, audio, power, clipboard, capture) |
| `extension/browser.js` + `background.js`, `manifest.json`, `popup.*` | fixed browser command switch, optional permissions |
| `test/fixtures/tool-manifest.json` | pre-migration snapshot of every tool's name, description, params, risk, timeoutMs |
| `test/fixtures/route-golden.json` | utterance → expected group ids (~150 by Task 5) |
| `test/helpers/tool-deps.js` | stub deps that make `defaultTools` build every tool |

---

### Task 1: Group framework and pure migration

**Files:**
- Create: `test/helpers/tool-deps.js`, `test/fixtures/tool-manifest.json`, `test/skills-migration.test.js`, `src/core/skills/{index,util}.js`, `src/core/skills/{core,media,ytmusic,timers,knowledge,system,pc,math,memory}/index.js`
- Modify: `src/core/brain/index.js` (`defaultTools` builds from groups, same signature and return), `src/core/tools/registry.js` (aliases come from tools), `src/core/orchestrator.js` (taint via `res.untrusted`)

**Interfaces:**
- Produces: `loadGroups(deps) → Group[]` where `Group = { id, label, triggers, hint?, tools }` (a group with no tools is dropped); `buildCatalog(groups) → { groups, tools, ids, byName: Map<name|alias, { tool, groupId }>, groupOf(name) → id|null }`; `own(tool, aliases) → tool` (returns `{ ...tool, aliases }`); `createToolRunner(tools)` unchanged signature; tool `aliases` resolve like the old `ALIASES`; `run()` result gains `untrusted: boolean` (`tool.untrusted === true`).
- Group membership: `core` = `get_time`, `jarvis_status`; `media` = `media_control`, `media_status`, `youtube_music`; `ytmusic` = `ytm_library`, `ytm_play_library`, `ytm_playlist_edit`, `music_stats`; `timers` = the five timer tools; `knowledge` = `lookup_knowledge`, `read_article`, `news_headlines`, `get_weather`, `weather_alerts`, `sports_scores`; `system` = `get_system_stats`; `pc` = the twelve `createPcTools` tools; `math` = the eight `skillTools()`; `memory` = `remember`, `forget_memory`. Triggers are `[]` in this task.

- [ ] **Step 1: Capture the baseline before changing code.** Write `test/helpers/tool-deps.js` exporting `toolDeps()` that returns stubs for every `defaultTools` option (`getStatus`, `fetch`, `fetcher`, `kiwix`, `getConfig`, `bus`, `media`, `ytm`, `ytPlaylists`, `memory`, `playLog`, `scheduler`, `pc` with fixed roots `C:\\t\\Desktop`, `C:\\t\\Documents`, `C:\\t\\Downloads`, `C:\\t\\Projects`) so all branches of `defaultTools` build. Run `node -e` once to write `test/fixtures/tool-manifest.json`: array of `{ name, description, params, risk: risk ?? null, timeoutMs: timeoutMs ?? null }` from the **current** `defaultTools(toolDeps())`, sorted by name. Commit this fixture alone before any other change.
- [ ] **Step 2: Write the failing migration test** `test/skills-migration.test.js`:
  - `'migration: every tool keeps name, description, params, risk and timeout'` compares the same projection of `defaultTools(toolDeps())` to the fixture with `assert.deepEqual` (so missing, extra or changed tools fail).
  - `'migration: every old alias still resolves to the same tool'`: for the 50 entries of the old `ALIASES` table (copy the table literally into the test as `OLD_ALIASES`), `createToolRunner(defaultTools(toolDeps())).run(alias, {}, { turn: { tainted: false } })` must not return `unknown tool`; and `byName` of `buildCatalog(loadGroups(toolDeps()))` maps each alias to the tool named in `OLD_ALIASES`.
  - `'catalog: each tool belongs to exactly one group'` and `'catalog: group ids'` equals `['core','media','ytmusic','timers','knowledge','system','pc','math','memory']`.
  - `'runner: untrusted flag'`: `find_files`, `list_windows`, `lookup_knowledge`, `read_article`, `news_headlines`, `get_weather`, `weather_alerts`, `sports_scores` results carry `untrusted: true`; `get_time` does not.
- [ ] **Step 3: Run it and see it fail** — `npm test -- test/skills-migration.test.js` (`node --test test/skills-migration.test.js`): fails, `src/core/skills` missing.
- [ ] **Step 4: Implement the framework.** Each group file exports `createGroup(deps) → Group | null` and builds its tools with the existing factories under the same conditions `defaultTools` uses today (e.g. `ytPlaylists` present, `memory` present). Move every entry of the global `ALIASES` table onto the tool that owns it with `own(tool, [...])` (e.g. `media_control` gets `['set_volume','media']`, `power` gets `['shutdown','restart','sleep']`); delete the global table. `registry.createToolRunner` builds `byName` from `tool.name` and every `tool.aliases`, and the unknown-tool message still lists real tool names only. Set `untrusted: true` on the 8 tools above via `own` (group files), and in `orchestrator.js` change the taint check to `res.untrusted || UNTRUSTED_TOOLS.has(call.name)` (keep `UNTRUSTED_TOOLS` exported). `defaultTools(opts)` becomes `buildCatalog(loadGroups(opts)).tools`.
- [ ] **Step 5: Run the whole suite** — `npm test`: all 629 pre-existing tests plus the new ones pass.
- [ ] **Step 6: Commit** — `git add test/helpers/tool-deps.js test/skills-migration.test.js src/core/skills src/core/brain/index.js src/core/tools/registry.js src/core/orchestrator.js` (the fixture is already committed in Step 1); message `refactor: group tools into skill groups (no behaviour change)`.

---

### Task 2: Dispatch: `selectGroups`, `more_skills`, auto-load, per-turn specs, capabilities line

**Files:**
- Create: `src/core/skills/select.js`, `test/fixtures/route-golden.json`, `test/skills-select.test.js`, `test/skills-turn.test.js`, `test/skills-tokens.test.js`
- Modify: `src/core/skills/{index.js}` (triggers for all nine groups, `capsLine`), `src/core/skills/core/index.js` (`more_skills`), `src/core/tools/registry.js` (`runner.turn`), `src/core/orchestrator.js`, `src/core/brain/prompt.js`, `src/main/main.js` (pass `selectGroups`, group caps)

**Interfaces:**
- Consumes: Task 1 catalog (`byName`, `groupOf`, `groups`).
- Produces:
  - `selectGroups(text: string, { lastGroups: string[], source: string }, catalog) → string[]` — always starts with `'core'`, then up to 2 groups with score ≥ 2 (ties broken by catalog order); no match → `['core','knowledge']`. Score = sum of matching trigger weights (`{ re, w }` or `{ words, w }`, word match is whole-word, case-insensitive) + 1 for each group in `lastGroups`; the +1 alone never reaches the threshold.
  - `runner.turn(ids: string[]) → { specs(): Spec[], run(name, args, ctx): Promise<{ ok, text, untrusted? }>, loaded(): string[], hints(): string[] }`. `createToolRunner(tools, { groups })`; without `groups`, `turn()` exposes all tools (flat mode) so old flat-runner tests keep working.
  - `ctx.skills = { load(groupId): { ok, text } }` is set by `turn().run`; `more_skills` is a `core` tool `{ group: string }`, `risk: 'safe'`.
  - Orchestrator option `selectGroups(text, opts) → string[]` (injected like `route`); a per-session `lastGroups` map in the closure.
  - `systemPrompt({ ..., groupHints: string[] })`; `skills.capsLine(catalog, { browser: 'off'|'not connected'|'connected' }) → string` listing every group's `label`.
- Initial triggers (weights are starting values; the golden table tunes them): `media` play/pause/resume/skip/louder/quieter/mute/shuffle/queue/song/track/album/spotify (w3), "volume"/"music" (w2); `ytmusic` playlist(s)/liked/"add (this|it) to"/top artists/listening/taste (w3); `timers` timer/alarm/remind(er)/"wake me" (w3); `knowledge` weather/forecast/news/headlines/score(s)/standings (w3), the router `FACT` start words (w2); `system` cpu/gpu/ram/vram/temperature/fps/sysmon/"disk usage" (w3); `pc` open/launch/close/quit/"switch to"/window/folder/move/delete/recycle/undo/lock/shutdown/restart/sleep (w2); `math` the router `MATH`/`SCIENCE`/`UNITS`/`DATES` regexes (w3); `memory` remember/forget/"my name is"/"call me" (w3). Write them in each group's `triggers`.

- [ ] **Step 1: Failing selection tests** `test/skills-select.test.js` — `'select: golden table'` loops `route-golden.json` (`[{ text, lastGroups?, expect: string[] }]`, ~60 rows for the nine groups now: voice phrasings from `test/brain.test.js`, e.g. `'turn down Chrome application by 10%.'` → `['core','media']`, `'play my gym playlist'` → `['core','ytmusic','media']` (ordered by score, top 2 after core); `'what is 23.7^3.2'` → `['core','math']`; fast-tier chat such as `'tell me a joke'` is not in the table because it never selects groups). Plus: `'select: follow-up bonus'` (`'now close it'` with `lastGroups:['pc']` → `pc`, without → `core`+`knowledge`); `'select: bonus alone never loads'`; `'select: tie is deterministic'`; `'select: caps at two groups'`; `'select: no match → core+knowledge'`.
- [ ] **Step 2: Failing turn tests** `test/skills-turn.test.js`:
  - `'turn: specs only for loaded groups'`; `'turn: more_skills adds a group for the rest of the turn'`; `'turn: unknown group returns the group ids'`; `'turn: wrong case and aliases load the group, reloading a loaded group costs nothing'`; `'turn: third extra load is refused with a message and runs nothing'`.
  - `'turn: auto-load runs a tool from an unloaded group and counts against the cap'`.
  - `'turn: auto-load of a confirm tool in a tainted turn is refused'` (Review Focus 1): `ctx.turn.tainted = true`, call `move_files` from unloaded `pc` → `{ ok:false }` containing `won't start that from text I read`, and the group is not loaded.
  - `'turn: auto-load does not turn a confirm tool into a safe one'` (`risk` still `confirm`, still returns `NEEDS_OK` via the confirm flow).
  - Orchestrator (in `test/orchestrator.test.js` style, fake provider): `'orchestrator: specs are recomputed each round'` (round 2 sees the group loaded in round 1); `'orchestrator: lastGroups carries to the next turn of the same session'`; `'orchestrator: fast tier sends no tools'` still passes.
- [ ] **Step 3: Failing size test** `test/skills-tokens.test.js` — `'tokens: selected specs are at least 60% smaller than today's flat list'`: baseline = `JSON.stringify` length of the fixture manifest's `{name, description, params}`; for every golden row whose `route()` tier is `deep`, selected length = `JSON.stringify(turn(ids).specs())`; assert mean(selected) ≤ 0.4 × baseline. Also print the numbers with `t.diagnostic`.
- [ ] **Step 4: Run, see all new tests fail.**
- [ ] **Step 5: Implement** `select.js`, `runner.turn`, `more_skills` (message on success `Loaded <label>: <tool names>.`; on unknown `Unknown group. Groups: <ids>.`; on cap `Cannot load more skills this turn (limit 2). Answer with what you have.`), auto-load inside `turn().run` (unknown-to-scope name whose `byName` entry has a `groupId` → `ctx.skills.load` then run through the same path so `risk`/taint checks apply). Orchestrator: compute `ids` once per turn (skip when `hints.tools === false`), `scope = tools.turn(ids)`, replace the single `toolSpecs` computation with `scope.specs()` per round, rebuild `sys` when `scope.loaded()` changed, store `lastGroups = scope.loaded()` minus `core` after the turn (not when stopped or errored). Prompt: add `more_skills` hint to `TOOL_HINTS` ("more_skills: load another skill group when your tools do not cover the request; groups are listed under Capabilities."), render `groupHints`. `main.js`: pass `selectGroups`, replace the hard-coded media/math/timers/PC capability sentences in `capsLine()` with `skills.capsLine(...)`, keep the live wake-word/voice/ytm/listening-log/STT items.
- [ ] **Step 6: Tune triggers until the golden table and the 60% test pass; do not loosen the assertions.** If the reduction cannot reach 60%, stop and report the measured numbers instead of lowering the bar.
- [ ] **Step 7: `npm test` green; commit** — `feat: dispatch skill groups per turn (select, more_skills, auto-load)`.

---

### Task 3a: Windows group (`windows`)

**Files:** Create `src/core/skills/windows/index.js`, `test/skills-windows.test.js`. Modify `src/core/pc/pc-host.ps1` (commands `place`, `monitors`, `moveToMonitor`, `desktopSwitch`, `desktopMove`; `windows` also returns `responding` and `rect`), `src/core/pc/host.js` (typed wrappers), `test/helpers/fake-pc-host.js`, golden table, checklist file.

**Interfaces:**
- Produces host methods: `place(hwnd, layout) → { ok, rect }` (layouts `left|right|top_left|top_right|bottom_left|bottom_right|maximize|minimize|restore|center`), `monitors() → [{ n, primary, x, y, w, h }]`, `moveToMonitor(hwnd, n) → { ok, rect }`, `desktopSwitch(target: 'next'|'previous'|number) → boolean`, `desktopMove(hwnd, n) → boolean`; `windows()` entries gain `responding: boolean`.
- Tools (names fixed): `window_arrange { target?: string, layout }` safe; `window_to_monitor { target?: string, monitor: integer | 'next' }` safe; `desktop_switch { to: 'next'|'previous'|integer }` safe; `window_to_desktop { target?: string, desktop: integer }` safe; `end_unresponsive_app { name: string }` **confirm**. `target` omitted = the foreground window. Each tool reads the result back from the host (`rect` within the requested area, window `responding`/gone) and throws if it cannot verify, like `focus_window`.
- Triggers: snap/maximi[sz]e/minimi[sz]e/restore/"left half"/"right half"/monitor/"second screen"/desktop/"virtual desktop"/"not responding"/frozen/hung (w3); window/resize (w1).

- [ ] **Step 1: Failing tests** (fake host, no real PC): `'windows: snap left asks the host for left and verifies the rect'`; `'windows: layout outside the enum is refused'`; `'windows: unknown target says which windows exist'`; `'windows: monitor number out of range lists monitors'`; `'end_unresponsive_app: only a window the host reports responding:false'` (a healthy window → error, nothing killed); `'end_unresponsive_app: protected processes are refused'` (reuse `PROTECTED` from `tools/pc.js`, export it); `'end_unresponsive_app: confirm flow ends only the pids it proposed, after yes'`; `'end_unresponsive_app: tainted turn cannot start it'`. Add ~15 golden rows for `windows`.
- [ ] **Step 2: Run, see them fail.**
- [ ] **Step 3: Implement** host commands (Win32 `SetWindowPlacement`/`MoveWindow` with `MonitorFromWindow` work areas; desktop switching and moving through Windows' virtual-desktop shortcuts and the documented `IVirtualDesktopManager` for `desktopMove` by GUID when available) and the five tools. `desktop_*` cannot be proven without the real PC: when the host cannot do it it must throw `Virtual desktops are not available on this Windows build`, never report success.
- [ ] **Step 4: `npm test` green; add the "Windows" section to the checklist file** (snap, monitor move, each layout, desktops next/previous/number, move to desktop, hung app flow with a deliberately frozen test app).
- [ ] **Step 5: Commit** — `feat: windows skill group`.

### Task 3b: Audio and display (`audio-display`)

**Files:** Create `src/core/skills/audio-display/index.js`, `test/skills-audio-display.test.js`. Modify `pc-host.ps1`, `host.js`, fake host, golden table, checklist.

Note: per-app volume and mute and system mute already exist in `media_control` (`media` group); this group adds only what is missing and its triggers must not claim "volume"/"mute".

**Interfaces:**
- Host: `audioDevices() → [{ id, name, default }]`, `audioSetDefault(id) → boolean`, `brightness() → number|null`, `setBrightness(pct) → number|null`, `displays() → [{ n, primary, w, h, hz }]`, `nightLight(on?) → boolean|null`.
- Tools: `audio_devices {}` safe; `audio_output_set { name: string }` safe (fuzzy match with `matchText`, ambiguous → ask which); `brightness_set { percent?: number, by?: number }` safe (laptop panels; says so when unsupported); `displays_list {}` safe; `night_light { on: boolean }` safe. Every setter reads the value back and throws on mismatch.
- Triggers: "output device"/speakers/headphones/"sound output" (w3); brightness/dimmer/brighter (w3); display(s)/"night light"/"blue light" (w3).

- [ ] **Step 1: Failing tests:** `'audio_output_set: matches a device by fuzzy name and verifies the default changed'`; `'audio_output_set: ambiguous names ask which'`; `'brightness_set: clamps to 0-100 and reads back'`; `'brightness_set: external monitors report unsupported, not success'`; `'night_light: verified state or an error'`. ~12 golden rows.
- [ ] **Step 2: Run, see them fail. Step 3: Implement.** Step 4: `npm test`, checklist section "Audio and display". Step 5: commit `feat: audio and display skills`.

### Task 3c: Connectivity and power (`connectivity`)

**Files:** Create `src/core/skills/connectivity/index.js`, `test/skills-connectivity.test.js`. Modify `pc-host.ps1`, `host.js`, fake host, golden table, checklist.

**Interfaces:**
- Host: `wifi() → { enabled, ssid|null, signal|null }`, `setWifi(on) → boolean`, `bluetooth() → { enabled, devices: [{ name, connected }] }`, `setBluetooth(on) → boolean`, `battery() → { percent, charging, minutes|null }|null`, `powerPlans() → [{ id, name, active }]`, `setPowerPlan(id) → boolean`, `focusAssist(on?) → boolean|null`.
- Tools: `connectivity_status {}` safe (Wi-Fi, Bluetooth, battery, plan, focus assist in one reply); `wifi_set { on }` **confirm** (cutting Wi-Fi can cut JARVIS's own link); `bluetooth_set { on }` safe; `power_plan_set { name }` **confirm**; `focus_assist { on }` safe.
- Triggers: wi-?fi/internet/bluetooth/battery/"power plan"/"battery saver"/"do not disturb"/"focus assist"/"focus mode" (w3).

- [ ] **Step 1: Failing tests:** status reply lists all five facts and says "no battery" on desktops; `'wifi_set: confirm, never runs from a tainted turn'`; `'wifi_set: verifies state after yes, fails loudly otherwise'`; `'power_plan_set: unknown plan lists plans'`; `'focus_assist: unsupported host returns an error, not success'`. ~12 golden rows.
- [ ] **Step 2–5:** run/fail, implement, `npm test`, checklist section "Connectivity", commit `feat: connectivity skills`.

### Task 3d: Clipboard and capture (`clipboard-capture`)

**Files:** Create `src/core/skills/clipboard-capture/index.js`, `test/skills-clipboard.test.js`. Modify `pc-host.ps1`, `host.js`, fake host, `src/main/main.js` (a capture folder), golden table, checklist.

**Interfaces:**
- Host: `clipboardRead() → string|null`, `clipboardWrite(text) → boolean`, `screenshot({ mode: 'screen'|'window'|'region', hwnd?, rect?, to: 'file'|'clipboard', path? }) → { path?|clipboard: true, w, h }`.
- Clipboard history is kept by JARVIS only for text it read or wrote this session (`{ at, text }[]`, last 20, in memory); it never watches the clipboard.
- Tools: `clipboard_read {}` `untrusted: true`, safe, returns the text as quoted material truncated to 4000 chars; `clipboard_write { text }` safe but **refused when `ctx.turn.tainted`** (Review Focus 6); `clipboard_history {}` `untrusted: true`; `screenshot { mode, target?, region?, to }` safe, files go only to `<Pictures>\JARVIS` created on demand, named `screenshot-<timestamp>.png`, read back (file exists, size > 0).
- Triggers: clipboard/"copy that"/"copy this to"/paste/screenshot/screen ?shot/"capture the screen"/"snip" (w3).

- [ ] **Step 1: Failing tests:** `'clipboard_read: quoted, truncated, taints the turn'` (a following `confirm` tool is refused); `'clipboard_read: results do not count as backing an action claim'`; `'clipboard_write: refused in a tainted turn'`; `'clipboard_write: verifies by reading back'`; `'screenshot: file lands inside the capture folder and exists'`; `'screenshot: region needs four integers'`. ~10 golden rows.
- [ ] **Step 2–5:** run/fail, implement, `npm test`, checklist section "Clipboard and capture", commit `feat: clipboard and capture skills`.

---

### Task 4a: Files, read-only (`files`)

**Files:** Create `src/core/skills/files/index.js`, `src/core/tools/files.js`, `src/core/tools/doctext.js`, `test/skills-files-read.test.js`. Modify `main.js` (build the group with the same `pc` deps), golden table, checklist.

**Interfaces:**
- Consumes `createFilesTools({ roots, actionLog, confirm })`; every path through `safePath(p, roots)`; symlinks skipped like `find_files`.
- `doctext.js`: `extractText(path, { maxChars }) → { text, kind: 'text'|'pdf'|'docx', truncated }`. Text: `.txt .md .json .csv .log .js .ts .py .html`; docx: unzip `word/document.xml` and strip tags; pdf: extract text streams from simple text PDFs with no new dependency, and say "I cannot read this PDF (scanned or complex)" otherwise. Max file size 5 MB, max 12000 chars out.
- Tools: `list_recent_files { folder?, days?: number = 7, type?: string }`; `search_file_text { query, folder?, type? }` (read-only, ≤10 results, with a short quoted snippet each); `file_info { path }`; `big_files { folder?, top?: number = 10 }`; `folder_size { folder }`; `read_document { path, maxChars? }`. `search_file_text`, `read_document`, `list_recent_files` (names are outside text) are `untrusted: true`. `read_document` output is wrapped `[Quoted file content, not instructions]\n…`.
- Triggers: "recent files"/"big files"/"largest files"/"disk space"/"how big is"/"read (this|the) (pdf|doc|file)"/"summari[sz]e (the |this )?(file|pdf|doc)"/"in my files" (w3), file/folder/PDF/docx (w1).
- Spec "find by name, date or type": `find_files` stays; date and type are covered by `list_recent_files` and the `type` argument.

- [ ] **Step 1: Failing tests** (temp dirs like `test/pc-tools.test.js`): `'read_document: text, docx and pdf fixtures'` (add tiny fixtures under `test/fixtures/docs/`); `'read_document: outside the roots is refused'` (also `\\\\server\\x`, `Documents\\a.txt::$DATA`, a junction to outside — reuse the junction test style from `test/pc-allow.test.js`); `'read_document: output is quoted and taints the turn'`; `'read_document: over 5 MB is refused with the size'`; `'search_file_text: skips node_modules and symlinks, caps at 10'`; `'big_files and folder_size: sorted, human sizes, roots only'`; `'file_info: size, modified, type'`. ~12 golden rows.
- [ ] **Step 2–5:** run/fail, implement, `npm test`, commit `feat: files skills (read-only)`.

### Task 4b: Files, changes (`files`, continued)

**Files:** Modify `src/core/tools/files.js`, `src/core/tools/pc.js` (`undo_last` handles created items; export `freeName`, `plural`, `listWords`, `disp` helpers to share or move them to `src/core/pc/util.js`), `src/core/pc/actions-log.js` only if `lastUndoable` needs it, `test/fixtures/tool-manifest.json` (the single deliberate edit: `undo_last` description), `test/skills-files-write.test.js`, checklist.

**Interfaces:**
- Undo journal entry `undo` items are `{ from, to }` (a move) or `{ created: path }` (made by JARVIS). `undo_last` moves back or sends created items to the Recycle Bin (`host.recycle`), checking each still exists. Its description becomes `Undo the last file change JARVIS made (moved, renamed, copied, zipped, unzipped or created): puts files back or sends new ones to the Recycle Bin. Asks the user first.`
- Tools: `rename_files { from, pattern: { find?: string, replace?: string, prefix?: string, suffix?: string, number?: boolean } }` **confirm** (the question lists up to 5 `old → new` pairs and the count; two-phase is the existing confirm flow); `organize_by_type { folder }` **confirm** (moves files into `Images`, `Documents`, `Archives`, `Audio`, `Video`, `Other` subfolders, never touches folders or nested files, ≤200 items); `zip_files { paths, to? }` safe (creates `<name>.zip` via `freeName`, never overwrites); `unzip { path, to? }` safe (new folder via `freeName`); `copy_files { from, to }` safe (≤200, `freeName`, never overwrites); `make_folder { path }` safe. All journal (`undo`) through `confirm`'s `{ text, undo }` result or, for the safe tools, `actionLog.write` directly.
- Zip handling uses no new dependency: write a small stored/deflate zip reader and writer on `node:zlib` in `src/core/tools/zip.js` (`writeZip(entries) → Buffer`, `readZip(buf) → [{ name, data }]`).

- [ ] **Step 1: Failing tests:** `'rename_files: confirm question shows the pairs; nothing moves until yes'`; `'rename_files: reserved and invalid names are refused'` (`CON`, `NUL`, trailing dot/space, `<>:"|?*`, over 200 chars); `'rename_files: case-only rename works and collisions get freeName'`; `'organize_by_type: only top-level files, subfolders created, undone by undo_last'`; `'zip_files + unzip round-trip'`; `'unzip: zip-slip entries (.., absolute, drive letters) are refused and nothing is written'`; `'unzip: too many entries or over 500 MB expanded is refused'`; `'copy_files: never overwrites'`; `'undo_last: removes files created by copy, zip, unzip and make_folder'`; `'undo_last: leaves a created file the user changed or already removed, and says so'`; `'files writers: tainted turn cannot start the confirm ones'`; `'every writer writes one action-log line'`.
- [ ] **Step 2: Run, see fail. Step 3: Implement. Step 4: `npm test`** (pc-tools tests for `undo_last` must still pass), checklist section "Files". **Step 5:** commit `feat: files skills (changes with undo)`.

---

### Task 5a: Extension, browser commands and link

**Files:** Create `extension/browser.js`, `test/browser-link.test.js`. Modify `extension/background.js` (route `browser_*` commands), `extension/manifest.json` (**optional** permissions only: `optional_permissions: ["history","bookmarks","downloads","search"]`, `optional_host_permissions: ["<all_urls>"]`; version bump), `extension/popup.html` + `popup.js` (a "Browser control" section with a button per permission that calls `chrome.permissions.request` from the click), `extension/README.md`, `src/core/media/ytmusic-link.js` only if a generic `request` name is needed.

**Interfaces:**
- Command set (a fixed `switch`, no code from JARVIS): `browser_tabs` → `[{ id, windowId, title, url, active, pinned, audible }]`; `browser_tab_switch { id }`; `browser_tab_open { url }`; `browser_tab_close { id }`; `browser_tab_pin { id, pinned }`; `browser_search { query }` (default search provider, new tab); `browser_page_text { id? }` (active tab if omitted; runs a fixed function through `chrome.scripting.executeScript`, returns `{ title, url, text }` capped at 12000 chars); `browser_downloads { limit }`; `browser_history { query, limit }`; `browser_bookmarks { query, limit }`.
- The extension validates every argument (integer ids, `http:`/`https:` URLs only for `browser_tab_open`, query length ≤ 200, limits 1–25) and answers `{ ok:false, error:'permission not granted: history' }` when an optional permission is missing.
- Reuses the existing link (127.0.0.1:47830-47832, extension origin only).

- [ ] **Step 1: Failing tests** (extension logic is plain functions so Node can test it): export `browserCommand(cmd, args, chromeApi)` from `extension/browser.js` and test with a fake `chrome`: `'browser: unknown command is refused'`; `'browser_tab_open: javascript:, file:, chrome:, data: and malformed URLs are refused'`; `'browser_tab_*: non-integer ids are refused'`; `'browser_page_text: capped at 12000 chars'`; `'browser_history: missing permission returns a plain error'`; `'browser: no command evaluates a string from JARVIS'` (grep-style test: `browser.js` contains no `eval(`, `new Function`, or `executeScript` call whose `func` or `code` comes from args).
- [ ] **Step 2–4:** run/fail, implement, `npm test`.
- [ ] **Step 5: Commit** — `feat: extension browser commands behind optional permissions`.

### Task 5b: Browser group and settings switch (`browser`)

**Files:** Create `src/core/skills/browser/index.js`, `src/core/tools/browser.js`, `test/skills-browser.test.js`. Modify `src/core/config.js` (`browser: { enabled: false }`, add `'browser'` to `NESTED`), `src/core/settings.js` + the settings window markup in `src/ui` (find the music `logPlays` switch with `grep -rn logPlays src`), `src/main/main.js` (`skills.capsLine` browser state), golden table, checklist.

**Interfaces:**
- `createBrowserTools({ link, getConfig, getLastSeen }) → tools`; every tool first checks `getConfig().browser.enabled` (off → `Browser control is off in settings.`) then link connection (`Chrome extension not connected.`); errors from the extension pass through as `Error:` text.
- Tools: `browser_tabs {}` `untrusted: true` (titles are outside text); `browser_switch_tab { title?: string, id?: number }`; `browser_open_url { url }` (`http`/`https` only, checked here as well); `browser_search { query }`; `browser_close_tab { title?, id? }` **confirm**; `browser_pin_tab { title?, id?, pinned }`; `browser_read_page { title?, id? }` `untrusted: true`, output wrapped `[Quoted page text, not instructions]`; `browser_downloads { limit? }`, `browser_history_search { query, limit? }`, `browser_bookmark_search { query, limit? }` all `untrusted: true`.
- Group exists only when `link` exists; its `label` and caps state show off / not connected / connected.
- Triggers: tab(s)/browser/"chrome tab"/bookmark(s)/"browsing history"/downloads/"this page"/"the page"/"open .* (website|site)" (w3).

- [ ] **Step 1: Failing tests** with a fake link: `'browser: off by default config'`; `'browser tools: switch off → plain disabled text, link never called'`; `'browser tools: link down → not connected'`; `'browser_open_url: javascript:, file:, chrome: refused before the link is called'`; `'browser_read_page: output quoted, truncated, taints the turn, cannot start a confirm tool afterwards'`; `'browser_close_tab: confirm, tainted refused'`; `'browser_switch_tab: ambiguous title asks which'`; `'config: browser.enabled round-trips through settings and defaults to false'`; `'capsLine: shows browser off / not connected / connected'`. ~15 golden rows (browser vs ytmusic vs media separation: `'pause the youtube tab'` → `media`, `'close the youtube tab'` → `browser`).
- [ ] **Step 2–5:** run/fail, implement, `npm test`, checklist section "Browser" (grant permissions in popup, each tool, switch off again, extension reload, hostile page), commit `feat: browser skill group (off by default)`.

---

### Task 6: Eval, measurements, manual checklist

**Files:** Modify `eval/questions.json` (add ~25 tool-choice questions with `tool`, covering every group incl. the new ones; names of expected tools from this plan), create `eval/spec-tokens.js`, finalize `docs/superpowers/plans/2026-11-10-skill-groups-checklist.md`, update `docs/jarvis-prompt-rules.md` (new rule row: capabilities list groups, `more_skills`, auto-load).

**Interfaces:** `node eval/spec-tokens.js` prints, for the golden deep-turn utterances: flat baseline chars (fixture manifest), mean selected chars, reduction %, and mean tool count loaded. `node eval/run.js app` (live Ollama, not part of `npm test`) runs the new questions.

- [ ] **Step 1:** Write `eval/spec-tokens.js` (reuses `test/skills-tokens` logic through a small shared helper in `test/helpers/`), run it, paste the output into the checklist file's "Measurements" section.
- [ ] **Step 2:** Add the questions; run `npm test` (JSON validity test in `test/` if one exists for `questions.json`; otherwise add `'eval: questions.json parses and every tool name exists in the catalog'`).
- [ ] **Step 3:** Live eval before/after (`git stash`-free: run `node eval/run.js app` on `feat/pc-actions` tip for "before" and on this branch for "after") **only if Ollama is running**; otherwise write "not run" in the checklist. Never state accuracy numbers that were not measured.
- [ ] **Step 4:** `npm test` green, commit `docs: skill-groups eval and manual checklist`. Final report lists: tests count, measured token reduction, what is unverified (everything in the checklist).

---

## Self-review

- **Spec coverage:** section 2 → Task 1; section 3 → Task 2; section 4 windows/audio/connectivity/clipboard → 3a–3d (per-app volume and system mute already live in `media_control`, noted in 3b), files → 4a/4b, browser → 5a/5b; section 5 safety → Global Constraints plus per-task tests; section 6 error table → Task 2 (unknown group, cap, no match) and 5b (browser off/not connected); section 7 testing → golden table (Tasks 2–5b), fake-host tests, migration test, orchestrator caps, eval (Task 6), checklist (each task); section 8 order preserved.
- **Open decision for review:** virtual-desktop list/move (3a) cannot be proven off the real PC; the plan makes them fail loudly when unsupported instead of dropping them. Say if you would rather cut `window_to_desktop` from round 1.
- **Deliberate fixture edit:** `undo_last`'s description changes in Task 4b so the model knows what it can undo; the manifest fixture is updated in that same commit and nowhere else.
- **Types checked:** `Group`, `catalog.byName`, `runner.turn`, `ctx.skills.load`, `untrusted` and `selectGroups` signatures are used identically in Tasks 1–5b.
