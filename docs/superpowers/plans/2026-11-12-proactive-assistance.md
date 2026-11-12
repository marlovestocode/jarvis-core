# Proactive Contextual Assistance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two opt-in proactive monitors (upcoming timers, system thresholds) on top of the existing proactive engine, with cooldown, hourly cap, confirm-hold, a settings section and a voice tool.

**Architecture:** A monitor registry (`monitors.js`) ticks every 30 s, takes one `live.snapshot()`, runs each enabled monitor and feeds results to `engine.push`. The engine stays the only delivery gate and gains additive cooldown, hourly cap and an `isBusy` hook. Config and voice both write through the existing settings patch path.

**Tech Stack:** Node (CommonJS), `node:test` (`npm test` = `node --test "test/**/*.test.js"`), Electron main process wiring in `src/main/main.js`.

**Spec:** `docs/superpowers/specs/2026-11-12-proactive-assistance-design.md`

## Global Constraints

- Commit **only files you create** and tracked files that are currently clean. These are already modified with the user's uncommitted work and must be edited in the working tree but **never staged or committed**: `src/core/config.js`, `src/core/settings.js`, `src/core/skills/index.js`, `src/main/main.js`, `src/ui/settings.html`, `src/ui/settings.js`, `test/helpers/tool-deps.js`. Use `git add <explicit new paths>` and `git commit -m ... -- <explicit paths>`; never `git add -A`, `.` or `-a`. Do not touch `eval/questions.json`.
- Clean tracked files you may commit: `src/core/proactive/engine.js`, `test/proactive.test.js`, `src/core/livestate/index.js`.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Defaults, all off: `proactive.monitors = { timersSoon: { enabled: false, leadMin: 10 }, sysmon: { enabled: false, cpu: 90, ram: 90, disk: 95, temp: 85 } }`, `proactive.cooldownMin = 15`, `proactive.maxPerHour = 6`.
- Clamps: `leadMin` 1–120; `cpu`/`ram`/`disk` 1–100; `temp` 30–110; `cooldownMin` 1–240; `maxPerHour` 1–60. Unknown keys ignored.
- Tick every 30 s. sysmon stats cached 30 s. sysmon hysteresis 5 points; per-metric cooldown 15 min. Max 5 `timers.upcoming`.
- Monitors only return text. No tool access, no actions.
- Existing timer speech and the existing `test/proactive.test.js` cases stay unchanged and green.
- Refinement of the spec, stated once: the cooldown and hourly cap apply to monitor items only (`push({ monitor: true })`). User-set timers, alarms and reminders are never capped or cooled down. The 30 s tick always re-arms but does nothing (no snapshot, no sysmon call) when no monitor is enabled.

## Review Focus

- A proactive line arrives while the user is speaking (`listening`/`speaking`): it is held, then delivered on idle (Task 1, 7).
- A confirm is pending (user was just asked "say yes"): nothing is spoken until it clears or expires (Task 1).
- A timer already past due, or created inside the lead window, is announced at most once and an overdue one never gets "is in -3 minutes" (Task 4).
- Sysmon is not running or returns junk: no speech, no error spam, one log line (Task 4).
- `config.json` has missing, malformed or out-of-range `monitors`: defaults or clamped values, never a crash (Task 2).

---

### Task 1: Engine cooldown, hourly cap, isBusy

**Files:**
- Modify: `src/core/proactive/engine.js`
- Test: `test/proactive.test.js` (append; reuse its `setup`, `advance`, `at`, `fire` helpers)

**Interfaces:**
- Consumes: existing `createProactiveEngine` options and `push`.
- Produces: `createProactiveEngine({ ..., isBusy = () => false })`; `push({ kind, text, key, monitor = false, cooldownMs })`. Config read from `getConfig().proactive`: `cooldownMin` (default 15 when absent) and `maxPerHour` (default 6 when absent).

