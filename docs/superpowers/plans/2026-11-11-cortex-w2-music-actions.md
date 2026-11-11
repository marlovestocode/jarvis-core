# Cortex Wave 2 (Music, Playlists, Actions, Tool History) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the listening log, playlist knowledge, the PC-action log with its undo, and the YouTube Music undo journal onto the cortex; add a `tool` event per tool call; answer "songs I'd like" from a play graph and "what did you do today" from real history.

**Architecture:** Each old store keeps its interface and gets a cortex backing in its own folder (`music/log.js` + `music/adapter.js`, `pc/actions-log.js`, `media/ytjournal.js` + `media/mirror.js`, `self/tool-history.js`). One-time importers run in time slices after the window opens. `src/core/history/system.js` builds all of it on a lazy cortex handle, so `main.js` gains a few lines only.

**Tech Stack:** cortex (`src/core/cortex`, node:sqlite), Node test runner, Electron main process (wiring only).

**Spec:** [docs/specs/2026-11-11-cortex-wave2-music-actions-design.md](../../specs/2026-11-11-cortex-wave2-music-actions-design.md) (W2 §n). Core: [cortex core spec](../../specs/2026-11-11-cortex-core-design.md) §5 API. Wave 1 additions used: `node.update`, `cortex.meta`, `cortex.transaction`, `source.find`.

## Global Constraints

