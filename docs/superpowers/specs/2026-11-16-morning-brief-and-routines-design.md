# Morning brief and routines: design

Date: 2026-11-16. Status: draft, waiting for approval.

Two features, built in this order: morning brief (small), routines (medium). They share no code except the fast path, so each ships on its own.

## Why

Both turn many small voice asks into one phrase. The user is stuck on what to build next and chose these because the pieces already exist (tools, task runner, proactive engine). Success: one phrase does what took four, and nothing the user did not expect happens.

Non-goals: calendar sync (no calendar skill exists; "calendar-ish" means timers, alarms and reminders), cloud anything, learning routines from habits (later idea), editing routines by voice step by step.
Anti-goals: a routine that closes an app without a yes; a brief that talks over the user or at night; an undo that claims success when it put nothing back.

## 1. Morning brief

### What it does
- Phrase: "morning brief", "brief me", "what's my day look like". Handled in the fast path, no model.
- First wake of the local day (after quiet hours end) offers it unasked: JARVIS says a short greeting and speaks the brief once. Config `brief.auto` (default on), `brief.onFirstWake`. Never repeats the same day.
- Content, in this order, each part skipped if its tool fails or is empty: greeting + date, weather (`get_weather`), today's timers/alarms/reminders (`list_timers`), news (`news_headlines`, top 3), battery and charging (`connectivity_status`), what is open (`list_windows`, app names only, never titles, which are untrusted text).
- Built from stored tool result text, not model prose. Spoken text passes through the existing speech dialect rules.

### How
- `proactive/engine.js` already has `briefing.set(fn)` and `briefing.run()`. New `src/core/brief/index.js` exports `createBrief({ tools, getConfig, now })` returning the provider function; main.js calls `ctx.proactive.briefing.set(...)`.
- New fast-path skill `src/core/skills/brief` (phrase match, calls the provider directly and returns text as the reply).
- First-wake trigger: on the bus `wake` event, if `lastBriefDate !== today` and not quiet hours and `brief.auto`, call `briefing.run()`. `lastBriefDate` persisted in the settings store.
- Reuses engine rules: held while listening or speaking, DND and quiet hours give a notification only.

### Approaches considered
- A: provider on the existing hook plus fast-path phrase (chosen). Least new code, matches how the engine was built for this.
- B: a task-runner plan the model writes each morning. Slower, can drift, model writes prose. Rejected.
- C: a dedicated brief window. Not asked for. Rejected.

## 2. Routines

### What it does
- A routine is a name plus ordered steps, saved locally. Example "game mode": close Discord and Chrome, focus assist on, volume 40, output "headphones", play a playlist.
- Create by voice: "save routine game mode: ..." is hard to say, so creation is two paths: (a) in settings UI form (name, step picker), (b) "make a routine called game mode" and JARVIS asks the steps one by one. First build ships (a) plus the voice run/undo/list; (b) comes if (a) feels clunky. This is my call.
- Run: "game mode", "run game mode", "start game mode". Undo: "undo game mode" or "undo that routine". List: "what routines do I have".
- Step types (all existing tools): `close_app`, `focus_assist`, `set_system_volume`, `audio_output_set`, `brightness_set`, `power_plan_set`, `night_light`, `bluetooth_set`, `open_app`, `youtube_music` play.

### Close apps rule (user decided)
Close politely (window close, never force kill), one yes per run covering the whole routine, reopen on undo. If an app stays open (asks to save), report it and leave it; do not force. Protected apps stay protected (the existing PROTECTED set).

### Run flow
1. Phrase matches a routine. JARVIS says what it will do in one line ("Game mode: close Discord and Chrome, focus assist on, volume 40, headphones, play Lo-fi. Go?"), through the existing confirm.
2. On yes, steps run through the task runner (saved before and after each step, retry once, stop on failure with a report).
3. Because the single yes already covered closing, routine steps call an internal `routine_close` tool (risk safe, not in the model's tool list, same polite close and PROTECTED check as `close_app`). The model-facing `close_app` stays confirm-per-app.
4. Routines that contain no close step and no confirm tool run without a question (all other steps are risk safe).

### Undo
- Before each step runs, a `snapshot` is saved on the step: volume, default output device, focus assist state, brightness, power plan, night light, bluetooth, apps closed (name plus exe path from the process).
- "Undo" runs the reverse steps in reverse order and reports each: restored, or "could not restore X: reason". Music playback is not undone (it only pauses it; this is stated in the reply).
- Undo works once per run, only for the newest run of that routine, and the snapshot is kept until the next run or 7 days.
- Reopen uses the recorded exe path through `open_app` rules (Start menu apps and the allowlist). An app not reopenable is reported, not guessed.

### Storage and files
- `src/core/routines/store.js`: JSON in the data folder, `{ name, aliases, steps[], lastRun }`. Names matched like skill phrases (lowercase, punctuation stripped).
- `src/core/routines/run.js`: builds a task plan from steps plus snapshots; `undo.js`: reverse plan.
- `src/core/skills/routines`: fast-path phrases, new group `routines`. Added to `ORDER` in `skills/index.js`.
- `src/core/tasks/*` change only by adding an optional `snapshot` hook per step (`step.undo`). Existing tasks behave the same.
- Settings page: routines list and step editor.

### Approaches considered
- A: routines as stored task plans run by the existing runner, undo via per-step snapshots (chosen). Gets persistence, retries, crash safety for free.
- B: routine runner separate from tasks. Duplicates the runner. Rejected.
- C: let the model improvise "game mode" each time. Not repeatable, no undo. Rejected.

## Safety
- Brief reads only; open apps are names only.
- Routine steps are a fixed allowlist; a routine cannot hold `power`, `delete_*`, `lock_screen`, `wifi_set`, or any task tool.
- Routine contents come from the user's own saved list, never from web or file text. A tainted turn cannot run a routine that closes apps.
- Everything logs to the existing action log.

## Tests
- Brief: provider order, skipping a failed part, once per day, quiet hours, fast-path phrases.
- Routines: parse and match phrases, plan build, snapshot saved before each step, undo restores in reverse order, partial failure and undo report, close step blocked on PROTECTED, tainted turn refused.
- Live fixtures through the existing eval harness for the phrases.

## Left to the builder
Exact greeting wording, news count, settings form layout, snapshot field names, migration if the settings schema needs a version bump.
