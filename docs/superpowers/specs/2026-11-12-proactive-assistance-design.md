# Proactive Contextual Assistance — Design

Date: 2026-11-12
Roadmap item: 6. Extends `src/core/proactive/engine.js`; does not rebuild it.

## Goal

JARVIS offers help from meaningful context without being asked, stays quiet by default, never repeats itself, never interrupts, and never acts on its own.

Success:
- Two opt-in monitors ship: upcoming timers and system thresholds.
- Every proactive line passes the engine's gates: master switch, DND, quiet hours, busy hold, min gap, dedupe, plus the new cooldown and hourly cap.
- Voice state `listening|thinking|speaking` or a pending confirm holds speech until idle.
- User can enable, tune and disable monitors from the settings page and by voice.
- Existing timer speech and the full test suite stay unchanged and green.

## Out of scope (waits)

- Unfinished-task follow-ups and "you left X half done": need persistent task state (sub-project 3, task continuity, not built).
- Activity suggestions (media idle, tool failure offers) and generic "tell me when X changes" watches.
- Any proactive suggestion that performs an action. If added later it must go through `confirm.propose`, the same confirmation the user would face.
- Persistence of cooldown state across restarts.

## Existing code this builds on

- `src/core/proactive/engine.js`: `push({ kind, text, key })`, priority queue, `minGapSec`, queue dedupe, DND/quiet hours (notification only), busy hold from `state` events, `record` (toast + history).
- `src/core/livestate/index.js`: `snapshot()` (voice, tools, media, timers, confirm). `src/main/main.js` registers the `timers` source.
- `src/core/timers/scheduler.js`, `store.js`: timer list `{ id, kind, label, due }`.
- `src/core/tools/sysmon.js`: `summarize` and the local sysmon fetch.
- `src/core/settings.js` (proactive patch, validated and clamped), `src/ui/settings.html|js`, `src/core/config.js` (`proactive` default, frozen).
- `src/core/pc/confirm.js`: `pending()` for the hold check.

## Component 1: `src/core/proactive/monitors.js`

`createMonitors({ engine, live, getConfig, monitors, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} })` returns `{ start, stop, tick }`.

- A tick runs every 30 s, and only while at least one monitor is enabled (re-evaluated each tick from `getConfig().proactive.monitors`).
- Each tick takes one `live.snapshot()` and calls `monitor.check(snap, cfg, state)` for every enabled monitor. `state` is a per-monitor plain object the tick owns, for hysteresis and cooldown. `check` may be async; one slow monitor never blocks the others and a tick never overlaps itself.
- A returned `{ kind, text, key }` goes to `engine.push`. Nothing else leaves the monitor: no tool access, no actions.
- A throwing monitor is skipped and logged once.

## Component 2: monitor modules, `src/core/proactive/monitors/`

- `timers-soon.js`: for each upcoming timer due within `leadMin` (default 10, not already due), emit `Your <label> <kind> is in <N> minutes`. Key `soon:<id>`: once per timer. A timer created with less than `leadMin` left is announced once on the next tick, never twice.
- `sysmon-threshold.js`: reads stats via an injected `getStats()` (cached 30 s, the sysmon summary source), compares CPU, RAM, disk and temperature to limits. Fires on crossing. Re-arms only after the value falls 5 points below the limit. 15 min cooldown per metric. Missing metric: skipped.
- Live state: `timers` source gains `upcoming: [{ id, label, kind, due }]` (max 5, soonest first). Existing fields (`count`, `nextInMs`) unchanged.

## Component 3: engine additions (additive)

- Per-key cooldown memory: a delivered key is not spoken again within `cooldownMs` (default 15 min, monitors may pass their own). Timer events keep their current behavior.
- Hourly cap on spoken proactive items: `maxPerHour` (default 6). Over the cap the item is notification only, never dropped silently from history.
- Pending-confirm hold: the engine takes an optional `isBusy()`. `main.js` passes `() => live.snapshot().confirm` truthy or a voice state in the busy set. Held items are delivered on the next idle, as today.
- All new options have defaults that leave current timer behavior unchanged.

## Config and settings

`config.proactive.monitors = { timersSoon: { enabled: false, leadMin: 10 }, sysmon: { enabled: false, cpu: 90, ram: 90, disk: 95, temp: 85 } }`, plus `cooldownMin: 15`, `maxPerHour: 6`.

`settings.js` patch: booleans coerced, numbers clamped (leadMin 1–120, limits 1–100 and temp 30–110, cooldownMin 1–240, maxPerHour 1–60), unknown keys ignored. The master `enabled`, `dnd` and quiet hours still apply to monitor output.

## Control surface

- Settings UI: a "Monitors" section in `settings.html|js`: a toggle per monitor, lead minutes, and the four limits; saves via `save({ proactive: { monitors } })`.
- Voice: tool `monitor_set { monitor, enabled?, limit?, leadMin? }`, registered with the tool registry. It writes through the same settings patch path (no second config route), then states what changed. "Stop warning me about RAM" → `enabled:false`.
- Both paths are quiet by default: every monitor starts off.

## Errors and performance

Monitors and the tick are wrapped: failure → skipped and logged once, never a failed turn or a spoken error. The tick does one snapshot and at most one cached sysmon call. When no monitor is enabled the timer is not armed.

## Testing (`test/*.t` style)

- `monitors`: fires once per key; lead time honored; hysteresis and cooldown for sysmon; a throwing monitor is skipped; tick idle when nothing is enabled; no overlap of ticks.
- `engine`: cooldown, hourly cap, pending-confirm hold, existing behavior unchanged (current engine tests untouched).
- `livestate`/main wiring: `timers.upcoming` shape and bounds.
- `settings`: new fields clamped and validated; unknown keys dropped.
- `monitor_set` tool: patches settings, reports the change, rejects unknown monitors.