- [ ] **Step 1: Write failing tests** (append to `test/proactive.test.js`; `setup` gains an `isBusy` option passed through to the engine, default none):
  - `monitor item: same key within cooldown is dropped, spoken again after cooldown` (push `{monitor:true,key:'k'}`, deliver, push again at +5 min → still 1 spoken; at +16 min → 2).
  - `monitor item: cooldownMs on the item overrides config` (`cooldownMs: 60000`, second push at +2 min is spoken).
  - `non-monitor items ignore cooldown and cap` (timer events with different ids, 8 of them spaced beyond minGap: all 8 spoken).
  - `hourly cap: items over maxPerHour are notification only, history still recorded` (`cfg: { maxPerHour: 2 }`, 3 distinct monitor keys spaced 11 s apart: spoken 2, third appears as `notify` + `history` call only; after 61 min the next monitor item is spoken).
  - `isBusy true holds speech, delivered once it turns false` (`isBusy` toggled by a variable; push → nothing spoken; set false, `advance(3000)` → spoken once).
  - `isBusy throwing counts as not busy`.
- [ ] **Step 2: Run** `node --test test/proactive.test.js` → the new tests FAIL, old ones pass.
- [ ] **Step 3: Implement in `engine.js`:**
  - `busy` stays the state-event flag; add `const held = () => busy || safeIsBusy()` where `safeIsBusy` wraps `isBusy()` in try/catch (false on throw). `pump` and `deliver` use `held()`.
  - In `pump`, when `held()` is true because of `isBusy()` and not `busy`, arm the existing `wait` timer with a 2000 ms retry (idle state events will not fire for a cleared confirm).
  - `push`: normalize `monitor` and `cooldownMs`. For monitor items past the silent check: drop if `delivered.get(key)` is within `cooldownMs ?? cfg.cooldownMin*60000` (a `Map<key, timestamp>` set in `deliver`). If monitor and spoken count in the last hour (array of timestamps pruned at 3.6e6 ms) is `>= maxPerHour`, call `record(item)` and return (notification only).
  - Spoken count increments in `deliver` only for monitor items, only when `speak` returned `true`.
  - Update the header comment with the new rules in one or two lines.
- [ ] **Step 4: Run** `node --test test/proactive.test.js` → all PASS.
- [ ] **Step 5: Commit**

```bash
git add test/proactive.test.js src/core/proactive/engine.js
git commit -m "feat(proactive): cooldown, hourly cap and busy hook for monitor items" -- test/proactive.test.js src/core/proactive/engine.js
```

### Task 2: Monitor config, defaults and settings patch

**Files:**
- Create: `src/core/proactive/monitor-config.js`, `test/monitor-config.test.js`
- Modify (working tree only, never staged): `src/core/config.js`, `src/core/settings.js`

**Interfaces:**
- Produces: `DEFAULT_MONITORS` (frozen, nested frozen; the exact defaults above), `cleanMonitors(raw) → monitors` (always a complete valid object; bad or missing fields fall back to defaults; numbers rounded and clamped), `patchMonitors(current, patch) → { monitors, errors: string[] }` (only known monitors and fields applied; non-finite numbers add an error and are skipped; `enabled` coerced to boolean), `clampNumber(n, min, max)`.

