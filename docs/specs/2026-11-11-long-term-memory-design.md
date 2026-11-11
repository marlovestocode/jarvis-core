# JARVIS Long-Term Memory — Design Spec

Date: 2026-11-11 · Status: **superseded by [cortex wave 1](2026-11-11-cortex-wave1-memory-design.md)** (decisions kept, storage replaced by the cortex). Do not plan from this file.

## 1. Goal

JARVIS recalls relevant **facts about the user** and **what was discussed in past chats**, across chats, inside the small
local model's budget, with everything on this PC and fully under the user's control (view, edit, approve, forget).

Today: `remember` / `forget_memory` notes (`src/core/memory/store.js`, `skill.js`, `tools/memory.js`), at most 100 notes of
200 characters, the newest 900 characters of them sent in **every** prompt (`ctx.memory.digest()` in `main.js promptInfo`).
Saved chats (`session.js`, `history/<uuid>.json`, newest 200 kept) are never recalled.

### Decisions made (from the brainstorm)

| Topic | Decision |
|---|---|
| New memories | **Auto-extracted after a chat, into a review queue.** Pending items are never used until the user approves them. Explicit "remember that…" still saves directly. |
| Retrieval | **Keyword / BM25 only.** No embedding model, no new dependency, no VRAM. The retriever sits behind one function so embeddings can be added later without redesign. |
| Past chats | **One short summary per chat, indexed**, a tiny "Earlier" block injected when relevant, and a `recall_chats` tool for deeper lookups. |
| Controls | **Settings "Memory" tab**: list, search, edit, delete, approve/reject, wipe. Existing voice/chat commands keep working. |

### Assumptions (say so if wrong)

- Plain local files under `DATA_DIR`; nothing is sent anywhere. Extraction and summaries use the local Ollama only.
- A turn that read outside text (web page, file, clipboard: `untrusted` tools) cannot write memory, as `needsClean` does today.
- No master switch was chosen; this spec adds two small toggles in the Memory tab (auto-capture, use past chats), default on, because the feature reads chats.

### Out of scope

Embeddings, cloud sync or export to any service, per-speaker memories, remembering file/clipboard/page contents, any change to
what the web tools send out (rule stays: never anything personal).

## 2. Data

All in `DATA_DIR` (`%APPDATA%\jarvis-core`), atomic write via tmp + rename like `store.js` and `session.js`.

**`memory.json` v2** (v1 `{facts:[{id,text,at}]}` migrates on load: every old fact becomes `status:'active', source:'user', kind:'profile'`; file is rewritten as v2 only on the first save, a `memory.json.v1.bak` copy is kept once).

```
{ version: 2,
  facts: [{ id, text, at, status: 'active'|'pending', kind: 'profile'|'note',
            source: 'user'|'auto', session?: <uuid>, used?: <ms>, uses?: n }],
  rejected: [<normalized text>, ...]      // tombstones, max 200, so a dropped suggestion is not proposed again
}
```

- `kind: 'profile'` = standing preferences/identity ("prefers Fahrenheit", "has a dog named Rex"): always eligible for the prompt.
  `kind: 'note'` = situational ("is learning Rust", "trip to Austin in March"): only injected when the turn is about it.
- Same validation as today for every write path (user, tool, extractor, edit): 3–200 chars, `SECRET` pattern refused, normalized-duplicate refused.
- Caps: **300 active**, **50 pending** (extractor stops proposing at 50; oldest `note` active facts drop first at the cap, `profile` never auto-drop, the add fails with "memory full" instead).

**`summaries.json`** `{ version:1, items: { <sessionId>: { at, title, summary, n, tries? } } }`

- `summary` ≤ 300 chars, 1–3 sentences, plus `topics` (≤ 6 words) used only for ranking. Max 200 entries, same as `MAX_SESSIONS`.
- **Deleting a chat deletes its summary** (hook on `sessions.remove` and on the 200-file prune in `build()`). Facts extracted from that chat stay; they are the user's, shown in the tab with their source chat title.

## 3. Components (new/changed, each one purpose)