- Nothing outside `src/core/cortex` runs SQL; the model never gets SQL or the graph (it sees tool text only) (W2 §4).
- Secrets never stored: the guard pattern applies to every free-text write; tool args are redacted before the event is written (W2 §8). Machine records follow E1.
- A tainted turn cannot write `user`/`tool` trust (cortex enforces). Every W2 node is source `tool` (trust 90) and is written by app code, never from a turn's text.
- `risk: 'confirm'` tools are still confirmed from the user's own words; `undo_last` and every `move_files`/`organize_by_type` confirm-and-undo test passes unchanged except its construction line (W2 §3).
- Write order for actions: perform → `event.add`; a crash between them loses the log line, never the action (W2 §3).
- `music/stats.js` stays pure and unchanged; the 13 stats reports return identical text for identical data (W2 §3).
- Retention: plays unlimited; actions newest **5,000** plus the undoable one however old; tool events **90 days** (W2 §3).
- `next` edges: η = **0.15** per finished transition, quick skip (`QUICK_SEC` = 30) × **0.6** on the previous→skipped edge, session gap **30 min** (`SESSION_GAP`), half-life 90 days (W2 §2, §4).
- Taste: 2 hops over `next`/`by`/`contains`; drop tracks played in the last **24 h** and tracks skipped **> 60%** (W2 §4).
- Import: 100,000 plays **< 10 s** of work, in time slices after the window opens, never blocking boot; idempotent via `meta.import_music|actions|ytm_undo`; old files renamed `*.imported.bak`; the library cache is not imported (W2 §5).
- No network change, no extension protocol change (W2 §9). Never download anything.
- No `eval/run.js`, nothing that loads a model on the GPU; live checks go to `docs/superpowers/plans/2026-11-11-cortex-wave2-checklist.md`, never claimed verified.
- `src/main/main.js` is touched once, in the last code task, in one small commit (wave 3 edits it too).
- LF line endings; stage by explicit path; one commit per task, message ends `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; `npm test` green after each (baseline **1128**).

## Decisions this plan makes where the spec is silent or conflicts (approved)

| # | Gap / conflict | Plan's choice |
|---|---|---|
| E1 | `guard.SECRET`'s card rule (13+ digits) matches every epoch-ms number, so a `play` payload (`at`, `id` = `<ms>-<videoId>`) and a journal entry (`at`) can never be written; the word rule refuses songs called "Secret" and files named `secret.docx`, losing plays and undo entries that are on disk today | **Machine records** — nodes of kind `track`, `artist`, `playlist`, `file`, `folder` and events `play`, `playlist_edit`, `action` — are checked for kind, length, JSON and size, not the secret pattern (their strings are catalog titles and file paths already stored unguarded in today's files). Every other write is unchanged. `tool` events keep the full check; their args are redacted first (E14). |
| E2 | `next` needs η 0.15 (core `link` grows by 0.3) and a weaken of *one* edge (core `weaken` hits every edge of a node) | `cortex.link(src, dst, type, { eta })` (a new edge starts at `eta`); `cortex.scaleEdge(src, dst, type, factor) → boolean` (effective weight × factor, structural types refused, missing edge → false) |
| E3 | Replacing a playlist's membership needs all its `contains` edges; `neighbors` caps fan-out at 50 | `cortex.unlinkAll(src, type) → n` |
| E4 | "newest 5,000 plus the undoable one" needs an exception in retention | `event.deleteWhere({ kind, before?, keepNewest?, except?: number[] })` |
| E5 | "One transaction per source" vs "time slices that never block boot" | music import commits in chunks (≤ 2,000 lines or the slice deadline), the byte offset `meta.import_music_pos` written in the same transaction; resume continues there; `meta.import_music` and the rename only after the last chunk. Actions and the journal are small: one transaction each |
| E6 | The old play log de-duplicated by an in-memory Set of ids | de-dupe by query: an event `play` on the same track node at the same `at` (index `(node_id, at)`) |
| E7 | `all()` for stats over 100k events each call | the play log caches the array lazily (first `all()`), keeps it current on `add`, `trim()` drops it (memwatch) |
| E8 | Transition rule details | p1→p2 is a transition when `p2.at − (p1.at + p1.listenedSec·1000) ≤ SESSION_GAP` and the tracks differ. `p2.outcome === 'finished'` → `link(t1, t2, 'next', { eta: 0.15 })`; `p2.quickSkip` → `scaleEdge(t1, t2, 'next', 0.6)`; anything else → nothing. p1 = the newest stored play before p2 (live), or the previous line (import) |
| E9 | `touched` edges need two nodes; an action is an event | each undo item's destination (`to` or `created`, ≤ 20 per action) becomes a `file` node (`folder` for `make_folder`), key `path:<lowercased path>`, linked `—touched→` its parent folder node; `event.nodeId` = the first one. A node write that fails (path > 600 chars) is skipped; the event is still written |
| E10 | Playlist journal entries mutate `undone`; events are append-only | journal store interface `{ load() → newest 20 entries with undone, append(entry), markUndone(entry) }`; `markUndone` appends `playlist_edit` `{ undid: id }`; an entry is undone if its payload says so (imported) or a later `undid` names it. `createYtPlaylists` takes `journal` (default: in-memory); `journalFile` is removed |
| E11 | Mirror details | playlist node text = title (`"<title> playlist"` when under 3 chars), `data { id, name, count, fetchedAt }`. A fresh (not stale, not cached) library read upserts every playlist and archives mirrored ones that are gone. A fresh track read replaces `contains` in one transaction (≤ 5,000). Errors, stale or cached reads change nothing |
| E12 | Taste algorithm details | seeds: the current track's node (matched by normalized title + artist against the play cache) weight 1.0; top 3 artists by finished plays in the last 90 days, 0.6/0.5/0.4. `neighbors(seed, { types: ['next','by','contains'], depth: 2, limit: 200 })`; score = Σ seed · path weight over track nodes; drops per spec plus `exclude` (videoIds) and the seeds; `why` from the strongest first hop: `next` → "you often play it after <title>", `by` → "you like <artist>", `contains` → "it is in your <playlist> playlist". `artist` option keeps only that artist's tracks. Empty graph → `[]` |
| E13 | How the tool uses taste | `youtube_music` `play_random`/`queue_random`: `query` becomes optional; no query or a taste phrase ("songs I'd like", "you think I'd like", "for me", "my taste", "surprise me") → `suggest({ n })`; an artist → `suggest({ n, artist })`. Each pick is played/queued by searching `"<title> by <artist>"` (existing verified path). Empty taste → today's artist search; no artist and empty taste → "I don't know your taste yet. Name an artist." |
| E14 | Tool event details | payload `{ name, ok, ms, args, turn }`: `args` = at most 10 top-level keys, each value a string (non-strings JSON-encoded) cut to 200 chars, replaced by `"[hidden]"` when it matches `guard.SECRET`; `turn` = the turn start time in base 36 (a decimal ms trips the card rule). Emitted through a new orchestrator option `onToolCall(e)` after each model tool call and for a fast-path skill call (`args: {}`) |
| E15 | Diagnostics shape | `self_diagnostics` "tool runs": last 7 days from `tool` events (`calls`, `fails`, rate per failing tool); last error text from the runner's in-memory stats when it has one. The history self-check line: import state (`importing music 41%` / `imported N plays, M actions, K playlist edits`) and event counts |
| E16 | `activity_log` output | `activity_log({ what?, period? })`, period as `music_stats` (default `today`), `what` omitted = all three; ≤ 1,500 chars; **untrusted** (it repeats song titles, file names and tool args from outside) |
| E17 | Where the wiring lives | `src/core/history/system.js` `createHistorySystem({ getCortex, dataDir, getConfig, log, now })` (lazy cortex handle, so construction order in `main.js` does not move); `start()` runs imports and retention |
| E18 | When retention runs | after the imports finish, then every 6 h (timer unref'd) |
| E19 | Short names | artist text = name, `"<name> (artist)"` when under 3 chars; track text `"<title> — <artist>"`, `"<title>"` without artist, the videoId without title |
| E20 | "Still importing" wording | `music_stats` (and the `taste` report) put first: `Still importing your older plays (41%); these numbers are partial.` |

## Review Focus

1. **The extension re-sends a play after a JARVIS restart** (late duplicate, same `startedAt`) → stored once, no second `next` strengthening. Test in Task 2.
2. **JARVIS quits in the middle of the music import** → next boot resumes at the saved offset: no duplicate plays, no lost lines, the file is renamed only after the last chunk. Test in Task 3.
3. **A move of a file named like a secret** (`C:\Users\u\Desktop\secret 1234567890123.pdf`) → the action and its undo are stored; `undo_last` still offers it. Test in Task 5.
4. **The extension goes offline or a library read comes back stale** → the mirror keeps the last playlists and memberships. Test in Task 6.
5. **A tool arg holding a password or a long number, or a 50 KB arg** → event written with `"[hidden]"` / 200 chars; the turn is unaffected when the event write throws. Test in Task 7.

---

## File Structure

```
src/core/cortex/edges.js, events.js, guard.js, nodes.js, index.js   CHANGED  E1–E4
src/core/music/
  adapter.js      NEW   recordPlay / playsFrom: events, track/artist nodes, next edges
  log.js          CHANGED  createPlayLog({ cortex, getConfig, now, log }) same surface + range(), importing state
  import.js       NEW   createMusicImport({ cortex, file, log, now }) sliced, resumable
  taste.js        NEW   createTaste({ cortex, playLog, now }) suggest()