- [ ] **Step 1: Write failing tests** in `test/monitor-config.test.js`: `cleanMonitors(undefined)` deep-equals defaults; `cleanMonitors({ sysmon: { ram: 500, cpu: 'x', temp: 5 } })` gives `ram:100`, `cpu:90`, `temp:30`; `cleanMonitors('junk')` equals defaults; `patchMonitors(defaults, { timersSoon: { enabled: 1, leadMin: 0 }, bogus: {} })` gives `enabled:true`, `leadMin:1`, no `bogus` key; `patchMonitors(defaults, { sysmon: { ram: 'abc' } })` returns one error and leaves `ram` 90; result objects are fresh copies (mutating them does not change `DEFAULT_MONITORS`). Also `applyPatch` cases in `test/settings.test.js` are **not** edited (user-modified area); instead add the settings checks here by calling `applyPatch(DEFAULTS-based current, { proactive: { monitors: {...}, cooldownMin: 999, maxPerHour: 0 } }, { providers, engines })` using the same stubs `test/settings.test.js` uses: expect `cooldownMin` 240, `maxPerHour` 1, `monitors` patched, and the input `current.proactive.monitors` unmutated.
- [ ] **Step 2: Run** `node --test test/monitor-config.test.js` → FAIL (module missing).
- [ ] **Step 3: Implement** `monitor-config.js` as described (pure, no I/O).
- [ ] **Step 4: Wire (working tree only):**
  - `config.js`: add `monitors: DEFAULT_MONITORS`, `cooldownMin: 15`, `maxPerHour: 6` to the frozen `DEFAULTS.proactive`. In `merge()`'s `key === 'proactive'` block set `out.proactive.monitors = cleanMonitors(raw?.proactive?.monitors)` and clamp `cooldownMin`/`maxPerHour` via `clampNumber` (the generic number branch already copies finite numbers).
  - `settings.js` `applyPatch`: copy `monitors` when cloning `proactive` (`proactive: { ...current.proactive, monitors: cleanMonitors(current.proactive.monitors) }`), and inside the `isObj(patch.proactive)` block add `monitors` via `patchMonitors` (push its errors) and clamped `cooldownMin`, `maxPerHour` following the `minGapSec` pattern.
- [ ] **Step 5: Run** `node --test test/monitor-config.test.js test/settings.test.js test/config.test.js` (skip any that do not exist) → PASS.
- [ ] **Step 6: Commit new files only**

```bash
git add src/core/proactive/monitor-config.js test/monitor-config.test.js
git commit -m "feat(proactive): monitor config defaults, clamping and patch helper" -- src/core/proactive/monitor-config.js test/monitor-config.test.js
```

### Task 3: Live-state `timers.upcoming`

**Files:**
- Create: `src/core/livestate/sources.js`, `test/livestate-sources.test.js`
- Modify (working tree only): `src/main/main.js` (the `ctx.live.register('timers', ...)` line, ~304)

**Interfaces:**
- Produces: `timersSource({ list, now = Date.now }) → () => null | { count, nextInMs, upcoming }` where `list()` returns timers sorted by due; `upcoming` is up to 5 `{ id, label, kind, due }` with `due > now()`, soonest first; `count` and `nextInMs` behave as today (`nextInMs = max(0, min due - now)`); empty list → `null`.

- [ ] **Step 1: Write failing tests:** empty → `null`; 7 timers → `count` 7, `upcoming` length 5 and ordered; an overdue timer is counted but not in `upcoming`; `nextInMs` matches the old formula; output objects hold only `id,label,kind,due`; a throwing `list` propagates (livestate already catches it).
- [ ] **Step 2: Run** `node --test test/livestate-sources.test.js` → FAIL.
- [ ] **Step 3: Implement** `sources.js`; replace the inline `timers` registration in `main.js` with `ctx.live.register('timers', timersSource({ list: () => ctx.scheduler?.list?.() || [] }))`.
- [ ] **Step 4: Run** `node --test test/livestate*.test.js` → PASS.
- [ ] **Step 5: Commit** `git add src/core/livestate/sources.js test/livestate-sources.test.js` then commit with explicit paths.

### Task 4: Monitor runner and the two monitors

**Files:**
- Create: `src/core/proactive/monitors.js`, `src/core/proactive/monitors/timers-soon.js`, `src/core/proactive/monitors/sysmon-threshold.js`, `test/proactive-monitors.test.js`