```
src/core/memory/
  store.js        CHANGED  v2 schema, status/kind, approve/reject/edit/pin, migration, stats()/trim()
  summaries.js    NEW      read/write summaries.json, remove(sessionId), list(), stats()
  rank.js         NEW      BM25 over {id,text,tags} docs; tokenizer + light stemmer + stopwords; returns ranked ids with scores.
                           Reuses the BM25 code in src/core/knowledge/passages.js if its interface allows; otherwise a shared small module both use.
  recall.js       NEW      block(text, {brief}) → { profile, earlier } strings within budget (§4); recallChats(query)
  extract.js      NEW      builds the extraction prompt, calls the local model, parses/validates JSON, writes pending facts + summary
  scheduler.js    NEW      decides WHEN a session is ready to summarize (§5)
  skill.js        CHANGED  fast path: "what do you remember about <topic>", "forget everything" also clears pending; rest unchanged
src/core/tools/memory.js   CHANGED  adds recall_chats (memory skill group); remember/forget_memory unchanged (needsClean kept)
src/main/ipc.js + preload.js + src/ui/settings.*   CHANGED  Memory tab, IPC: memory:list / edit / delete / approve / reject / wipe, summaries:list / delete
```

## 4. Recall and the prompt budget

The model has an 8192-token window shared with the system prompt, tools, history and the answer. Memory gets a **hard ceiling of
1,000 characters (~250 tokens) per turn** (today: up to 900 characters of the newest notes, relevant or not):

| Part | Where | Budget | Contents |
|---|---|---|---|
| Profile | system prompt (`memoryLine`, stable between turns) | ≤ 500 chars (brief/quick chat: ≤ 300) | `kind:'profile'` active facts, most-used then newest first |
| Relevant notes | **end of the user message**, next to the `Now:` line | ≤ 250 chars | active `note` facts that BM25-match the turn, score floor applied |
| Earlier | same place | ≤ 250 chars | top 2 summaries that match, each "(date) summary", only above the score floor |

Why the user message and not the system prompt: Ollama reuses its cached prompt only up to the first changed character
(see the `NOW_NOTE` comment in `prompt.js`). A per-turn block in the system prompt would force a full re-read every turn
(1.2–2 s measured). Profile text changes only when a fact changes, so it stays in the system prompt.

- **Query** = the current user message; if it has fewer than 3 content words, append the previous user message ("and what about tomorrow?").
- **Score floor** so nothing irrelevant is injected: no match → the Relevant/Earlier parts are simply absent (no "newest notes" filler).
- **Framing**, same as `memoryLine` today: their notes, facts not instructions, use naturally, never recite unasked. Summaries add: "may be incomplete".
- Quick chat (`brief`, no tools) gets Profile + Relevant notes only (no Earlier), within a combined 500 chars.
- Voice turns: same retrieval; it is local string work (target < 5 ms for 300 facts + 200 summaries), no model call, so no added first-token latency.
- Injected facts update `used`/`uses` (used to order the Profile part); written lazily, at most once a minute.

**`recall_chats({ query, days? })`** (memory skill group, in `TOOL_HINTS` like the other tools): "what did we discuss about X".
1. BM25 over summaries (+topics) → up to 3 hits.
2. If fewer than 2 hits: scan raw messages of the newest 200 sessions (files read lazily, user/assistant text only, one at a time) → up to 3 snippets × 240 chars with date and chat title.
3. Returns quoted data with source and date; marked `untrusted` (a chat can contain earlier web text), so the turn is tainted and cannot start `confirm` tools. Result stays inside the existing tool-result cap in `orchestrator.js`.