src/core/pc/actions-log.js           CHANGED  createActionLog({ cortex, now, log }) + importActionsLog()
src/core/media/ytjournal.js          NEW   createJournalStore({ cortex }) + importYtmUndo(), memoryJournal()
src/core/media/mirror.js             NEW   createPlaylistMirror({ cortex, now })
src/core/media/ytplaylists.js        CHANGED  journal + mirror options
src/core/self/tool-history.js        NEW   createToolHistory({ cortex, now })
src/core/orchestrator.js             CHANGED  onToolCall
src/core/tools/musicstats.js, media.js, self.js   CHANGED  taste report, play_random/queue_random, history-backed tool runs
src/core/tools/activity.js           NEW   activity_log
src/core/skills/self/index.js, media/index.js     CHANGED  pass history / taste
src/core/history/system.js           NEW   createHistorySystem
src/main/checks.js                   CHANGED  history check
src/main/main.js                     CHANGED  (last) wiring
scripts/cortex-bench.js              CHANGED  music import gate
test/helpers/cortex.js               NEW   cortexOn(dir)
test/fixtures/music-plays.js         NEW   deterministic play generator in the real file's shape
test/fixtures/music-stats-golden.json NEW  13 reports' text from the OLD file-backed log (TZ=UTC)
```

---

### Task 1: Core additions (E1–E4)

**Files:** Modify `src/core/cortex/guard.js`, `nodes.js`, `events.js`, `edges.js`, `index.js`; tests in `test/cortex-edges.test.js`, `test/cortex-events.test.js`, `test/cortex-nodes.test.js` (new cases; create a file if one is missing).

**Interfaces:**
- `guard.RAW_NODE_KINDS = Set['track','artist','playlist','file','folder']`, `guard.RAW_EVENT_KINDS = Set['play','playlist_edit','action']`; `checkText(kind, text)` skips `SECRET` for raw kinds; `checkData(data, { secrets = true })`.
- `link(src, dst, type, { weight?, eta? })`; `cortex.scaleEdge(src, dst, type, factor) → boolean`; `cortex.unlinkAll(src, type) → number`.
- `event.deleteWhere({ kind, before?, keepNewest?, except? })`.

- [ ] Tests first: `link with eta: new edge starts at eta, an existing one grows by eta`; `scaleEdge scales one edge only, not the node's other edges`; `scaleEdge on supersedes → false, unchanged`; `unlinkAll removes every contains edge of the src (60 edges), none of another type`; `deleteWhere keepNewest with except keeps the excepted old event`; `play event with an epoch-ms at and a title "Secret" is written`; `track node "Secret — Madonna" is written`; `a fact "my password is x" is still refused`; `a tool event with a 13-digit number is still refused`.
- [ ] Run them, see them fail; implement; `npm test`; commit `feat(cortex): edge eta, scaleEdge, unlinkAll, retention except, machine records`.

