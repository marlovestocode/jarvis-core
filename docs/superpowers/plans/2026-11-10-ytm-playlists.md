# YouTube Music Playlists — Implementation Plan

Status: plan only, no code written. Date: 2026-11-10.
Scope: give JARVIS full control of the user's personal YouTube Music playlists through the existing Chrome extension.

## 1. What exists today (inspected)

| Piece | File | Fact that shapes the plan |
|---|---|---|
| Extension (MV3) | `extension/manifest.json`, `background.js`, `page.js` | Permissions: `scripting tabs alarms storage`, host `https://music.youtube.com/*`. Worker connects to JARVIS over WebSocket `127.0.0.1:47830-47832/ytmusic`. |
| Command surface | `extension/page.js` `ytm(cmd,args)` | Runs in the page's MAIN world. Fixed switch: `status search play enqueue remove clear repeat shuffle like`. JARVIS cannot send code. Calls YouTube's own **InnerTube** API (`/youtubei/v1/...`) same-origin with `credentials: 'include'`. |
| Auth | page.js | No OAuth, no API key. The user's Chrome login is the auth. `ytcfg.get('LOGGED_IN')` is checked only for `like`. |
| Link | `src/core/media/ytmusic-link.js` | Origin-locked WS server. `request(cmd,args,{timeout})`, `connected`, `info.version` (from `hello`). One socket, newest wins. |
| Service | `src/core/media/ytmusic.js` | `createYtMusic({link})`: `find` (parse + search + `rank`), `play`, `enqueue`, `upNext`, `status`, `like`... Every action is read back and verified. |
| Ranking | `src/core/media/rank.js` | `parseRequest` ("title by artist", kind words) and `rank` with `MIN_SCORE 0.35`, `SURE_SCORE 0.75`. Pure and tested. |
| Fast path | `src/core/media/intent.js`, `skill.js` | Regex intents run **before** the model (`fastPath` in orchestrator). `pending` clarification state with 30 s expiry. |
| Model tool | `src/core/tools/media.js` `createYtMusicTool` | One tool, `action` enum, `query` string. Returns plain text. |
| Tool runner | `src/core/tools/registry.js` | Tool = `{name, description, params, run(args, ctx)→string, timeoutMs}`. `ctx` is `{signal}` only. Errors become `Error: ...` text. |
| Registration | `src/core/brain/index.js` `defaultTools`, `src/main/main.js:114-129` | `ytm` is injected, tool pushed when present. |
| Prompt | `src/core/brain/prompt.js` `TOOL_HINTS`, `promptInfo()` | Per-turn prompt lists only tools that exist; `promptInfo` feeds facts (hardware, media). |
| Settings | `src/core/settings.js` `DEFAULTS`, `NESTED`, `applyPatch`; `src/core/config.js` `merge` | Typed, validated, per-key merge. New config must follow this. |
| Tests | `test/ytmusic.test.js` | Fake candidates shaped like real extension output, real WS link tests. Pattern to copy. |