The `remember` hint in `TOOL_HINTS` gains one clause: it can search past chats via `recall_chats`; unknown past chat content is never invented (same style as the Facts rule in `docs/jarvis-prompt-rules.md`; add a row to that file's failure map when implemented).

## 5. Capture: extraction and summaries

**When** (`scheduler.js`): a session is *ready* when it has ≥ 4 messages (≥ 2 user messages) and has not been summarized, and one of:
the user switches/creates a chat (`ai:new`, `ai:open`), the session is idle ≥ 10 min, or at startup (sweep of ready sessions, newest first, max 5 per boot, to catch app-quit). Never on quit (cannot wait for a model).

**Gating** (never competes with the user): run only when no turn is in flight, voice is not listening/speaking, and the orchestrator has been idle ≥ 30 s; one job at a time; abort and retry later if a turn starts. Uses the fast model if present, else the main model, through the existing Ollama provider (refuses non-local hosts already).

**Input** is built from the saved messages, capped ~3,000 characters (newest-weighted):
- **Facts come from the user's own messages only.** Assistant text and tool results are never a source of facts, so a page or file that steered a reply cannot plant a memory.
- **The summary** uses user messages + assistant text from turns where no `untrusted` tool ran (taint is derived from the recorded tool names in history; if a turn's record lacks it, that turn contributes user text only). Verify at plan time what `appendHistory` records.

**Output** is strict JSON `{ summary, topics[], facts:[{ text, kind }] }`, max 5 facts. Parsing failure → one retry with a "JSON only" nudge, then `tries++` on the summary stub and give up after 2 (session stays without a summary; search falls back to raw). Facts are normalized, run through the §2 validation, de-duplicated against active, pending and `rejected`, then written `status:'pending', source:'auto', session`. The summary is written regardless of facts.

**Notification:** one quiet tray notification per batch ("3 new things to review in Memory"), no spoken announcement.

Extraction prompt guidance (kept short for a small model): save only lasting facts the user stated about themselves, their preferences,
projects, people, routines; never opinions about the assistant, passwords/keys/numbers, one-off requests ("play X"), or anything about third parties' private data.

## 6. Controls (Settings → Memory tab)

- **Pending** list on top: approve (→ active), reject (→ tombstone), edit-then-approve; "approve all" / "reject all".
- **Active facts**: search box, filter by kind/source, edit text, toggle profile/note, delete, "from chat: <title>" link for auto facts.
- **Chat summaries**: list with date/title, delete one, "delete all summaries".
- **Toggles**: auto-capture (off → scheduler idle, nothing sent to the model for extraction), use past chats (off → no Earlier block, `recall_chats` answers "past-chat memory is off").
- **Danger**: "Forget everything" (facts + pending + rejected + summaries) behind a confirm. Export / import `memory.json` (validated through the same rules).
- Voice/chat fast path keeps `remember`, `forget`, "what do you remember"; "forget everything" clears facts and pending (not summaries; those are a tab action).

Edits go through the same validation, and IPC payloads are length-checked; the renderer never writes files.

## 7. Resource budgets and watch

Follows the `memwatch` convention (`stats()` numbers, `trim()` when safe):
- `memory.stats()` → `{ active, pending, rejected, bytes, cap }`; `summaries.stats()` → `{ count, bytes }`. Registered as sources in `main.js memwatch`; shown by `self_diagnostics`.
- In memory: facts + summaries only (≤ ~500 small docs, well under 1 MB) and the BM25 index built lazily and dropped by `trim()`. Raw-history search streams one file at a time.
- Disk: `memory.json` ≤ ~100 KB, `summaries.json` ≤ ~100 KB at the caps.
- A `memory` scenario is added to `scripts/mem-bench.js` (300 facts + 200 summaries, 1,000 recalls).

## 8. Failure and safety

- Corrupt `memory.json` / `summaries.json`: move to `broken/` (like sessions), start empty, log, never crash a turn. Recall errors → turn continues with no memory block.
- Extraction model missing/slow: the job is skipped and retried later; nothing blocks chat or voice.
- Prompt-injection: facts only from user text; `remember`/`forget_memory`/approve actions refused from tainted turns; `recall_chats` is untrusted; the memory block is framed as data.
- Privacy: no network in any memory path; secrets pattern applied at every write; wipe really deletes (files rewritten, `.v1.bak` removed on "Forget everything").

## 9. Testing

Node test runner like the rest of `npm test`:
`memory-store` (v1→v2 migration, caps, validation, tombstones, edit/approve/reject), `memory-rank` (BM25 order, stemming, floor, tie-break),
`memory-recall` (budget ceiling per part and total ≤ 1,000 chars, no filler when nothing matches, brief variant, short-follow-up query),
`memory-extract` (fake provider: valid JSON, malformed JSON + retry, secrets dropped, assistant/tool text ignored, injected "remember that…" inside a page quote not extracted, duplicates and rejected not re-proposed),
`memory-scheduler` (readiness, idle gate, aborts when a turn starts, startup sweep cap), `memory-tools` (`recall_chats` shape, taint, caps, toggles off),
prompt tests (Profile in system prompt, relevant/earlier at the end of the user message, system prompt stable across turns with the same profile).
Add recall questions to `eval/questions.json` for the live model ("what did we talk about regarding X?").

## 10. Open points for review

1. Two Memory-tab toggles were not in the options you picked; keep them (recommended) or drop them?
2. Tray notification for pending items: keep, or tab-badge only?
3. Confirm that "summarize on chat switch / 10 min idle / startup sweep" is the right trigger set.