### Task 2: Play log on the cortex (W2 §2, §3)

**Files:** Create `src/core/music/adapter.js`, `test/fixtures/music-plays.js`, `test/fixtures/music-stats-golden.json`, `test/helpers/cortex.js`, `test/music-adapter.test.js`; modify `src/core/music/log.js`; change only construction lines in `test/music-stats.test.js` (and `src/main/selftest.js` keeps compiling: it calls `ctx.playLog.add`).

**Interfaces:**
- `test/helpers/cortex.js`: `cortexOn(dir) → cortex` (opens `<dir>/cortex.db`).
- `adapter.recordPlay(cortex, play, { prev, source }) → { eventId, trackId } | null` (null = duplicate, E6); writes track node (E19, `data { videoId, album? }`), an artist node per `play.artists` with `track —by→ artist`, the event (`nodeId` = track, payload = `play` as given), the `next` rule (E8) against `prev`. One `cortex.transaction`.
- `adapter.playsFrom(cortex, { since?, until? }) → play[]` ordered by `at`.
- `adapter.trackKey(videoId) = 'track:' + videoId`, `artistKey(name) = 'artist:' + lowercase, non-letters/digits → one space, trimmed`.
- `createPlayLog({ cortex, getConfig, now, log }) → { add(raw), clear(), all(), count(), since(), range({ since, until }), trim(), importing: { active, pct } (set by Task 3), stats() }`. `add` returns the stored play or null as today (logging off, junk, duplicate).
- Fixture: `makePlays({ n = 600, seed = 7, start = Date.UTC(2026, 6, 1) }) → play[]` — `normalize()` outputs: 40 artists (some "A, B" multi-artist), 150 tracks, sessions with gaps, finished/skipped/partial/quick-skip, repeats, `list` sources, one late out-of-order play.

- [ ] Step 1 (before any change): write `test/music-adapter.test.js` case `golden fixture matches the old log` that, with `process.env.TZ = 'UTC'` at the top, builds the 13 reports × periods `all`, `week`, `30` (limit 10, `by: 'plays'`, `name` = the top artist for `artist`) from the OLD `createPlayLog({ file })` filled with `makePlays()`; run it once with `UPDATE_GOLDEN=1` to write the JSON; commit nothing yet.
- [ ] Tests first: `golden: the cortex play log gives the same 39 texts`; `parity: report(playLog.all()) equals report(plays) for every report`; `add → stored play, count/since/range`; `logPlays off → null, nothing written`; `junk → null`; `late duplicate after reopen → null, one event, next edge weight unchanged` (Review Focus 1); `late out-of-order play keeps all() sorted`; `finished transition creates next 0.15, second one grows`; `quick skip scales the previous→skipped edge × 0.6 and no other edge`; `gap > 30 min → no edge`; `same track twice → no edge`; `"Secret" by "U2" stored (E1, E19)`; `trim drops the cache, all() reloads`. Existing `music-stats.test.js` cases pass with `createPlayLog({ cortex: cortexOn(dir), ... })` (a reopened cortex replaces "again").
- [ ] Implement; `npm test`; commit `feat(music): play log on the cortex with a play graph` (fixture and golden in this commit).

