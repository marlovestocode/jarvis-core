# Cortex Wave 2 — Music, Playlists, Actions and Tool History

Date: 2026-11-11 · Status: draft for review (spec only; no plan, no code)
Depends on [cortex core](2026-11-11-cortex-core-design.md). Independent of wave 1 and wave 3 (touches `main.js` wiring only, see §7).

## 1. Goal

Move JARVIS's listening history, playlist knowledge, PC-action log (with undo) and a new tool-call history onto the cortex, and use the
graph to make "play songs I'd like" and "what did you do today" answer from real history. The pure statistics code keeps its behavior.

### Decisions

| Topic | Decision |
|---|---|
| Plays | one `event` per finished play (high volume, keyword-only); `track` and `artist` nodes give them structure |
| Taste | a play graph: finishing builds `next` edges between consecutive tracks, skipping weakens them; "songs you'd like" is spreading activation over it |
| Playlists | YouTube is the truth; the cortex **mirrors** `playlist` nodes and membership, refreshed from the extension, trust `tool` (90) |
| Actions | `actions.log` and the undo journal become `action` events; the undo rule ("newest successful move not yet undone") becomes a query |
| Tool history | new `tool` events (name, ok, ms, truncated args) for every tool call; powers "what did you do for me" and failure stats |

## 2. Mapping

| Thing | Cortex | Notes |
|---|---|---|
| Finished play | event `play`, payload exactly the object `music/log.js` `normalize()` returns (`videoId`, title, artist, heard, ratio, outcome, at, …) | `node_id` = the `track` node |
| Track | node `track`, key `track:<videoId>`, text `"<title> — <artist>"`, `data` { videoId, album? } | source `tool` |
| Artist | node `artist`, key `artist:<normalized name>` | edge `track —by→ artist` |
| Playlist | node `playlist`, key `playlist:<id>`, `data` { name, count, fetchedAt } | edges `playlist —contains→ track`, replaced wholesale on each refresh in one transaction |
| Consecutive plays in one listening session (gap ≤ 30 min, `stats.SESSION_GAP`) | edge `track —next→ track` | strengthened η = 0.15 per finished transition; a quick skip (`QUICK_SEC`) applies the weaken rule (× 0.6) to the *previous→skipped* edge |
| PC action | event `action`, payload `{ what, args, result, ok, undo?, undid? }` (the exact shape of `actions-log.js`) | `touched` edges to `file`/`folder` nodes (key `path:<lowercased path>`, source `tool`) for moves, copies, renames, deletes |
| Playlist edit | event `playlist_edit`, payload = one journal entry of `ytm-undo.json` | undo is "newest not undone", same rule |
| Tool call | event `tool`, payload `{ name, ok, ms, args (≤ 200 chars each), turn }` | emitted from `orchestrator.js` where the call finishes; no results stored |

## 3. Behavior that must not change

- `music/stats.js` keeps its pure functions over an array of plays. A new adapter builds that array from `event.query({ kind:'play', since })`
  (ordered by `at`); the 14 report types return identical text for identical data (a golden test replays the real `music-plays.jsonl` shape).
- `createPlayLog` keeps its interface (`add(e)`, `count()`, `all()`/range reads as used by `musicstats.js`, `ytplaylists`, `main.js`); only the backing changes.
- `createActionLog` keeps `add`, `newestUndoable`, `list`; `undo_last` and every `move_files`/`organize_by_type` confirm-and-undo test passes unchanged.
- The retention rules move to SQL: plays unlimited (events are small; a year of heavy use is well under 20 MB); actions keep the newest 5,000
  plus any undoable entry, however old; tool events keep 90 days.
- Write order for actions: perform → `event.add`. A crash between them loses the log line but never the action; the existing "verify, then say
  done" tool behavior is untouched.

## 4. Taste: "songs I'd like"

`music/taste.js` exposes `suggest({ n, seeds?, exclude? }) → [{ videoId, title, artist, why }]`:
seeds = the currently playing track (from `media_status`) and the user's top artists by finished plays; spread 2 hops over `next` and
`by`/`contains` edges with effective weights (`next` half-life 90 days); drop tracks played in the last 24 h and tracks with a skip ratio
above 60%; `why` names the strongest edge ("you often play it after <track>"). `youtube_music` actions `play_random`/`queue_random` and the
phrase "songs you think I'd like" use it first and fall back to the current behavior (artist search) when the graph is empty, so a new user
loses nothing. The model never sees the graph; it receives the final list and `why` text.

## 5. Import

On first boot after this wave, one transaction per source, idempotent via `meta.import_music|actions|ytm_undo`:
`music-plays.jsonl` (stream line by line, skipping malformed lines, counting them in the log) → events and nodes, `next` edges rebuilt by
replaying plays in order; `actions.log` → `action` events keeping `undo`/`undid`; `ytm-undo.json` → `playlist_edit` events; the library cache
is not imported (it is a cache; the next refresh fills `playlist` nodes). Old files renamed `*.imported.bak`. Import of 100,000 plays must finish
under 10 s and never block boot: it runs in time slices after the window opens, and stats reports say "still importing" until done.

## 6. Tools and diagnostics

- `music_stats` unchanged for the model; adds report `taste` backed by `suggest`.
- New tool `activity_log({ what?: 'actions'|'tools'|'music', period? })` in the `self` group (read-only): "what did you do for me today", "what failed this week".
- `self_diagnostics` gains tool failure rates from `tool` events (replacing the in-memory counters that reset on restart) and an import-state line.

## 7. Touch points

`music/log.js`, `pc/actions-log.js`, `media/ytplaylists.js` (journal + mirror), `tools/musicstats.js`, `tools/media.js` (`play_random`), `orchestrator.js`
(tool events), `main.js` (construction order: cortex before `playLog`, `actionLog`, `ytPlaylists`), `skills/self`. New: `music/taste.js`,
`music/adapter.js`. Wiring in `main.js` is the only conflict point with waves 1 and 3, so waves are merged one at a time.

## 8. Testing

`music-adapter` (golden stats parity on a recorded play log; add/count/range), `music-import` (malformed lines, idempotent, 100k plays under the budget in
the bench, `next` edges rebuilt), `music-taste` (graph order, exclude recent plays and skipped tracks, `why`, empty-graph fallback, cold start),
`actions-adapter` (undo parity: the existing action-log and `move_files` tests run unchanged against the cortex backing; retention rules; `touched` edges),
`playlist-mirror` (refresh replaces membership atomically; extension offline leaves the last mirror), `tool-events` (emitted per call, args truncated,
no secrets in args: the guard pattern is applied), `activity-log-tool`. Real-app checks (a real listening session, a real undo, the extension) go into
`docs/superpowers/plans/2026-11-11-cortex-wave2-checklist.md`, not claimed verified.

## 9. Out of scope

Recommending music from outside the user's own history, cloud services, changing the extension protocol, rewriting `stats.js` into SQL aggregates
(possible later; the adapter keeps it simple first), embeddings for tracks.
