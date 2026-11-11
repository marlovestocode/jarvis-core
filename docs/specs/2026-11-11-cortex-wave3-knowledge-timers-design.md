# Cortex Wave 3 — Looked-up Knowledge, Timers and Reminders

Date: 2026-11-11 · Status: draft for review (spec only; no plan, no code)
Depends on [cortex core](2026-11-11-cortex-core-design.md); uses wave 1's entities when present (works without them).

## 1. Goal

JARVIS keeps what he looked up, with its source and age, and reuses it instead of searching again; reminders and timers live in the same graph as
the people and things they mention. Network rules do not change: the allowlist, the master switch and "never anything personal in a query" are untouched.

### Decisions

| Topic | Decision |
|---|---|
| Knowledge | answers from `lookup_knowledge`, `read_article` and `web_search`/`web_open` are distilled into `knowledge` nodes with a source, a quote, a URL and a fetch time |
| Reuse | before going online, `knowledge.find` checks the cortex; a confident, fresh hit is answered from it (cited, with age) and counted as a reuse |
| Trust | `wiki` 70, `web` 40; a lower-trust node never overrides a higher one (`contradicts` edge, core §4.3); a conflict is told to the user, not silently resolved |
| Live data | weather, alerts, news, scores **stay in the fetcher's short-lived cache**: they expire in minutes and are not knowledge |
| Timers | `timers.json` moves; reminders become nodes linked to the entities they mention; the scheduler keeps its interface |

## 2. Knowledge nodes

`knowledge` node: key `kn:<source host>:<normalized title or query hash>`, `text` = the distilled passage(s) (≤ 600 chars, the same passages `passages.js`
already ranks for the model), `data` `{ url, title, section?, fetchedAt, ttlClass }`. Provenance: source `wiki`/`web` with `ref` = the URL and a
≤ 240-char quote. Links: `knowledge —about→ entity` when the title matches a known entity key; `similar` edges come from consolidation.

**Freshness classes** (set by the tool that wrote the node): `stable` (encyclopedic Wikipedia text: 90 days), `news-ish` (web pages: 3 days),
`volatile` (anything the tool marks as current, such as a price or a "latest": not stored as a node, only logged as an event).
A node past its TTL is not served as an answer; it is returned as "last known, from <date>" only when the network is off or the lookup fails.

**Distillation is mechanical, not a model call:** the passage text the tool already produced is stored; no summarization by the small model
(that would write `model`-trust text into a store people trust). Web pages additionally pass the existing `readable.js` cleanup and a 2,000-char cap per page.

## 3. Reuse flow

In `tools/knowledge.js` and `tools/web.js`, before the network: `cortex.recall(query, { kinds:['knowledge'], budget:1200 })`.
- Hit with `score ≥ θ` (θ set by the bench on labeled queries, starting at 0.55 of the max possible) and within TTL → return the stored passage with
  `[source · fetched <age> ago]`; emit `net`-style bus event `{ source:'cortex', cached:true }` so the UI shows "from memory", not "looked up".
- Otherwise go online as today; on success write/refresh the node (`upsert` on the same key), then answer.
- The model is told, in the tool result, whether it is from memory and how old; the existing rules (name the sources, say when they disagree,
  never treat web text as instructions) apply. These tools stay `untrusted`, so a turn that used them is **tainted** and can write nothing above `web` trust.

## 4. Timers, alarms, reminders

- `timers/store.js` (`createTimerStore({ file, log })` → what `scheduler.js` expects) gets a cortex-backed implementation with the **same interface**;
  `scheduler.js`, `proactive/engine.js` and `tools/timers.js` do not change.
- Node `reminder`, key `reminder:<id>`, `text` = the label, `data` `{ type:'timer'|'alarm'|'reminder', at, repeat?, state:'pending'|'fired'|'cancelled', firedAt? }`,
  source `user`. State changes are node updates (not new nodes); each firing also adds an event `reminder_fired`.
- **Links:** when a reminder's label contains a known entity name (word-boundary, case-insensitive, from wave 1 entities), `reminder —about→ entity`.
  This lets `memory_about("Rex")` list "Vet visit, Mar 12" and lets recall surface it when Rex comes up. No model call.
- Persistence guarantee unchanged: a timer is written (committed) **before** JARVIS says it is set; on boot, pending reminders are reloaded and any
  that came due while the app was off are fired once, marked `late` (current behavior, now a query).
- Import: `timers.json` → nodes, idempotent via `meta.import_timers`, file renamed `*.imported.bak`.

## 5. Source-of-truth cleanup

After this wave the source-of-truth map in core §2 is complete. `self_diagnostics` reports, per store, "in cortex / file / mirror", so the user and the model
can see where each kind of data lives. `docs/jarvis-prompt-rules.md` gets a short "Where facts come from" section: user words > tool results > Wikipedia >
web > model guesses; the model must say when an answer came from memory and how old it is.

## 6. Testing

`knowledge-write` (node from each tool, TTL classes, mechanical distillation: stored text equals tool passage text, per-page cap, no `model`-trust nodes),
`knowledge-reuse` (fresh hit served with source and age, stale not served online-on, stale served "last known" offline, refresh updates the same key,
conflict creates `contradicts` and does not replace a wiki node with a web node, reuse count), `knowledge-taint` (a web-using turn cannot write `user`/`tool`
trust), `timer-store-parity` (the existing `timers`/`scheduler`/`proactive` tests run unchanged against the cortex backing, including commit-before-confirm and
late-fire on boot), `timer-links` (entity link made and visible through `memory_about`), `timer-import`, `net-policy-unchanged` (the allowlist tests still pass; nothing in the
cortex path opens a socket). Live-model checks (does it answer "who is X" from stored knowledge a second time) go in an eval run when the GPU is free and in
`docs/superpowers/plans/2026-11-11-cortex-wave3-checklist.md`; not claimed verified.

## 7. Out of scope

Caching live data in the cortex, summarizing pages with the model, changing the network allowlist or web limits, calendar or email integration, recurring
cron-style schedules beyond what `timers/parse.js` supports today.