### Task 3: Music import (W2 §5, E5)

**Files:** Create `src/core/music/import.js`, `test/music-import.test.js`.

**Interfaces:**
- `createMusicImport({ cortex, file, log, now, playLog }) → { step({ deadlineMs = 50 }) → { done, pct, imported, bad }, state() }`. Reads `file` by byte offset (1 MB reads, partial last line carried over), each line `JSON.parse` + shape check (`videoId` regex, finite `at`, `listenedSec`, `outcome`), then `recordPlay` with `prev` = previous imported play; chunk ≤ 2,000 lines per transaction with `meta.set('import_music_pos', offset)`. EOF → `meta.import_music = <ts>`, `meta.import_music_bad = n`, log `music: imported N plays (M malformed lines skipped)`, rename to `music-plays.jsonl.imported.bak` (existing → `music-plays.jsonl.<ts>.imported.bak`). Marker set and file still there → rename only. No file → done. It sets `playLog.importing` while running and clears the play cache when done.

- [ ] Tests first: `imports every valid line, skips and counts malformed ones`; `next edges rebuilt as a live replay would`; `idempotent: a second run imports 0`; `resume: stop after the first chunk, new importer continues, no duplicates, rename only at the end` (Review Focus 2); `marker present + file present → rename only`; `no file → done at once`; `each step returns within deadline + one chunk`; `playLog.importing.active true until done; all() includes imported plays after`.
- [ ] Implement; `npm test`; commit `feat(music): sliced, resumable import of music-plays.jsonl`.

### Task 4: Taste (W2 §4, §6, E12, E13, E20)

**Files:** Create `src/core/music/taste.js`, `test/music-taste.test.js`; modify `src/core/tools/musicstats.js`, `src/core/tools/media.js`, `src/core/skills/media/index.js`, `src/core/skills/ytmusic/index.js`; tests in `test/music-stats.test.js`, `test/media-tools.test.js` (new cases in the existing youtube_music test file).

**Interfaces:**
- `createTaste({ cortex, playLog, now }) → { suggest({ n = 5, seeds?, exclude?, artist?, current? }) → [{ videoId, title, artist, why }] }`; `current` = `{ title, artist }` (from `media_status`); `seeds` = node ids override.
- `createMusicStatsTool({ playLog, playlistName, taste })`: `REPORTS` + `'taste'` (only when `taste` given); E20 prefix while importing.
- `createYtMusicTool({ ytm, taste = null, current = async () => null })`: E13.

- [ ] Tests first: `graph order: the track most often played after the seed ranks first`; `excludes tracks played in the last 24 h`; `excludes tracks skipped > 60%`; `exclude option and seeds never returned`; `why names the strongest edge (next / by / contains)`; `artist option keeps only that artist`; `current track unknown → top artists seed`; `empty graph → []`; `cold start (no plays, no cortex nodes) → []`; music_stats `taste report lists picks with why`, `still importing prefix`; youtube_music `play_random without query plays the first suggestion by search`, `queue_random "songs you think I'd like" queues n suggestions`, `empty taste with an artist → artist search as before`, `empty taste, no artist → "I don't know your taste yet. Name an artist."`.
- [ ] Implement; `npm test` (incl. `skills-tokens`, `prompt-tools`); commit `feat(music): songs you'd like from the play graph`.

### Task 5: Actions on the cortex (W2 §2, §3, E4, E9)

**Files:** Modify `src/core/pc/actions-log.js`; create `test/actions-adapter.test.js`; change only construction lines in `test/helpers/tool-deps.js`, `test/pc-confirm.test.js`, `test/pc-tools.test.js`, `test/skills-files-write.test.js`, `test/skills-windows.test.js`; `test/mem-budgets.test.js` action-log case becomes the retention case below (its file-line assertions have no meaning without the file).