**Interfaces:**
- Consumes: `engine.push({ kind, text, key, monitor: true, cooldownMs? })` (Task 1); `snap.timers.upcoming` (Task 3); `getConfig().proactive.monitors` (Task 2).
- Produces:
  - Monitor module shape: `{ id, enabled(cfg) → boolean, check(snap, cfg, state, now) → item | null | Promise<item | null> }` where `cfg` is `getConfig().proactive.monitors` and `item = { kind, text, key, cooldownMs? }`.
  - `timersSoon` (id `timersSoon`): for the first upcoming timer with `0 < due - now <= leadMin*60000` not yet in `state.told` (a Set of ids), mark it told and return `{ kind: timer.kind === 'timer' ? 'timer' : timer.kind, text: 'Your <label> <kind> is in N minute(s).', key: 'soon:<id>' }` with `N = ceil(ms/60000)` and singular "minute" for 1; omit the label when empty. One item per tick; the next timer is returned on the next tick. `state.told` ids are pruned when no longer upcoming.
  - `createSysmonMonitor({ getStats })` (id `sysmon`): `getStats()` resolves `{ cpu, ram, disk, temp }` as numbers or null (cpu = `cpu.load`, ram = `mem.pct`, disk = max of `disk.volumes[].pct`, temp = max of `cpu.temp`, `gpu.temp`). For each metric with a limit: fire when value `>= limit`, `state[metric].armed !== false`, and `now - lastAt >= 15 min`; then set `armed=false`, `lastAt=now`; re-arm when value `<= limit - 5`. Text `'<RAM|CPU|Disk|Temperature> is at 93%, over your 90% limit.'` (temperature uses `°C`). Key `sysmon:<metric>`, `cooldownMs: 15*60000`, kind `info`. At most one item per tick (highest overage first). `getStats` rejecting → returns `null`, logs once per failure streak.
  - `createSysmonStats({ fetch, timeoutMs = 3000, now })` in the same file: fetches `${SYSMON}/snapshot` (from `../../net/services`), returns the normalized stats above, caches for 30 s, returns `null` on any failure or missing `t`.
  - `createMonitors({ engine, live, getConfig, monitors, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = 30000, log = () => {} }) → { start, stop, tick }`: `tick()` is async, returns without work if already running or if no monitor `enabled`; otherwise one `live.snapshot()`, then each enabled monitor's `check` inside try/catch (log once per monitor id on throw), `engine.push({ ...item, monitor: true })` for each returned item. `start()` arms a repeating timer that always re-arms; `stop()` clears it.

- [ ] **Step 1: Write failing tests** (`test/proactive-monitors.test.js`, fake timers via injected `setTimer`, fake engine `{ push: item => pushed.push(item) }`, fake `live.snapshot`):
  - tick with nothing enabled: `snapshot` never called, no pushes.
  - `timersSoon`: timer due in 9 min, lead 10 → one push `Your pasta timer is in 9 minutes.` key `soon:t1`; second tick → no repeat; due in 1 min → `in 1 minute`; due in 11 min → nothing; overdue (`due <= now`) → nothing; two timers in window → one per tick; a timer created with 2 min left is announced once; unlabeled reminder → `Your reminder is in 5 minutes.`
  - `sysmon`: ram 93 vs limit 90 → push once; next tick still 93 → none (disarmed); drops to 84 then 93 within 15 min → none (cooldown); after 15 min and re-arm → push again; value 86 (within 5) does not re-arm; metric null → skipped; cpu and ram both over → one item per tick, larger overage first; `getStats` rejecting → no push, one log line over three ticks.
  - `createSysmonStats`: normalizes a sample snapshot (`cpu.load`, `mem.pct`, two volumes, `cpu.temp`/`gpu.temp`); second call within 30 s does not refetch; non-ok response or throw → `null`.
  - runner: a monitor that throws is skipped, others still run, one log; ticks never overlap (a slow `check` plus a second `tick()` call runs `check` once); `stop()` clears the timer.
- [ ] **Step 2: Run** `node --test test/proactive-monitors.test.js` → FAIL.
- [ ] **Step 3: Implement the three files** per the Interfaces above.
- [ ] **Step 4: Run** `node --test test/proactive-monitors.test.js test/proactive.test.js` → PASS.
- [ ] **Step 5: Commit** `git add src/core/proactive/monitors.js src/core/proactive/monitors test/proactive-monitors.test.js` and commit with the same explicit paths.