**Not present:** any playlist or library read/write, any write to YouTube Music other than queue and like (those drive the page's own UI/state).

## 2. Assumptions (flagged, with options)

1. **A1 — Platform is YouTube Music via InnerTube.** The only "API" is the unofficial InnerTube API the page already uses. There is no official YouTube Music API; the official YouTube Data API v3 can edit YouTube (not Music-specific) playlists but needs OAuth and a Google Cloud project. *Option:* if InnerTube proves too brittle, fall back to Data API v3 behind the same `ytplaylists` interface (Phase 0 decides).
2. **A2 — Write calls need an auth header the current code does not send.** Page-originated InnerTube writes normally carry `Authorization: SAPISIDHASH <ts>_<sha1(ts SAPISID origin)>` plus `X-Goog-AuthUser` and `X-Origin`. Existing `innertube()` sends none (reads for search work without). *Assumption:* the `SAPISID` cookie is readable in-page and the hash can be computed in `page.js`. **Unverified. Phase 0 spike proves it** before anything else is built.
3. **A3 — Endpoint names.** Believed (from community clients such as ytmusicapi, not from docs): library list `browse` `FEmusic_liked_playlists`; contents `browse` `VL<playlistId>` with continuations; `playlist/create`; `browse/edit_playlist` with actions `ACTION_ADD_VIDEO`, `ACTION_REMOVE_VIDEO` (needs `setVideoId`), `ACTION_MOVE_VIDEO_BEFORE`, `ACTION_SET_PLAYLIST_NAME`; `playlist/delete`. Shapes drift. Phase 0 captures real responses into `test/fixtures` and the parsers are written against those.
4. **A4 — Single account.** One signed-in profile. Multi-account (`X-Goog-AuthUser` index) is out of scope; the Phase 0 spike records which index works.
5. **A5 — Playlist "kinds".** Owned, saved-from-others, auto-generated (Liked Music `LM`, Episodes for Later `SE`) differ in editability. The model reads an `editable` flag, never guesses.

## 3. Architecture overview

```
 user text/voice
   │
   ├─► fastPath (intent.js/skill.js)  — deterministic phrases: "play my gym playlist", "undo", "yes/no"
   │
   └─► model + tools ─┐
                      ▼
        src/core/tools/ytplaylists.js      (4 model tools, thin: validate, call service, format text)
                      ▼
        src/core/media/ytplaylists.js      (NEW service: cache, resolver, edit ops, undo journal, rate limiter)
                      ▼
        src/core/media/ytmusic.js (find/play/status reuse) ─► ytmusic-link.js ─► extension
                                                                                   ▼
                                                    extension/page.js NEW cmds → InnerTube on music.youtube.com
```

Design rules:
- **Code resolves, the model decides.** Name/ID resolution, dedupe, editability, confirmation and undo live in the service, not in the prompt. The model picks tools and relays questions.
- **Extension stays a dumb, fixed-command executor.** New commands are added to the allowlisted switch; no code from JARVIS; ids validated by regex in `page.js`.
- **No new browser permissions.** Host permission already covers every endpoint. Manifest version bumps to `1.1.0`; JARVIS checks `link.info.version` and says "reload the extension" if old.
- **Config in `settings.js`, live data in a cache.** No playlist name, id or song in code.

## 4. Data driven: concrete definition

### 4.1 Models (JSON, produced by `page.js`, normalised in the service)

```
Playlist { id, title, trackCount, owned, editable, kind: 'user'|'saved'|'liked'|'auto', privacy, updatedAt }
Track    { videoId, setVideoId, title, artists[], album, durationSec, position, available }
Playback { videoId, title, artists[], state, playlistId? }        // from existing status().playing
```
`setVideoId` is the per-row handle YouTube requires to remove or move a track. It exists only in a fresh playlist read, so removes/moves must read before write.

### 4.2 Config (new nested `music` block in `settings.js`)

```
music: {
  aliases: [{ alias: 'gym', playlistId: 'PL...' }],   // user-defined shortcuts, validated: string, <=50, max 50
  defaultAddTarget: '',            // playlistId used when "add this" names no playlist ('' = ask)
  confirmDestructive: true,        // keep true; false only skips removal prompts, never deletes
  libraryTtlSec: 300, playlistTtlSec: 120,
  maxBulk: 25,                     // cap per single edit
  digestSize: 30                   // playlists shown to the model in the prompt
}
```
Add to `DEFAULTS`, `NESTED`, `applyPatch`, then a small section in `settings.html/js`. Learned preference (not config): `lastAddTarget` kept in the cache file and offered as a suggestion, never used silently.

### 4.3 Fetch / cache / refresh

| Data | Source | Cache | Refresh |
|---|---|---|---|
| Library list | `playlists` cmd | memory + `<userData>/ytm-library.json` | TTL 5 min; on extension (re)connect; after any create/rename/delete; manual "refresh my playlists" |
| Playlist contents | `playlist` cmd (follows continuations, caps at 5000) | memory only, keyed by id | TTL 2 min; **always re-read before remove/move/dedupe check** if older than 10 s; invalidated by own writes |
| Now playing | existing `status` | none (never cached beyond one tool call) | read fresh each time |
| Prefs | config | in config | on `applyPatch` |

The on-disk library file is a **startup hint only** (so the prompt digest and name resolution work before the extension reconnects); anything it says is marked `stale` and re-fetched before any write.

Prompt digest: `promptInfo()` gains `library: "Playlists: Gym (42), Chill (118), ..."` from cache, so the model resolves most names without a list call. If cache is empty the line is omitted and the model calls `ytm_library`.

## 5. Capability and tool specification

Four model tools. Fewer, composable tools beat many near-duplicates for small local models. All accept **names or ids**; the service resolves. All return short text plus a machine-parseable tail the model can chain on (e.g. `[playlist PLxyz, 42 tracks]`).

Common resolver outputs the tools can return: `ok`, `ambiguous` (candidates), `notFound` (with nearest), `blocked` (needs confirm / not editable / auth). Voice replies stay 1–3 short sentences.

### 5.1 List and view — `ytm_library`
- **Inputs:** `view`: `playlists` | `playlist`; `playlist?` (name/alias/id); `query?` (filter tracks/playlists); `limit?` (default 25); `offset?`.
- **Output:** playlists → "Gym (42 tracks), Chill (118)…". playlist → title, count, then `n. Title — Artist` rows paged.
- **Endpoints:** `browse FEmusic_liked_playlists`; `browse VL<id>` + continuations (A3).
- **Permissions:** logged in (read). Needs a YTM tab; read commands join `NEEDS_TAB` in `background.js` so a background tab opens like `search` does.
- **Fit:** new `playlists` and `playlist` cmds in `page.js`; parsers in the service; no ranking changes.
- **Edge:** huge playlist → paged, never dumped whole into the model context (context is tight; `fitWindow` in orchestrator).

### 5.2 Play — `ytm_play_library`
- **Inputs:** `playlist` (name/alias/id), `track?` (name within playlist), `shuffle?` bool.
- **Output:** "Playing Gym (42 tracks)" or "Playing 'X' from Gym", verified.
- **Endpoints:** none new for playback: reuse existing `play` cmd with `watchPlaylistEndpoint {playlistId}` or `watchEndpoint {videoId, playlistId}`. Shuffle: call existing `shuffle` after start (avoids guessing shuffle `params`).
- **Fit:** extends `ytmusic.play` path (it already verifies `started` and `videoId`). `track` resolves against the cached contents with `rank`.
- **Fast path:** add intent `kind:'library-play'` for "play my/the X playlist" **before** the generic `play (.+)` rule in `intent.js`. Today that rule would send "play my gym playlist" to *public* YouTube Music search and play the wrong playlist. Resolution order: library match first; only if no library match fall through to catalog search (and say so).

### 5.3 Create and edit — `ytm_playlist_edit`
- **Inputs:** `op`: `create` | `add` | `remove` | `move` | `rename`; `playlist` (target; for create: new title); `songs?` (array of names, "title by artist"); `tracks?` (for remove: names or positions); `from?`/`to?` (move; 1-based positions or "top"/"bottom"); `title?` (rename); `allowDuplicate?` bool.
- **Output:** what changed, plus an **undo token line**: "Added 'X' to Gym. Say 'undo' to revert."
- **Endpoints:** `playlist/create`; `browse/edit_playlist` batched actions (one request for many songs, honours `maxBulk`) (A3).
- **Permissions:** logged in, owned + editable playlist, SAPISIDHASH (A2).
- **Fit:** service composes `find`-style search (`rank`) for each song, then one edit call, then re-reads the playlist to **verify** (same verify-after-act habit as `ytmusic.js`).

| op | Class | Behaviour |
|---|---|---|
| create | additive | Only on explicit ask. Undo = delete the playlist that JARVIS created in this session (journal records it; only playlists it created, never others). |
| add | additive | Auto-run. Dedupe checked. Undoable. |
| rename | reversible | Auto-run. Undo restores old title (journal keeps it). |
| move | reversible | Auto-run. Undo moves back (journal keeps old position). |
| remove | **destructive** | **Needs confirmation** (5.6). Undo re-adds the track at its old position (journal stores videoId + position). |
| delete playlist | **destructive, irreversible** | **Not exposed in v1.** Revisit only with exact-name typed confirmation. |

### 5.4 Add a song I name — `ytm_playlist_edit` `op=add songs=[...]`
- Flow: resolve playlist → for each song `ytm.find(text,'play')` → keep `rank` results → dedupe vs cached contents → one batched `edit_playlist` → read-back verify.
- Prefer `type:'song'` (audio track) over `video` unless the user said "video"/"live"; `rank` already penalises variants.
- **Ambiguity rule (data-settled):** auto-pick when top score ≥ `SURE_SCORE` (0.75) **and** gap to second ≥ 0.15; otherwise return `ambiguous` with up to 3 candidates (title, artist, album, duration) for the model to ask. Below `MIN_SCORE` → not found.
- Return which exact version was added, so a wrong pick is visible and undoable.

### 5.5 Add the currently playing song — `ytm_add_current`
- **Inputs:** `playlist?` (omit → `defaultAddTarget`, else last used as a *suggestion*, else ask).
- **Output:** "Added 'Title' by Artist to Gym."
- **Source of truth:** existing `status().playing.videoId`; no search. Works when a YTM tab is the source. If `playing` is null → "Nothing is playing in YouTube Music" (no guessing from Windows media sessions, which lack a YTM `videoId`).
- **Fast path:** "add this to <playlist>", "save this song to <playlist>", "add this to my playlist".
- Same dedupe, verify, undo as 5.4. Skip ads/podcast episodes: if `playing.kind` is not a song/video, say so.

### 5.6 Confirmation and undo (guardrail core)
- **Confirmation lives in code, not the prompt.** A destructive call returns `blocked: needs-confirmation` with a preview ("Remove 'X' and 'Y' from Gym? 2 songs. Say yes to confirm."). The service stores `pending {opId, expires}` (60 s) and the **fast path resolves the next user utterance** ("yes"/"no"/"confirm"/"cancel"), exactly like `skill.js` `pending`. The model cannot self-confirm because the confirmation is read from the user's own message, not a tool argument.
- **Undo journal:** last 20 edits, in memory plus `<userData>/ytm-journal.json`: `{opId, at, op, playlistId, inverse}`. Fast-path intents: "undo", "undo that", "undo the last one". Undo itself is journaled so a redo is possible. Undo refuses (and says why) if the playlist changed since (position check) rather than corrupting it.
- **Bulk guard:** adds over `maxBulk`, or removes over 3, always confirm with a count.
- **Read before write, verify after write, always.** A failed verify reports failure; it never claims success.

## 6. Intelligent tool usage

1. **Choosing the tool.** Deterministic phrases hit the fast path (no model call, fast, voice-friendly). Everything else goes to the model with tight `TOOL_HINTS` lines:
   - `ytm_library`: see playlists or what's in one.
   - `ytm_play_library`: play one of *my* playlists or a track from it.
   - `ytm_playlist_edit`: create, add named songs, remove, move, rename.
   - `ytm_add_current`: "add this song".
   - Existing `youtube_music` stays for catalog play, queue, likes. Hint text states the boundary: "my playlist → ytm_* tools; any song/artist from the catalog → youtube_music".
2. **Resolving names against real data.** Playlists: alias exact → normalized title exact → `rank`-style token score over cached titles. Reuse `norm/dice` from `rank.js` (export a `matchTitle` helper rather than copying). Songs: existing search + `rank`. The word "this/it/current" binds to now-playing, "last/that" to the journal's last item.
3. **Chaining.** Tool results return the ids the next step needs (`[playlist PLxyz]`), so "make a gym playlist and add what's playing" = `ytm_playlist_edit create` → `ytm_add_current playlist=<id>`; "add X and Y then play it" = edit → `ytm_play_library`. `maxToolRounds` is 5 in the orchestrator; plans stay within it.
4. **Avoiding redundant calls.** Digest in the prompt (no list call); TTL cache; contents reused across dedupe + verify within 10 s; batched edit (one request for N songs); search result memo for 60 s keyed by query so "add X" then "play X" doesn't re-search.
5. **Clarify only when data cannot settle it.** Ask when: two playlists within 0.1 score of each other; song candidates under the 0.15 gap rule; no default target and several plausible playlists. Do **not** ask when: exact alias/title match, single clear top song, or `defaultAddTarget` set. Questions name real candidates ("Gym or Gym Cardio?").

## 7. Errors and edge cases

| Case | Detection | Behaviour |
|---|---|---|
| Playlist missing | resolver `notFound` | Offer nearest 1–3 names. For add: ask "Create it?" (never auto-create). |
| Duplicate song | cached/fresh contents contain `videoId` | Skip, say "already in Gym". `allowDuplicate:true` (user said so) adds anyway. Also send API dedupe option as second line of defence. |
| Same title, different versions | `videoId` differs but title+artist equal | Treat as possible duplicate, mention it, add only if user confirms. |
| Nothing playing | `status().playing` null or non-song | Plain message; no fallback guess. |
| Extension offline / tab closed | `link.connected` false, `noTab` | Existing wording ("not connected"); reads open a background tab. Old extension version → "reload the extension". |
| Auth expired / signed out | `LOGGED_IN` false, HTTP 401/403 | Stop, one clear message ("Sign in to YouTube Music in Chrome"). No retry loop. Writes never attempted unauthenticated. |
| Rate limit / 429 | HTTP 429 | Service-level queue: concurrency 1, min gap between calls, exponential backoff with jitter, max 3 tries, then tell the user. Batched edits and caches keep call count low. |
| Not editable (saved/auto/Liked) | `editable:false` | Refuse before calling the API; suggest creating own playlist and copying. |
| Playlist limit (5000) / unavailable track | API error / `available:false` | Report the specific reason; partial success reported per song. |
| Stale `setVideoId` | remove/move rejected | One automatic re-read and retry; then fail visibly. |
| Concurrent edit in YTM UI | read-back differs | Verify fails → report, do not claim success; journal not written. |
| Two playlists, same name | resolver sees equal scores | Disambiguate by track count and updated date. |
| InnerTube shape drift | parser returns empty/throws | Distinct error "YouTube Music changed its format"; fixtures + test pinpoint it. |

## 8. Files touched

- `extension/page.js`: add `playlists`, `playlist`, `playlist_edit`, `playlist_create` cmds, id validation, `SAPISIDHASH` helper (self-contained, no imports).
- `extension/background.js`: add read cmds to `NEEDS_TAB`; `manifest.json` version `1.1.0`; `README.md` update note.
- NEW `src/core/media/ytplaylists.js` (service), NEW `src/core/tools/ytplaylists.js` (tools).
- `src/core/media/rank.js`: export a title-match helper. `src/core/media/ytmusic.js`: expose `search` candidates + `playPlaylist`.
- `src/core/media/intent.js` + `skill.js`: library-play, add-this, undo, confirm intents (before the generic `play (.+)` rule).
- `src/core/brain/index.js` (`defaultTools`), `src/main/main.js` (construct + inject), `src/core/brain/prompt.js` (`TOOL_HINTS`, library digest line).
- `src/core/settings.js` + `config.js` (+ `settings.html/js`): `music` block.
- Tests: NEW `test/ytplaylists.test.js`, fixtures under `test/fixtures`; extend `test/settings.test.js`, `test/config.test.js`; cases in `eval/questions.json`.

## 9. Phases

Each phase ends green on `npm test` and has an explicit check.

**Phase 0 — Spike and fixtures (blocking).** Prove A2/A3 in the real tab (DevTools console or throwaway extension command): list library, read one playlist, add then remove one track in a *scratch test playlist*, rename it. Save sanitized responses to `test/fixtures/ytm-*.json`. Decide InnerTube vs Data API v3 here.
*Verify:* the 5 calls succeed with the computed auth header; fixtures committed; written note of exact endpoint/param names. *Depends on:* nothing.

**Phase 1 — Read path.** `page.js` `playlists`/`playlist` (+ continuations), service cache + normaliser + resolver, `ytm_library` tool, prompt digest, `music` config block, `NEEDS_TAB`, version bump.
*Verify:* fixture-driven unit tests for parsers/resolver/cache TTL/invalidations; live: "what playlists do I have", "what's in Gym". *Depends on:* 0.

**Phase 2 — Play.** `ytm_play_library`, fast-path "play my X playlist" ahead of the generic play rule, shuffle via existing cmd.
*Verify:* tests that "play my gym playlist" no longer reaches catalog search when a library match exists, and still does when none; live playback verified by `started`. *Depends on:* 1.

**Phase 3 — Safe writes: add, add current.** `playlist_edit add`, `ytm_add_current`, dedupe, batch, read-back verify, journal + "undo", rate-limit queue.
*Verify:* tests for dedupe, ambiguity gap rule, no-playing, 401/429 paths with a fake link; live on the scratch playlist; undo restores state exactly. *Depends on:* 1 (2 not required).

**Phase 4 — Reversible and destructive edits.** `create`, `rename`, `move`, `remove` with code-level confirmation via fast path, bulk guard, `editable` checks. Delete playlist stays unexposed.
*Verify:* tests that remove cannot run without a user-utterance confirmation (including a model attempting a second call), undo of each op, stale `setVideoId` retry. Live on scratch playlist. *Depends on:* 3.

**Phase 5 — Intelligence and polish.** Chaining checks within `maxToolRounds`, search memo, default-target learning as suggestion, settings UI, eval prompts ("add this to gym", "make a road trip playlist with X, Y, Z and play it", ambiguous names).
*Verify:* `eval/run.js` scenarios pass; tool-call counts per scenario stay at or below the budget in section 6. *Depends on:* 4.

Phases 2 and 3 are independent after Phase 1 and can be built in either order.

## 10. Risks

1. **Unofficial API drift or ToS.** InnerTube can change without notice; automated edits may violate YouTube's terms. Mitigation: fixtures, distinct "format changed" error, kill switch `music.enabled`.
2. **Auth header (A2) may be impractical** in-page, which would block all writes. Phase 0 decides before sunk cost.
3. **Account or playlist damage.** Mitigated by confirm-in-code, journal, read-before-write, scratch-playlist testing; remove is the only data-losing op in v1.
4. **Small local model misusing tools.** Mitigated by few tools, resolver in code, structured ambiguity results, eval scenarios.
5. **Fast-path regex collisions** (e.g. "add this to my playlist" vs existing queue regexes). Mitigation: ordered rules plus tests for each existing phrase in `intent.js`.
6. **Single-tab dependency** (existing limitation): reads/writes need the YTM tab and its page state.

## 10b. Phase 0 results (run 2026-11-10 in the user's real Chrome tab, throwaway playlists only, all deleted)

Verdict: **InnerTube works for everything the plan needs. A2 and A3 are confirmed. Data API v3 fallback not needed.**

| Check | Result |
|---|---|
| `SAPISID` cookie readable in-page | yes (`document.cookie`) |
| Library read `browse FEmusic_liked_playlists` | 200 with and without the header, but **without it the content is anonymous (empty library)**: sign every read (see 10c) |
| Writes with `Authorization: SAPISIDHASH <ts>_<sha1("<ts> <SAPISID> <origin>")>`, `X-Goog-AuthUser: 0` (`SESSION_INDEX`), `X-Origin` | all 200 / `STATUS_SUCCEEDED` |
| `playlist/create` (`title`, `privacyStatus: PRIVATE`, `videoIds[]`) | works, returns `playlistId` |
| `browse/edit_playlist` `ACTION_ADD_VIDEO` | works |
| Dedupe | **`DEDUPE_OPTION_CHECK` returns `STATUS_FAILED` and adds nothing (use it).** `DEDUPE_OPTION_SKIP` did **not** prevent a duplicate. Client-side dedupe from a fresh read stays primary. |
| `ACTION_SET_PLAYLIST_NAME` (`playlistName`) | works |
| `ACTION_MOVE_VIDEO_BEFORE` | needs `setVideoId` + **`movedSetVideoIdSuccessor`** (the row it should sit before). `...Predecessor` returns success but does nothing, so **always read back to verify**. |
| `ACTION_REMOVE_VIDEO` (`removedVideoId` + `setVideoId`) | works |
| `playlist/delete` | works |

Response shapes to parse (A3 corrections):
- Playlist read `browse VL<playlistId>`: rows live at `contents.twoColumnBrowseResultsRenderer.secondaryContents.sectionListRenderer.contents[].musicPlaylistShelfRenderer.contents[]`. Each row has `playlistItemData: { playlistSetVideoId, videoId }`. Edit results call the same handle `setVideoId`. Title/artist/duration are in the row's `musicResponsiveListItemRenderer.flexColumns` (same shape as search rows).
- Library list: items carry `playlistId` (`LM` = Liked Music, `SE` = Episodes for Later, `RDAMPL...` = auto radios to ignore), title in `title.runs[0].text`.
- **Eventual consistency:** a read right after create/edit can come back empty or stale. Wait ~2.5–3.5 s (or retry up to 3 times with 1 s gaps) before the read-back verify.
- Not yet checked: pagination continuation for playlists over ~100 tracks, and `editable`/owner flags in the library list. Both go in Phase 1.

Corrected script: `scripts/ytm-spike.js`.

## 10c. Phase 1 results (read path, built 2026-11-10)

Built: `playlists` and `playlist` commands in `extension/page.js` (signed header, continuation paging, owned = has `playlistEditorEndpoint` in the card menu), `src/core/media/ytplaylists.js` (cache, resolver, rate-limit retry, one call at a time, disk hint, digest), `ytm_library` tool, `music` config block, prompt hint plus digest line, `rank.matchText`. Tests: `test/ytplaylists.test.js` (32 tests); full suite 431/431.

Corrections found against the real API:
- **Personal reads DO need the signed header.** Phase 0 said otherwise: an unsigned library read returns 200 with anonymous content (no playlists). All reads in the extension now sign.
- Playlist pages hold 100 rows; continuation token is `continuationCommand.token`; continuation rows arrive in `onResponseReceivedActions[].appendContinuationItemsAction`.
- Live check on the real account: 9 library cards (1 liked, 6 owned, 2 saved), largest playlist read as 262 of 262 tracks over 3 pages, title and `editable` correct.
- Not solved: 2 library cards show no track count in their subtitle (Liked Music is one). The count is optional everywhere; the full count comes from reading the playlist.

Deployment: reload the extension (version 1.1.0) and restart JARVIS. An older extension gets "reload it in chrome://extensions".

## 10d. Phase 2 results (play, built 2026-11-10)

Built: `ytplaylists.play/pick/findTrack`, tool `ytm_play_library`, fast-path intent `library` (before the generic "play X" rule) with a "which playlist?" question that "the second one" or "yes" answers, prompt hint. No new extension command: playback reuses the existing `play` cmd with `watchEndpoint { videoId, playlistId, index }`, shuffle reuses `shuffle` after it started. Tests: 16 more in `test/ytplaylists.test.js`; suite 447/447.

Decisions in code:
- The start song is always passed as `videoId` so the extension's own check ("did that song load?") works even when it is already the current one. Unavailable songs are skipped; a playlist with only unavailable songs is "empty".
- "my X playlist" is library-only (not found = say so). A loose phrase ("play the rock playlist") tries the library first and falls back to the catalog search when nothing matches.
- A song given with `track` is matched with title and optional artist; two close matches (e.g. same title, two artists) are asked about, never guessed.
- Shuffle starts at the first song and shuffles once (YouTube Music has no lasting shuffle mode). It is skipped when a song was asked for.
- Voice: a started playlist is silent (the user hears it), text says "Playing Gym (42 songs)."

Live check (real Chrome, paused right after): starting the 3rd song of a real playlist loaded exactly that song, the queue held the playlist in order, and the selected index was 2. Not live-checked: shuffle on a long playlist, and the Chrome autoplay block (it depends on a user gesture).

## 10e. Phase 3 results (add songs, add current, undo; built 2026-11-10)

Built: extension `playlist_edit` command (version 1.2.0; allowlist of ADD_VIDEO and REMOVE_VIDEO only, ids validated, max 50 changes, signed); `ytmusic.findSong` (real songs only, audio and video of one song collapsed, auto-pick needs score ≥ 0.75 and a 0.15 gap, else a question); service `addSongs / addCurrent / addByName / undo` with dedupe, read-back verify, and an undo journal (`<userData>/ytm-undo.json`, last 20); one model tool `ytm_playlist_edit` (op add | add_current | undo, kept to one tool to save prompt tokens); fast path "add this to X", "add this song" (asks which playlist; the next thing said is the playlist), "add S to my X playlist", "undo". Tests: `test/ytplaylists-add.test.js`; suite 479/479.

Live check on a throwaway playlist (deleted): add returns the new row's `setVideoId`, which matches the row seen on read; the read shows it after about 0.8 s (the service waits 0.8 s, then retries up to 3 times at 1 s); `DEDUPE_OPTION_CHECK` refuses a duplicate with `STATUS_FAILED` and adds nothing; remove by that handle works and shows after about 0.8 s.

Behaviour decisions:
- "Added" is only said after the song is seen in the playlist. If it is not seen yet the reply says it was sent and may not show yet; the change is still journaled so it can be undone.
- Same title and artist under another video id is held back (not added) and mentioned; "allowDuplicate" (user asked for a copy) adds it.
- Undo removes only rows JARVIS added (by row handle); a copy the user added themselves, or a song already removed by hand, is never touched. Undo is itself recorded, so "undo" twice does not delete more.
- A loose phrase with no "playlist" word that names nothing ("add 5 to my total") is left to the model; with "playlist" the user is told it was not found. A short reply to "Which playlist?" is taken as the name; a longer one is treated as a new request.
- The tool-size budget matters: every tool costs prompt tokens on the 8192-token window, so the edit ops share one tool and two older tool descriptions were shortened.
- Found by tests: `RegExp.test(undefined)` tests the text "undefined", so a missing `setVideoId` passed validation; fixed with a string check.

## 11. Decisions (user, 2026-11-10)

- **"Add this" target:** the playlist the user names right after ("add this to gym"). No fixed default; `defaultAddTarget` stays empty and the last-used list is only a suggestion. If no playlist is named, ask.
- **Throwaway playlist:** approved for Phase 0 and live verification. JARVIS creates one clearly named `JARVIS TEST (delete me)`, touches only that, and removes it at the end (or reports its id).

## 12. Open questions (still open)

1. Is the target account a regular YouTube Music account (not Premium-only features, not a Brand account)? Affects `X-Goog-AuthUser` and any gating.
2. Should `delete playlist` ever be exposed? Default plan says no.
3. Preferred default when "add this" names no playlist: ask, last-used, or a fixed default? (Plan: configurable, default ask.)
4. Should adding to **Liked Music** map to the existing `like` action? (Plan: yes, route to `like`.)
5. Any playlists JARVIS must never edit (a protected list in config)? Cheap to add as `music.protected[]`.
6. OK to use a throwaway test playlist for Phase 0 and live verification?