**Interfaces:**
- `createActionLog({ cortex, now, log }) → { write(entry) → e, lastUndoable() → e | null, list() → e[] (asc), stats() → { entries, cap: 5000 }, prune() → n }`; `e` = the same object as today (`id` `a<base36>`, ISO `at`, `what`, `args`, `result` ≤ 500, `ok`, `undo?`, `undid?`). `lastUndoable` scans `action` events newest first in pages of 200 (an `undid` is always newer than its target), returns at the first match.
- `prune()`: `deleteWhere({ kind: 'action', keepNewest: 5000, except: [lastUndoable event id] })`.
- `importActionsLog({ cortex, file, log }) → { imported, bad, already? }`: one transaction, `at` = `Date.parse(e.at)`, broken lines counted, `meta.import_actions`, rename to `.imported.bak`.

- [ ] Tests first: `undo parity: write two moves, reopen, lastUndoable is the second; after undid it is the first`; `failed or undo-less entries never undoable`; `retention: 5,100 entries → 5,000 kept plus an old undoable move`; `touched: a move links the destination file node to its folder; event.nodeId is that file`; `21 paths → 20 nodes`; `secret-like and long-number file name → stored, undoable` (Review Focus 3); `import: entries kept with undo/undid, broken line skipped, idempotent, renamed`. Existing pc-confirm / pc-tools / files-write / windows tests green with the new construction line.
- [ ] Implement; `npm test`; commit `feat(pc): action log and undo on the cortex`.

### Task 6: Playlist journal and mirror (W2 §2, E10, E11)

**Files:** Create `src/core/media/ytjournal.js`, `src/core/media/mirror.js`, `test/playlist-mirror.test.js`, `test/ytplaylists-journal.test.js`; modify `src/core/media/ytplaylists.js`; change the construction line of `test/ytplaylists-add.test.js` "undo journal survives a restart" (cortex store instead of `journalFile`).

**Interfaces:**
- `memoryJournal() → store` (default); `createJournalStore({ cortex }) → { load(), append(entry), markUndone(entry) }`; `importYtmUndo({ cortex, file, log })` (one transaction, `meta.import_ytm_undo`, rename).
- `createPlaylistMirror({ cortex, now }) → { library(list), playlist(data), get(id) }`; `createYtPlaylists({ ..., journal = memoryJournal(), mirror = null })` calls `mirror.library` after a fresh library read and `mirror.playlist` after a fresh track read; mirror errors are logged, never thrown.

- [ ] Tests first: journal `record → append; undo → markUndone; reopen → same newest-not-undone`, `imported entry with undone: true is skipped`, `only the newest 20 are undoable`; mirror `library refresh upserts playlists and archives a gone one`, `track read replaces membership atomically (a failure mid-way leaves the old set)`, `stale library / NO_LINK / cached read → mirror untouched` (Review Focus 4), `contains edges usable by neighbors`. Existing ytplaylists tests green.
- [ ] Implement; `npm test`; commit `feat(media): playlist mirror and undo journal on the cortex`.

### Task 7: Tool events (W2 §2, E14)

**Files:** Create `src/core/self/tool-history.js`, `test/tool-events.test.js`; modify `src/core/orchestrator.js`; new case in `test/orchestrator.test.js`.

**Interfaces:**
- `createToolHistory({ cortex, now }) → { record({ name, ok, ms, args, turn }), stats({ since }) → Map<name, { calls, fails, lastAt }>, recent({ since, until, limit = 50 }) → event[], prune() }` (`prune` = `deleteWhere({ kind: 'tool', before: now − 90 d })`); `redactArgs(args) → object` exported.
- `createOrchestrator({ ..., onToolCall = null })`: called with `{ name, ok, ms, args, turn }` after every model tool call and a fast-path skill call; a throw is swallowed.

- [ ] Tests first: `one event per call with name, ok, ms`; `args: 11 keys → 10; a 50 KB string → 200 chars; "password hunter2" and a 13-digit number → "[hidden]"` (Review Focus 5); `turn is base 36`; `stats counts calls and fails since`; `prune drops events older than 90 days`; orchestrator `onToolCall fires per tool call and for the fast path; a throwing onToolCall leaves the turn intact`.
- [ ] Implement; `npm test`; commit `feat(self): a tool event for every tool call`.

