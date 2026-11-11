# Cortex Wave 1 — Memory and Chats on the Cortex

Date: 2026-11-11 · Status: draft for review (spec only; no plan, no code)
Depends on [cortex core](2026-11-11-cortex-core-design.md) (API in §5). **Supersedes** [2026-11-11-long-term-memory-design.md](2026-11-11-long-term-memory-design.md):
every decision there stands (review queue, summaries, controls, gating, budgets) except storage, which is now the cortex instead of
`memory.json` v2 + `summaries.json` + a private BM25 module.

## 1. Goal

JARVIS recalls facts about the user and what was discussed in past chats, across chats, with connections: asking about Rex finds the
dog fact, the vet reminder and the chat where it came up. Inside the small model's budget, local only, fully under the user's control.

### Decisions carried from the memory spec

New memories are **auto-extracted after a chat into a review queue**, never used until approved; explicit "remember that…" saves
directly. One short **summary per chat**, indexed. A **Settings → Memory tab** is the control surface. Facts come **only from the
user's own messages**. A tainted turn cannot write memory.

### New in this wave

| Topic | Decision |
|---|---|
| Storage | cortex nodes/edges; no `memory.json` v2, no `summaries.json` |
| Retrieval | `cortex.recall` (keyword + embeddings + 2-hop spread), not a private BM25 |
| Entities | extraction also proposes **entities** (person, pet, place, project, org) that facts and chats link to |
| Raw chats | stay in `history/`; the cortex holds one `chat` node per session (summary + pointer) |

## 2. Mapping to the cortex

| Thing | Node | key | `data` | Source |
|---|---|---|---|---|
| Saved fact | `fact` | none (dedupe by consolidation) | `{ tier: 'profile'\|'note' }` | `user` (explicit) or `user` + `status:'pending'` (auto-extracted from the user's own words, quote kept) |
| Person/pet/place/project | `entity` | `entity:<normalized name>` | `{ type }` | same as the fact that introduced it |
| Past chat | `chat` | `chat:<sessionId>` | `{ sessionId, title, n, topics[] }` | `model` (summary) — the quote points at the `history` file |

Edges: `fact —mentions→ entity`, `fact —from→ chat`, `chat —mentions→ entity`, `entity —same_as→ entity` (alias, e.g. "Rex" / "my dog Rex").
`profile` facts are always eligible for the prompt; `note` facts only when recalled.
Caps from the memory spec hold: **300 active, 50 pending** facts; at the cap oldest `note` facts archive first, `profile` never auto-archives.

## 3. Import (first boot after this wave)

1. `memory.json` v1 facts → `fact` nodes, `source: import` trust 100, `tier: 'profile'`, status `active`. File renamed `memory.json.imported.bak`.
2. Chats are **not** back-filled in bulk: the scheduler (§5) summarizes ready sessions newest-first, max 5 per boot, so old chats appear over a few days.
3. `meta.import_memory = <timestamp>` makes the import idempotent; a crash mid-import re-runs from the start inside one transaction.

## 4. Recall and the prompt

Budget stays the memory spec's **1,000 characters per turn** in total.

| Part | Where | Budget | From |
|---|---|---|---|
| Profile | system prompt (stable) | ≤ 500 (brief ≤ 300) | `cortex.node.list({ kind:'fact', status:'active' })` filtered `tier:'profile'`, by `uses` then recency |
| Relevant + Earlier | end of the user message, next to the `Now:` line | ≤ 500 | `cortex.recall(query, { kinds:['fact','entity','chat'], budget:500 })` with fact and chat quotas; brief mode drops chats |

Query = the current user message; under 3 content words, append the previous user message. After the turn, `cortex.reinforce(items)` (co-use) and
a correction in the next message weakens (core §4.4). Voice turns add no model call: recall is a local read; the only embedding is the
120 ms-capped query vector (core §6.2).

**Tools** (memory skill group): `remember`, `forget_memory` keep their names, descriptions and `needsClean`; `recall_chats({ query, days? })`
(summaries first via `recall`, then a lazy scan of `history/` files for raw snippets, marked `untrusted`); new `memory_about({ topic })`
returns the topic's entity with its linked facts, chats and reminders (`cortex.neighbors`). "What do you remember about X" and "forget everything"
stay in the no-model fast path (`memory/skill.js`), now backed by the cortex; "forget everything" clears facts and pending, not summaries.

## 5. Capture

`memory/scheduler.js` and `memory/extract.js` are as in the memory spec §5 (ready sessions: ≥ 4 messages and ≥ 2 user messages; on chat switch,
10 min idle, or the startup sweep; gated like the cortex consolidation; one job at a time; strict JSON out with one retry; secrets dropped;
assistant text and tool results never a source of facts), with these changes:

- Output JSON adds `entities: [{ name, type }]`; names are normalized to `entity:` keys and linked from each extracted fact.
- Writes go through `cortex.node.upsert({ ..., source, tainted })`; the summary is a `chat` node written regardless of facts.
- Facts proposed again after a rejection are blocked by a `rejected` marker: an archived `fact` node with `data.rejected = true`, so the tombstone lives in the same store.
- One quiet tray notification per batch ("3 new things to review in Memory").

## 6. Settings → Memory tab

As in the memory spec §6 (pending with approve/reject/edit, active facts with search and filters, chat summaries, the two toggles, "Forget
everything", export/import) plus: **Connections** view of a selected fact or entity (its neighbors and why they are linked), a
**Sources** line on each item ("you said it · Nov 11" / "from chat <title>"), and an **Embedding model** row (status, "Install" button that asks before
pulling `nomic-embed-text`). The renderer never touches the database; IPC verbs `memory:list/edit/delete/approve/reject/wipe`,
`summaries:list/delete`, `memory:neighbors`, `memory:embedder` validate and length-check every payload.

## 7. Deleting

Deleting a chat (`sessions.remove`, or the 200-file prune in `session.js`) removes its `chat` node (cascading its `from`/`mentions` edges);
facts extracted from it stay and show "chat deleted". "Forget everything" calls `cortex.wipe` for kinds `fact`, `entity`, `chat` and their edges.

## 8. Testing

Core's fake embedder is used throughout. `memory-import` (v1 → nodes, idempotent, crash-safe), `memory-recall-prompt` (profile in system prompt,
relevant block at the end of the user message, ≤ 1,000 chars total, no filler when nothing matches, system prompt stable across turns with the
same profile), `memory-graph` ("Rex" question reaches the vet reminder fact through the entity with no shared word), `memory-extract` (valid JSON,
malformed + retry, secrets dropped, assistant/tool text ignored, injected "remember that…" inside a page quote not extracted, rejected not
re-proposed, entities linked), `memory-scheduler`, `memory-tools` (`recall_chats` and `memory_about` shapes, taint, caps, toggles off),
`memory-ipc` (payload validation), and prompt tests. Add recall questions to `eval/questions.json` for the live model (run only with the GPU free).
Real-app checks (Memory tab, tray notice, voice turn latency with the embedder) go into `docs/superpowers/plans/2026-11-11-cortex-wave1-checklist.md`
and are **not claimed verified**.

## 9. Out of scope

Embedding-model choice beyond the core default; per-speaker memories; remembering file, clipboard or page contents; changing what web tools send out.
