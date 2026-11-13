# Lyrics skill

**Goal.** JARVIS gets accurate lyrics fast, for the song playing or a named song, and can find a song from a remembered line or give the line after it. Personal use on this PC: lyrics are shown in the chat and cached locally, never republished.

**Scope (agreed).** Current and named songs, plus reverse lookup ("what song goes ...", "what is the next line ..."). No synced/live view.

## Sources
- **LRCLIB** (`lrclib.net`, no key): the lyrics. Looked up by title, artist, album and duration (`/api/get`), then `/api/search`. Each candidate is scored against the request; a weak match is refused, never guessed.
- **Genius API** (`api.genius.com`, free client access token): reverse lookup only. Its search matches lyric snippets and returns title and artist. Lyrics are never read from Genius pages (scraping is against its terms).
- Both go through the existing allowlisted fetcher (`net/fetcher.js`, new source `lyrics`, switch `online.lyrics`): GET only, 8 s timeout, size cap, 30-day disk cache for lyrics, 7-day for searches. The token is sent only to `api.genius.com`, as an `Authorization` header, and is read from `JARVIS_GENIUS_TOKEN` or `<data>/genius.token`.

## Units
- `core/lyrics/match.js` title cleanup, candidate scoring, phrase check, line-after.
- `core/lyrics/lrclib.js`, `core/lyrics/genius.js` one API each.
- `core/lyrics/service.js` `get`, `current`, `byLyric`, `nextLine`; picks the playing song from YouTube Music (then Windows media).
- `core/lyrics/intent.js` + `core/lyrics/skill.js` fast path, no model: the chat shows the full text, the voice says one short line.
- `core/tools/lyrics.js` + `core/skills/lyrics` two small model tools for phrasings the fast path misses (results capped, wrapped as quoted source data).

## Accuracy rules
- A song counts as matched only when title and artist score well; duration breaks ties between versions.
- Reverse lookup: a Genius candidate counts only if the user's words really appear in its LRCLIB lyrics (word-window check). Otherwise JARVIS says it cannot confirm.
- Instrumentals are reported as instrumentals. Nothing is ever filled in from model memory.

## Errors
No token: lyrics by name work, reverse lookup says it needs the token. Offline or `online.lyrics` off: cached songs only, otherwise a plain refusal.

## Tests
Fake fetcher: scoring and title cleanup, exact and search paths, 404, instrumental, phrase and line-after, reverse lookup verified and unverified, no-token, intent parsing, skill replies.