### Task 5: `monitor_set` tool and skill group

**Files:**
- Create: `src/core/tools/monitors.js`, `src/core/skills/monitors/index.js`, `test/tools-monitors.test.js`
- Modify (working tree only): `src/core/skills/index.js` (add `'monitors'` to `ORDER`, after `'timers'`), `test/helpers/tool-deps.js` (add `applySettings: () => []` and keep `getConfig`), `src/main/main.js` (add `applySettings` to the `defaultCatalog({...})` deps, line ~283)

**Interfaces:**
- Consumes: `patchMonitors` and `DEFAULT_MONITORS` (Task 2).
- Produces:
  - `createMonitorTools({ getConfig, applySettings }) → Tool[]` with one tool `monitor_set`. `applySettings(patch) → string[]` applies `{ proactive: {...} }` through `applyPatch` + `saveConfig` and returns its `errors`.
  - Params: `{ monitor: enum ['timers','system'], enabled?: boolean, limit?: number, metric?: enum ['cpu','ram','disk','temp'], leadMin?: number }`. Mapping: `timers` → `timersSoon` (`leadMin`); `system` → `sysmon` (`limit` applies to `metric`, required when `limit` is given). Result is a sentence, `direct: true`: `Upcoming-timer heads-ups are on, 10 minutes ahead.` / `RAM warnings are on at 90%.` / `System warnings are off.` Unknown monitor or no change requested → throws a helpful error. If `applySettings` returns errors, throw the first. Include `hint`, `examples`, `description` (>= 20 chars), `params.type: 'object'` as the registry test requires; the hint names `monitor_set`.
  - Group `monitors`: `{ id: 'monitors', label: 'Proactive warnings (heads-ups about timers, RAM, CPU, disk)', triggers: [...], tools }`. Triggers: regex `/\b(?:warn|alert|notify|tell|let) me (?:when|if|before|ahead)\b/i`, `/\bstop (?:warning|alerting|notifying) me\b/i`, words `['proactive','monitor','monitors']`. `createGroup` returns the group with empty tools when `applySettings` is absent (so it counts as missing, like `timers`).

- [ ] **Step 1: Write failing tests:** enabling timers with `leadMin: 15` calls `applySettings({ proactive: { monitors: { timersSoon: { enabled: true, leadMin: 15 } } } })` and replies with the sentence; `{ monitor: 'system', metric: 'ram', limit: 85 }` sets `ram:85` and enables sysmon; `{ monitor: 'system', enabled: false }` disables; `limit` without `metric` throws; unknown monitor throws; no-op request throws; `applySettings` returning `['Bad ...']` throws that message; the group loads with the `toolDeps()` helper (`loadGroups(toolDeps()).missing` is empty); resulting tool passes the existing `test/tool-registry-consistency.test.js`.
- [ ] **Step 2: Run** `node --test test/tools-monitors.test.js` → FAIL.
- [ ] **Step 3: Implement** the tool, group and the three wiring edits; in `main.js` define `applySettings` next to `ctx.saveConfig` usage: call `applyPatch(ctx.config, patch, { providers: ctx.providers, engines: ctx.engines })`, `ctx.saveConfig(config)`, return `errors` (import `applyPatch` from `../core/settings` if not already imported there).
- [ ] **Step 4: Run** `node --test test/tools-monitors.test.js test/tool-registry-consistency.test.js test/skills-*.test.js test/prompt-tools.test.js` → PASS. If an existing test hard-codes the group count or id list, update that expectation (it is a deliberate new group), and say so in the report.
- [ ] **Step 5: Commit new files only:**

```bash
git add src/core/tools/monitors.js src/core/skills/monitors/index.js test/tools-monitors.test.js
git commit -m "feat(proactive): monitor_set voice tool and monitors skill group" -- src/core/tools/monitors.js src/core/skills/monitors/index.js test/tools-monitors.test.js
```