### Task 8: `activity_log` and diagnostics (W2 §6, E15, E16)

**Files:** Create `src/core/tools/activity.js`, `test/activity-log-tool.test.js`; modify `src/core/tools/self.js`, `src/core/skills/self/index.js`; new cases in the existing self-tools test file.

**Interfaces:**
- `createActivityTool({ actionLog, toolHistory, playLog, now }) → tool` `activity_log`, params `{ what?: 'actions'|'tools'|'music', period?: string }`, `risk: 'safe'`, `untrusted: true`.
- `createSelfTools({ ..., toolHistory })`; skills/self group takes `self.toolHistory`, `self.activity` (`{ actionLog, playLog }`) and adds `activity_log` with aliases `['what_did_you_do', 'action_history']`, triggers "what did you do", "what failed".

- [ ] Tests first: `actions today listed newest first with ok/failed`; `tools: counts and the failures of the week`; `music: plays and top tracks`; `default = all three, ≤ 1,500 chars`; `untrusted flag set`; `nothing logged → says so`; self `tool runs from history survive a restart (new runner, same cortex)`.
- [ ] Implement; `npm test` (incl. `skills-tokens`, `skills-migration` ADDED list); commit `feat(self): activity_log and tool failure rates from history`.

### Task 9: History system and self-check (E17, E18)

**Files:** Create `src/core/history/system.js`, `test/history-system.test.js`; modify `src/main/checks.js` (+ a case in `test/self-checks.test.js`).

**Interfaces:**
- `createHistorySystem({ getCortex, dataDir, getConfig, log, now, sliceMs = 50 }) → { playLog, actionLog, journal, mirror, toolHistory, taste, start(), stop(), check() → { level, detail }, stats(), trim() }`. `start()`: actions and journal imports at once, the music import by `setImmediate` slices of `sliceMs`, then retention (`actionLog.prune`, `toolHistory.prune`) and every 6 h. Construction does no cortex call.
- `checks.js`: `{ id: 'history', run: ... }` from `ctx.history.check()`.

- [ ] Tests first: `construct without a cortex yet; first use opens it lazily`; `start imports all three files from a data dir and renames them`; `music import finishes over several slices and playLog.importing goes false`; `stop() mid-import stops the slices`; `check: importing 41% / imported counts`; self-check `history ok / off`.
- [ ] Implement; `npm test`; commit `feat(history): wire music, actions, journal and tool history on the cortex`.

### Task 10: `main.js` wiring (one small commit)

**Files:** Modify `src/main/main.js` only.

- [ ] Replace the three constructors with `ctx.history = createHistorySystem({ getCortex: () => ctx.cortex, dataDir: DATA_DIR, getConfig: ctx.getConfig, log: ctx.log })`, `ctx.playLog = ctx.history.playLog`, `ctx.actionLog = ctx.history.actionLog`; pass `journal`/`mirror` to `createYtPlaylists` (no `journalFile`); `taste` and `current` into the catalog deps; `self.toolHistory`/`self.activity`; `onToolCall: e => ctx.history.toolHistory.record(e)`; `ctx.history.start()` where `memorySystem.start()` runs; memwatch `listeningLog: ctx.history`; `onQuit` stops it before the memory system closes.
- [ ] `npm test`; a grep test is not needed (no file path left). Commit `feat(history): wire wave 2 into JARVIS`.

### Task 11: Bench, checklist, docs

**Files:** `scripts/cortex-bench.js` (phase `music-import`: 100,000 generated plays, gate total step time ≤ 10,000 ms), `docs/superpowers/plans/2026-11-11-cortex-wave2-checklist.md`.

- [ ] Add the phase; run `node --expose-gc scripts/cortex-bench.js` (all gates pass; record numbers in the ledger); write the checklist (first start import and rename, a real listening session building `next` edges, a real skip, "play songs you think I'd like", a real move + undo, playlist add + undo, playlist refresh mirror, `activity_log` / `self_diagnostics` after a restart, import of the real 100k-scale file timing); `npm test`; commit `docs(history): wave 2 bench gate and checklist`.
- [ ] Final whole-branch review on the most capable model, one fix pass, push.
