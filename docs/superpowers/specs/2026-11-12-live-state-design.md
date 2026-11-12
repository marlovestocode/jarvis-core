# Live State + Follow-up Resolver — Design

Date: 2026-11-12
Roadmap items: 1 (Cross-System Contextual Intelligence) and 2 (Unified Live System State), first sub-project.

## Goal

Give every subsystem one shared, in-memory picture of what JARVIS is doing right now, and use it so short follow-ups ("skip it", "undo that", "again", "pause", "yes") resolve without the user repeating themselves and without an extra LLM call.

Success:
- Follow-ups work across music, PC, timers and files with no extra LLM call.
- The prompt carries a compact "Right now" block.
- Full test suite and `eval/run.js` stay green; behavior for non-follow-up requests is unchanged.

## Out of scope

Active-window feed, persistence across restarts (task continuity sub-project), Cortex retrieval using live state, adaptive model choice, any change to Cortex.

## Existing code this builds on

- `src/main/main.js` `promptInfo()` (~line 285): ad hoc per-turn snapshot (media line, hardware, caps, library, memory, user). The media part is replaced by the live block.
- `src/core/bus.js`: typed events (`tool`, `state`, `route`, `turn`) are the event source.
- `src/core/pc/confirm.js` `pending()`, `src/core/timers/scheduler.js`, `media.state()`, orchestrator `lastGroups`: current-value sources.
- `src/core/brain/router.js` `route()` and `src/core/skills/select.js` `selectGroups()`: regex on text only; signatures unchanged.

## Component 1: `src/core/livestate/index.js`

`createLiveState({ bus, now = Date.now })` returns `{ register, snapshot, close }`.

- Event ring, fed by `bus.on('*')`, all bounded:
  - `tools`: last 8 runs `{ name, group, ok, soft, t }`. Never stores args or output text.
  - `route`: last route and model.
  - `turn`: last turn latency.
  - `voice`: from `state` events (idle, thinking, listening, speaking).
- Sources: `register(name, fn)`; `fn` is a sync getter returning a small plain object. A throwing getter is skipped and logged once at warn level; never fatal. Registered in `main.js`: `media` (cached state, no await), `timers` (next due, count), `confirm` (summary, age), `groups` (current chat's `lastGroups`).
- `snapshot()` returns a fresh plain object `{ t, voice, tools, route, turn, media, timers, confirm, groups }`. Tool entries older than 10 min are dropped. Target < 5 ms.
- `liveLine(snap)` renders a 3-6 line "Right now" block for the system prompt; empty string when nothing to say.
- Nothing is persisted. Independent of orchestrator, router and Cortex.

## Component 2: `src/core/livestate/followup.js`

Pure function `resolveFollowUp(text, snap) → { kind, ... } | null`. First match wins:

1. `confirm` pending and text is yes/no → `{ kind: 'confirm' }` (handling stays in `confirm.handle`; this only tags it).
2. Text ≤ 6 words with a pronoun or ellipsis ("it", "that", "again", "undo", "the other one", "same") and a tool run within 3 min → `{ kind: 'continue', group }`.
3. Bare transport word ("pause", "skip", "next", "louder") and `media.playing` → `{ kind: 'media', action }`, routed to the existing media fast-path.
4. Otherwise `null`.

## Wiring

- `orchestrator.js`: optional `live` option. Before `route()`, call `resolveFollowUp`. `continue` seeds `selectGroups` with the group and forces `tools: true` (the `lastGroups` fallback stays). `media` goes to `mediaSkill.handle`. Signatures of `route` and `selectGroups` unchanged.
- `main.js`: create `ctx.live`, register the four sources, pass `live` to the orchestrator, `promptInfo` uses `liveLine(ctx.live.snapshot())` in place of the media line.
- If `live` is absent or throws, behavior equals today's.

## Errors and performance

Every getter and the resolver are wrapped: failure → `null` or a skipped source, logged once at warn level, never a failed turn. Sync getters only; ring bounded (8 tools, ~20 entries total).

## Testing (`test/*.t` style)

- `livestate`: bus events fill the ring; caps and 10-min expiry hold; args and output text are never stored; a throwing source is skipped; `snapshot()` returns a fresh copy.
- `followup`: phrase table against fixture snapshots, including negatives ("play it again" with no recent run; "skip" with nothing playing → `null`).
- `orchestrator`: with `live` absent, behavior identical; with `continue` resolved, group seeded and tools on.
- `eval/questions.json`: about 10 follow-up cases for routing regressions via `eval/run.js`.