### Task 6: Settings UI section

**Files:**
- Modify (working tree only): `src/ui/settings.html`, `src/ui/settings.js`

**Interfaces:**
- Consumes: `c.proactive.monitors` from `settings:get`; saves through `save({ proactive: { monitors } })` (existing handler, validated by Task 2).

- [ ] **Step 1: Add markup** after the quiet-hours hint in `settings.html`: a "Heads-ups (off by default)" group with a checkbox `monTimers` and number input `monLead` (1–120, "minutes ahead"); a checkbox `monSys` and number inputs `monCpu`, `monRam`, `monDisk` (1–100, "%") and `monTemp` (30–110, "°C"); one hint line: "JARVIS only speaks these when idle, and never during quiet hours or Do not disturb."
- [ ] **Step 2: Load values** in `settings.js` next to the other `c.proactive` reads, and add `change` listeners that each call `save({ proactive: { monitors: { <monitor>: { <field>: value } } } })` (numbers via `Number`; checkboxes via `.checked`). Re-render from the returned config like the existing controls.
- [ ] **Step 3: Verify:** `node --test` for any settings-UI test that exists (`grep -l settings.html test`); then launch the app (`run` skill or `npm start`), open settings, toggle a monitor and a limit, reopen settings and confirm the values persisted and `config.json` holds them. Report what could not be checked if the app cannot be launched.
- [ ] **Step 4: No commit** (both files hold pre-existing user edits). List them in the final report as left unstaged.

### Task 7: Wire monitors into `main.js`, full verification

**Files:**
- Modify (working tree only): `src/main/main.js`
- Test: `test/proactive-wiring.test.js` (create)

**Interfaces:**
- Consumes: everything above. Produces: running app behavior.

- [ ] **Step 1: Write a failing integration test** (`test/proactive-wiring.test.js`) with a real bus, `createLiveState`, `createProactiveEngine` (with `isBusy` built as in main) and `createMonitors` using fake `now`/`setTimer`: (a) timersSoon enabled, a timer due in 9 min, live voice `speaking` → tick pushes, nothing spoken; emit `state idle` → spoken once; (b) same with a pending-confirm `live.register('confirm', () => ({ summary: 'x' }))` → held until the source returns `null` and the 2 s retry fires; (c) config `proactive.enabled: false` → notification and history only, no speech; (d) `dnd: true` → same.
- [ ] **Step 2: Run** `node --test test/proactive-wiring.test.js` → FAIL until the test's own harness helper is complete; fix only the test harness, not production code, until it expresses the cases.
- [ ] **Step 3: Wire `main.js`:** pass `isBusy: () => { const s = ctx.live.snapshot(); return !!s.confirm || ['listening', 'thinking', 'speaking'].includes(s.voice); }` to `createProactiveEngine`; after the engine is created build `ctx.monitors = createMonitors({ engine: ctx.proactive, live: ctx.live, getConfig: ctx.getConfig, log: ctx.log, monitors: [timersSoon, createSysmonMonitor({ getStats: createSysmonStats({ fetch }) })] })`, call `ctx.monitors.start()` after the scheduler starts, and add `() => ctx.monitors.stop()` to `ctx.onQuit`.
- [ ] **Step 4: Run the full suite** `npm test`. Expected: all pass. Never stash or reset (the working tree holds the user's edits). If a failure looks unrelated to this work, report the failing test name instead of fixing it.
- [ ] **Step 5: Commit** only `test/proactive-wiring.test.js`:

```bash
git add test/proactive-wiring.test.js
git commit -m "test(proactive): wiring of monitors, busy hold and silent modes" -- test/proactive-wiring.test.js
```
- [ ] **Step 6: Final report:** list committed files, list working-tree-only files left unstaged (`src/core/config.js`, `src/core/settings.js`, `src/core/skills/index.js`, `src/main/main.js`, `src/ui/settings.html`, `src/ui/settings.js`, `test/helpers/tool-deps.js`), and what waits on sub-project 3.
