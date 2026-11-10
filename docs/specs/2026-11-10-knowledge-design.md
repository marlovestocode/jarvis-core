# JARVIS Knowledge & Live Data — Design Spec

Date: 2026-11-10 · Status: draft for review

## 1. Goal

Give JARVIS real-time information about the user's area and the world, and a deep
offline reference library, so it can answer broad questions with facts it looked up
instead of guessing from a 4B model's memory.

### Decisions made

| Topic | Decision |
|---|---|
| Online access | **Allowlisted lookups only.** Named keyless sources; only the lookup leaves the PC (a place, a search term), never chat history. One master switch turns all online access off. |
| Offline library | **Wikipedia full text** (`wikipedia_en_all_nopic`, ~49 GB, Kiwix ZIM), searched locally, cited by article. |
| Live data | Weather + NWS alerts, news headlines (RSS), sports scores/schedules. |
| Location | Default Abilene, TX (32.4487, −99.7331, °F), same as the wallpaper; changeable in settings. |
| Not in scope | Open web search, accounts/API keys, markets, anything that posts or writes online. |

### Why

The model is small and its knowledge is frozen. Tools already made math exact; this
does the same for facts: **look it up, then answer, with the source and time.**

## 2. Architecture

```
src/core/net/
  policy.js        allowlist + master switch + per-source toggles; the ONLY way core code reaches the internet
  fetcher.js       fetch wrapper: allowlist check, timeout, UA, retries, TTL cache (memory + disk), 'net' bus events
src/core/knowledge/
  location.js      config location, geocoding (Open-Meteo) for "weather in Dallas"
  weather.js       Open-Meteo current/hourly/7-day + air quality; NWS alerts (US)
  news.js          RSS/Atom reader for configured feeds; dedupe; topic filter
  sports.js        ESPN public scoreboard/schedule JSON for followed teams/leagues
  wiki-offline.js  kiwix-serve on 127.0.0.1: search → article → passages
  wiki-online.js   Wikipedia REST (summary/search) — fallback when offline library is missing or the topic is newer
  passages.js      HTML → clean text → sections → BM25 ranking → top passages with citation
src/core/tools/knowledge.js   model tools (see §4)
```

The knowledge library lives in `C:\JarvisData\library` (not `%LOCALAPPDATA%`: writes there from
inside a packaged app are virtualized and invisible to the real desktop — learned 2026-11-10).
`kiwix-serve.exe` (kiwix-tools 3.8.1, win-x86_64) is started by jarvis-core on `127.0.0.1:47820`.

## 3. Network policy (hard rules)

- Allowlist (exact hosts): `api.open-meteo.com`, `geocoding-api.open-meteo.com`,
  `air-quality-api.open-meteo.com`, `api.weather.gov`, `en.wikipedia.org`,
  `site.api.espn.com`, and the hosts of the configured RSS feeds (defaults:
  `feeds.bbci.co.uk`, `feeds.npr.org`, `feeds.arstechnica.com`, `www.sciencedaily.com`).
  Adding a feed in settings adds its host. Everything else is refused before any socket opens.
- HTTPS only; no redirects to non-allowlisted hosts; GET only; 8 s timeout; responses capped (2 MB).
- Requests carry only what the lookup needs (coordinates, a search term, a team). Never chat text,
  history, user name or email. User-Agent: `JARVIS-core/0.x (local assistant)`.
- `config.online.enabled = false` → every online tool answers "online lookups are off" and the
  model falls back to the offline library / its own knowledge. Per-source toggles too.
- Every lookup emits `net {source, host, ok, ms, cached}` → visible in the chat (small "looked up"
  line) and as a lattice limb on the wallpaper (WEATHER, NEWS, SPORTS, WIKI).
- Cache: weather 10 min, alerts 5 min, news 15 min, sports 2 min (live games) / 30 min, wiki 7 days.
  Disk cache in `%APPDATA%\jarvis-core\cache` lets JARVIS answer "last known" when offline (marked as such).

## 4. Tools for the model

| Tool | Args | Returns |
|---|---|---|
| `get_weather` | `place?`, `days?` (1–7), `hourly?` | current conditions, today/tomorrow highs/lows, rain chance, wind, UV, AQI; source + time |
| `weather_alerts` | `place?` | active NWS watches/warnings (US) with severity, expiry |
| `news_headlines` | `topic?`, `count?` | latest headlines (title, source, time, 1-line summary, link) |
| `sports_scores` | `team?`, `league?` | live/final scores, next game, standings line when available |
| `lookup_knowledge` | `query` | top 3–5 passages from offline Wikipedia (title, section, text), else online Wikipedia summary |
| `read_article` | `title`, `section?` | a longer extract of one article (for follow-ups) |

Routing: weather/news/sports/"who/what/when/where/why/explain" questions route to the main
model with tools. The system prompt adds: *for facts about the world, call `lookup_knowledge`
first; for anything current, use the live tools; always name the source and how recent it is;
never invent dates, scores, temperatures or quotes.*

## 5. Retrieval (offline Wikipedia)

1. `kiwix-serve --address 127.0.0.1 --port 47820 <zim>`; full-text search:
   `GET /search?books.name=<book>&pattern=<q>&pageLength=8` (HTML results).
2. Fetch the top 3–5 articles (`/content/<book>/A/<Title>`), strip HTML to text with section headings.
3. Split into passages (~120–200 words, section-aware), rank with BM25 against the query
   (+ title boost), return the best 3–5 with `[Title › Section]` citations, total ≤ 2,500 chars
   so the 8k context keeps room.
4. Query rewriting: the model's query is used as is; one retry with key nouns only if the
   first search returns nothing.

## 6. UI

- **Settings → Knowledge:** online master switch; per-source toggles; location (city search via
  geocoding, units °F/°C); news feeds list (add/remove URL); followed teams (league + team);
  library status (path, size, article count, kiwix-serve state).
- **Chat:** a small line under replies that used lookups: "Looked up: Open-Meteo 2 min ago · Wikipedia (offline)".
- **Wallpaper:** limbs WEATHER / NEWS / SPORTS / WIKI; the existing weather panel is unchanged.

## 7. Errors

| Case | Behavior |
|---|---|
| Offline / source down | tool returns cached data marked "last known at …", else a clear error; the model says it could not check |
| Online switch off | live tools refuse with "online lookups are off" |
| Library missing / kiwix not running | `lookup_knowledge` uses online Wikipedia if allowed, else says the library is not installed |
| Unknown place | geocoding returns candidates; tool asks which one |
| Non-US weather alerts | "alerts are only available for the US" |

## 8. Testing

- Unit (node --test, fake fetch): policy refuses non-allowlisted hosts/redirects/HTTP; cache TTLs;
  each source parser on recorded fixtures (Open-Meteo, NWS, RSS, Atom, ESPN, kiwix search HTML,
  article HTML); passages ranking; tools' text output; router sends weather/news/sports/fact
  questions to tools; master switch.
- Live smoke (manual script, not in npm test): one real call per source.
- Eval: extend `eval/questions.json` with offline-fact questions (graded) and live questions
  (graded on tool use + plausibility).
- Real-app check from outside the sandbox (Task Scheduler run): ask weather by voice and text.

## 9. Build order

1. Net policy + fetcher + cache. 2. Location + weather + alerts. 3. News. 4. Sports.
5. Online Wikipedia. 6. Offline library (download, kiwix-serve, retrieval). 7. Tools + router + prompt.
8. Settings UI + chat "looked up" line + wallpaper limbs. 9. Eval + real-app checks.
