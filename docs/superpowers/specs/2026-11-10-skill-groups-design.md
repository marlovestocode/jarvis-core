# JARVIS Skill Groups: Design Spec

Date: 2026-11-10 · Status: design approved in chat, spec awaiting review

## 1. Goal

Give JARVIS many more fine-grained control skills (round 1: Windows and apps, Files and
documents, Browser and web) and make him call them smarter and cheaper: the model sees only the
skills relevant to the request instead of all ~40 tools on every deep turn.

Success, measured before and after:
- Tool-spec tokens per deep turn: at least 60% lower.
- Tool-choice accuracy on the eval set: not lower than today, target higher.
- All existing tests still pass after the migration step, with no behaviour change.

### Today (inspected)
- `src/core/brain/index.js` `defaultTools()` builds one flat list; `registry.specs()` sends all of
  it to the model on every deep turn.
- `src/core/brain/router.js` is regex-only: it picks tier (fast/deep) and think, not tools.
- `src/core/tools/registry.js` holds a global `ALIASES` table for tool names the model invented.
- PC control (`tools/pc.js`) is shallow: open/close/focus apps, find/move/delete files, volume,
  lock, power.

### Out of scope
- Fast-path intents that run with no model call (possible later, built on the same groups).
- Embedding or classifier-based routing.
- Smart-home, calendar, email, cloud services.
- New models or STT/TTS changes.

## 2. Skill group (the new unit)

`src/core/skills/<id>/index.js` exports:

```js
{
  id: 'windows',
  label: 'Window and desktop control',          // one line, shown in the capabilities line
  triggers: [{ re: /\b(snap|maximi[sz]e|minimi[sz]e)\b/i, w: 3 }, { words: ['window', 'desktop'], w: 1 }],
  hint: 'short prompt text, injected only while the group is loaded',
  tools: [ { name, description, params, risk: 'safe'|'confirm', timeoutMs, aliases: [], run } ],
}
```

- Tool shape is unchanged (`name, description, params, run, risk, timeoutMs`); `aliases` moves
  from the global table into the tool that owns them.
- `src/core/skills/index.js` loads all groups and builds: group list, name → tool map (including
  aliases), name → group map.
- Existing tools are regrouped with no behaviour change: `media`, `ytmusic`, `timers`,
  `knowledge`, `system`, `pc`, `math` (skills.js tools), `memory`. `core` (always on) holds
  `get_time`, `jarvis_status`, `more_skills`.

## 3. Dispatch

`route()` keeps deciding tier and think. New `selectGroups(text, { lastGroups, source })`:

1. Score every group: sum of matching trigger weights.
2. Groups used last turn get a +1 follow-up bonus ("now close it", "make it louder").
3. Load the top 1–2 groups whose score is at least the threshold (default 2).
4. Deep turn with no match: `core` + `knowledge`.
5. Fast tier: no tools, as today.
6. `core` is always loaded.

Loaded set drives `specs()` and the prompt hints for that turn only.

**`more_skills({ group })`** (in `core`): adds a group's tools for the rest of the turn; max 2 extra
loads per turn; unknown group returns the list of group ids.

**Auto-load recovery:** if the model calls a tool whose group is not loaded, the runner loads that
group and runs the call (counts against the same cap of 2) instead of returning "unknown tool".

**Capabilities line** lists every group's `label`, so the model knows what exists when a group is
not loaded (keeps prompt rule 5 true).

## 4. Round-1 skills (all new)

### Windows and apps (`windows`, `audio-display`, `connectivity`, `clipboard-capture`)
- Windows and desktops: snap left/right/quarter, move to monitor, maximize, minimize, restore,
  resize to a named layout; list/switch virtual desktops, move a window to a desktop; end an
  unresponsive app (`confirm`).
- Audio and display: per-app volume and mute, system mute, list and switch the output device,
  brightness, list displays, night light.
- Connectivity and power: Wi-Fi and Bluetooth status and toggle, battery and power plan,
  focus assist / do-not-disturb.
- Clipboard and capture: read, write and history for the clipboard; screenshot (full screen,
  window or region) to file or clipboard.

### Files and documents (`files`)
- Find by name, content, date or type; recent files; file info; big-file and disk usage.
- Read and summarize text, PDF and docx (read-only; output wrapped as quoted source material).
- Change: bulk rename and organize-by-type (preview, then `confirm`), zip and unzip, copy,
  create folder. All journaled and undoable through the existing `undo_last`.

### Browser and web (`browser`)
- Tabs: list, switch, open, close, pin; open a URL; run a search.
- Read page text; downloads list; history and bookmark search.
- Needs the Chrome extension in `extension/`, today YouTube Music only. Widening it adds
  permissions, so the whole group is behind a settings switch, **off by default**, and the
  extension command set stays a fixed switch (JARVIS sends commands, never code).

Each skill's exact tool names, params and host calls are fixed in the implementation plan.

## 5. Safety

- Anything that changes state or is hard to reverse is `risk: 'confirm'`; confirmation is read
  from the user's own next utterance in code (`pc/confirm.js`), never from a tool argument.
- Text read from files, pages or the clipboard marks the turn tainted (`brain/guard.js`), so it
  cannot start a `confirm` tool.
- File skills reuse `pc/paths.js` (path allowlist), `pc/actions-log.js` and the undo journal.
- Browser reads return page text as quoted source material, never as instructions.
- Auto-load and `more_skills` never bypass `risk`.

## 6. Errors

| Case | Behaviour |
|---|---|
| Unknown group in `more_skills` | Returns the group ids |
| Cap of 2 extra loads hit | Tool result says so; model answers with what it has |
| Browser group off or extension not connected | Tool returns a plain "not connected/disabled" result; capabilities line shows the state |
| Host call fails or times out | `ok:false` with the error text, as today |
| No group matches | Core + knowledge |

## 7. Testing

- Router golden table (about 150 utterances → expected groups), including follow-ups and
  no-match cases.
- Fake-host unit tests per skill, no real PC changes.
- Migration test: tool names, descriptions and risks before and after regrouping are identical.
- Auto-load and `more_skills` caps in the orchestrator tests.
- Eval: extend `eval/questions.json` with tool-choice questions; report spec tokens per turn
  before and after.
- Manual checklist for the new PC and browser skills, in the style of
  `2026-11-10-pc-actions-checklist.md`.

## 8. Build order

1. Group framework and migration of existing tools (tests green, no behaviour change).
2. `selectGroups`, `more_skills`, auto-load, per-turn specs and hints, capabilities line.
3. Windows and apps.
4. Files and documents.
5. Browser and web, with the extension and settings switch.
6. Eval and measurements, manual checklist.
