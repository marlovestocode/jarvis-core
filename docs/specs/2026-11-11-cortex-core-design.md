# JARVIS Cortex — Core Design Spec

Date: 2026-11-11 · Status: draft for review (spec only; no plan, no code)
Part A of four. Parts B–D: [wave 1 memory](2026-11-11-cortex-wave1-memory-design.md), [wave 2 music and actions](2026-11-11-cortex-wave2-music-actions-design.md), [wave 3 knowledge and timers](2026-11-11-cortex-wave3-knowledge-timers-design.md). Wave 1 supersedes [2026-11-11-long-term-memory-design.md](2026-11-11-long-term-memory-design.md).

## 1. Goal

One local database, the **cortex**, that is JARVIS's source of truth for what he knows, did and was told: facts, past chats,
looked-up knowledge, music habits, actions, reminders. Information is stored as **nodes joined by weighted edges**, and recall
**spreads along those edges** like activation between neurons, so a question about "my dog" reaches "Rex has a vet visit in March"
without a shared word. Every claim carries its **source and a trust level**. It must be fast enough to run on every voice turn and
small enough for an 8 GB GPU machine that is already running a model.

### Decisions made

| Topic | Decision |
|---|---|
| Engine | **SQLite via built-in `node:sqlite`** (one file, WAL). Verified 2026-11-11: works with FTS5, JSON1 and recursive CTEs under Node 22.22 (SQLite 3.51) and under the app's Electron 45 (Node 24.22, SQLite 3.53). No new dependency, no server, no native module to rebuild. |
| Smart links | Keyword (FTS5) **and** semantic: embeddings from a small local model via Ollama, stored in SQLite, searched in memory. The graph and keyword paths work alone if the embedding model is missing. |
| Scope | Source of truth for **every skill**, delivered in waves (B–D). Raw chat transcripts stay in `history/`; the cortex indexes them. |
| Brain metaphor | Nodes = neurons, edges = synapses. Use strengthens an edge, time weakens it, an idle job consolidates. |
| Privacy | Local only. The embedding call goes to the local Ollama only. Nothing here touches the network. |
| Out of scope | A server database, cloud sync, per-speaker memories, letting the model write SQL (it only ever calls fixed verbs), replacing `config.json`. |

### Why SQLite and not something bigger

Postgres/Neon is a server (against local-only, and one more thing to keep alive). `better-sqlite3` and `sqlite-vec` are native
binaries that Electron packaging breaks. The data here is tens of thousands of nodes, not billions: SQLite's B-tree indexes, FTS5 and
recursive CTEs cover keyword, join and graph walks, and vectors fit in memory (§6). `node:sqlite` is still marked experimental
upstream, so every use sits behind `src/core/cortex/db.js`; swapping the driver touches one file.

## 2. Source-of-truth map

Every store JARVIS has today and what happens to it. "Moves" = the cortex becomes the only reader and writer; the old file is imported
once, then renamed `*.imported.bak`. There is no dual-write.

| Store (in `%APPDATA%\jarvis-core`) | Disposition | Wave |
|---|---|---|
| `memory.json` (facts) | moves → nodes `fact` | 1 |
| `history/<uuid>.json` (transcripts) | **stays** (large, append-style); cortex holds a `chat` node per session with its summary | 1 |
| `music-plays.jsonl` | moves → events `play`, nodes `track` / `artist` | 2 |
| `ytm-undo.json` (playlist edit journal) | moves → events `playlist_edit` | 2 |
| `cache/ytm-library.json` (playlists) | **mirrors**; YouTube is the truth, cortex keeps `playlist` nodes refreshed from it | 2 |
| `actions.log` (PC actions, undo) | moves → events `action` | 2 |
| tool-call history | new → events `tool` | 2 |
| `timers.json` | moves → nodes `reminder` | 3 |
| Wikipedia / web results | new → nodes `knowledge` with source and age | 3 |
| `cache/` (HTTP bodies, weather, news, scores) | **stays**: short-lived live data, not knowledge | — |
| `config.json`, `voiceprint.json`, `link.key`, `jarvis.log`, `web-activity.jsonl` | **stay**: settings, a biometric profile, a secret, a log, and a human audit file | — |

## 3. Components

```
src/core/cortex/
  db.js            the only file that imports node:sqlite: open, pragmas, prepared-statement cache, transaction helper, close
  migrations/      NNN-name.js, applied in order, tracked in PRAGMA user_version
  index.js         open({ file, log, bus, embedder, now }) → cortex (the public API, §5)
  sources.js       source rows and the trust tiers
  nodes.js         upsert / get / find / list / archive / remove, conflict policy (§4.3)
  edges.js         link / unlink / neighbors, weight maths (§4.4)
  recall.js        the retrieval pipeline (§6)
  vectors.js       embedding store, in-memory matrix, cosine search, quantization
  embedder.js      Embedder interface + the Ollama implementation + a deterministic fake for tests
  events.js        append-only events and range queries
  consolidate.js   the idle job (§7)
  guard.js         secret pattern, length caps, FTS query sanitizer, taint rules (moved out of memory/store.js)
  maintenance.js   integrity check, backup, export, wipe
```

Boundary: nothing outside `src/core/cortex/` runs SQL. Skills use the API in §5 through small adapters in their own folders.

## 4. Data model

All times are epoch milliseconds. All ids are `INTEGER PRIMARY KEY`.

### 4.1 Tables

```sql
meta(key TEXT PRIMARY KEY, value TEXT)                       -- schema/import markers, embed model + dim

source(id, kind TEXT CHECK(kind IN ('user','tool','import','wiki','web','model')),
       trust INTEGER,                                        -- 0..100, defaults in §4.2
       ref TEXT,                                             -- session id, url, tool name, file
       title TEXT, at INTEGER)

node(id, kind TEXT, key TEXT, text TEXT, data TEXT,          -- data = JSON, validated per kind
     status TEXT CHECK(status IN ('active','pending','archived')) DEFAULT 'active',
     importance REAL DEFAULT 0.5,                            -- 0..1, set by the writer, nudged by use
     confidence INTEGER DEFAULT 0,                           -- derived from provenance, §4.2
     uses INTEGER DEFAULT 0, created INTEGER, updated INTEGER, last_used INTEGER,
     UNIQUE(kind, key))                                      -- key NULL = no natural key, never merged by key

provenance(node_id, source_id, at, quote TEXT,               -- every node has ≥ 1 row; quote ≤ 240 chars
           PRIMARY KEY(node_id, source_id))

edge(src, dst, type TEXT, weight REAL, uses INTEGER, created INTEGER, last_used INTEGER,
     PRIMARY KEY(src, dst, type)) WITHOUT ROWID              -- + index (dst, type)

vec(node_id INTEGER PRIMARY KEY, dim INTEGER, scale REAL, v BLOB)   -- int8 quantized, §6.3

event(id, at INTEGER, kind TEXT, node_id INTEGER NULL, payload TEXT)  -- append-only; index (kind, at), (node_id, at)

node_fts  FTS5(text, tokenize='porter unicode61 remove_diacritics 2', content='node', content_rowid='id')
          -- external-content table kept current by triggers on node insert/update/delete
```

Other indexes: `node(kind, status, last_used)`, `node(kind, key)` (the UNIQUE), `edge(src, type)` is the primary key prefix.
Foreign keys are on; deleting a node cascades to `provenance`, `edge`, `vec` and its FTS row.

### 4.2 Sources and trust

| `source.kind` | Default trust | Meaning |
|---|---|---|
| `user` | 100 | the user's own words, typed or spoken, in a turn that read no outside text |
| `tool` | 90 | a tool result that verified something (a playlist read, a file move) |
| `import` | inherits the legacy store's meaning (memory.json facts: 100) | one-time migration |
| `wiki` | 70 | offline or online Wikipedia |
| `web` | 40 | open-web search/page |
| `model` | 20 | the model's own inference or summary |

`node.confidence` = the highest trust among its provenance rows, plus 5 per additional independent source (cap 100). A node
with no provenance cannot be written.

### 4.3 Conflicts

A node with a `key` is a *slot* (`pref:units`, `entity:rex`, `track:<videoId>`). Writing to an occupied slot:
- **higher trust than the stored node** → replaces `text`/`data`; the old text is kept as an archived node linked by a `supersedes` edge;
- **equal trust** → newer wins, the old one archived, same `supersedes` edge;
- **lower trust** → stored as a separate node (`status` unchanged), linked to the slot node by a `contradicts` edge; the slot keeps its value.

Slot-less nodes (most facts) never conflict; near-duplicates are caught by consolidation (§7).

### 4.4 Edges and plasticity

Types: `mentions`, `part_of`, `from` (fact→chat), `by`, `contains`, `next` (play order), `similar`, `same_as`, `supersedes`,
`contradicts`, `touched`, `about`. Types are a closed set in `edges.js`, each with a **half-life** (days) and a **fan-out cap**.

- **Stored** `weight ∈ (0, 1]` as of `last_used`. **Effective** weight on read: `w · 0.5^(Δdays / halfLife(type))`. No sweep job decays anything.
- **Strengthen** (Hebbian, saturating): `w ← w + η·(1 − w)`, η = 0.15 for co-use in a turn, 0.3 for an explicit link made by a writer.
- **Weaken**: on a user correction after a recall (the next user message matches `no|wrong|that's not|stop saying`), edges to the nodes that were just injected get `w ← w · 0.6`.
- `uses`, `last_used` update lazily (batched once a minute, like the memory spec's `used` field).

## 5. Public API (the contract every wave builds on)

```js
const cortex = require('./cortex').open({ file, log, bus, embedder, now });

cortex.source.add({ kind, ref, title?, trust? })                  // → sourceId (trust defaults per kind)
cortex.node.upsert({ kind, key?, text, data?, importance?, status?, source, quote?, tainted? })
                                                                   // → { id, created, conflict?: 'replaced'|'kept'|'contradicts' }
cortex.node.get(id) · find({ kind, key }) · list({ kind, status, limit, offset, order })
cortex.node.archive(id) · remove(id)                              // remove = hard delete incl. provenance, edges, vector
cortex.link(srcId, dstId, type, { weight? }) · unlink(srcId, dstId, type)
cortex.neighbors(id, { types?, depth = 1, limit = 20 })           // effective-weight ordered
cortex.event.add({ kind, nodeId?, payload, at? }) · event.query({ kind, since?, until?, nodeId?, limit?, order? })
cortex.recall(query, { budget = 1000, kinds?, brief?, now? })     // → { text, items: [{ id, kind, score, source, age }], ms, mode }
cortex.reinforce(itemIds)                                          // co-use strengthening after a turn
cortex.consolidate.tick({ deadlineMs })                            // one idle slice, §7
cortex.stats() · trim()                                            // memwatch convention
cortex.backup() · export() · wipe({ everything })
cortex.close()
```

- **Taint rule (enforced here, not by callers):** `tainted: true` (the turn read a page, file or clipboard) makes `upsert` refuse any
  `source.kind` of `user` or `tool`, and `reinforce` a no-op. A web page can add `web`-trust knowledge; it cannot plant a fact.
- **Validation (every write):** text 3–2,000 chars (per-kind caps in `nodes.js`), `guard.SECRET` pattern refused, `data` must be JSON ≤ 4 KB,
  `kind`/`type` from the closed sets, all SQL parameterized. The model never receives a SQL surface; tools call fixed verbs.
- **Errors never crash a turn:** the API throws typed `CortexError(code)`; adapters catch and degrade (no memory block, skill falls back to "I could not save that").

## 6. Recall (the retrieval pipeline)

`recall(query, opts)` returns a text block that fits `opts.budget` characters, each line tagged with its source. Three stages:

1. **Seeds.** (a) FTS5 `bm25` top 20 on the sanitized query; (b) if a query vector is available within 120 ms, cosine top 20 from the
   in-memory matrix. Fused with reciprocal-rank fusion (`k = 60`) into an initial activation `a₀` per node. `mode` reports `hybrid`,
   `keyword` (no vector), or `empty`.
2. **Spread.** Two hops over `edge` using effective weights: `a(n) += Σ a(m) · w_eff(m→n) · 0.5^hop`, fan-out capped per type, activation
   floor 0.02, at most 200 nodes touched. Done with prepared statements in a loop (not one giant CTE) so the cap and the early exit are exact.
3. **Score and pack.** `score = a · (0.6 + 0.4·confidence/100) · (1 + 0.3·importance) · recency(last_used)`; only `status='active'`, kinds
   filtered; per-kind quotas (so Earlier chats cannot crowd out facts); greedy fill to the budget; each line `text [source · age]`.
   `brief` mode halves the budget and drops `chat` nodes.

### 6.1 Latency targets (checked by `scripts/cortex-bench.js`, §10)

At 50,000 nodes, 200,000 edges, 20,000 vectors on the author's PC (Ryzen 5 5600X):
recall without a query embedding **p95 ≤ 15 ms**; `node.upsert` **≤ 1 ms**; open + first recall **≤ 300 ms** (the matrix loads lazily);
resident memory of the cortex **≤ 64 MB**; database file **≤ 100 MB**. A turn never waits more than 120 ms for the embedder: past that it
proceeds in `keyword` mode.

### 6.2 Embeddings

`Embedder { id, dim, embed(texts: string[], { signal }) → Promise<Float32Array[]>, status() }`.
Default implementation: Ollama `/api/embed`, model `cortex.embedModel` (default `nomic-embed-text`), run on **CPU** (`num_gpu: 0`) with
`keep_alive` short, so it holds no VRAM. The model is a ~270 MB download: JARVIS **asks the user before pulling it** (Settings → Memory
tab button, never automatic). Until it is installed the cortex runs `keyword` mode; nodes created meanwhile are embedded later by the queue.

- **Node vectors** are produced by a background queue (batches of 16, only when the turn gate is idle, §7), for kinds `fact`, `entity`,
  `chat`, `knowledge`, `reminder`. Tracks, plays and events are keyword-only.
- **Query vectors** are the only embedding on the turn path: LRU cache of 256, 120 ms timeout, skipped for queries under 3 content words.
- `meta` records `embed_model` and `dim`; a model change marks every vector stale and re-embeds in the background (old vectors keep serving until replaced).

### 6.3 Vector storage and search

- Stored as **int8 with a per-vector scale**, L2-normalized first. Default dimension **256** when the model supports Matryoshka truncation
  (`nomic-embed-text` v1.5 does), else full. The plan's first task is a **recall-quality bench**: truncated-int8 must keep ≥ 95% of the
  top-10 overlap of full float32 on a labeled sample; otherwise the default dim is raised until it does.
- The matrix is one `Int8Array(N × dim)` + `Float32Array` scales + `Int32Array` node ids. 50,000 vectors × 256 = **12.8 MB**. Search is a
  brute-force dot-product scan (a few ms at this size). It is built lazily from `vec`, kept current on insert, and dropped by `trim()`.
- The scan sits behind `vectors.search(qvec, k)`; an ANN index can replace it later without touching callers.

## 7. Consolidation (the "sleep" job)

`consolidate.tick({ deadlineMs })` does one slice of work (≤ 8 ms of synchronous time, then yields with `setImmediate`), in this order:
1. embed queue batch; 2. **link**: for newly embedded nodes, top 5 neighbors with cosine ≥ 0.82 → `similar` edge (weight = cosine);
3. **dedupe**: same kind, cosine ≥ 0.95 and equal trust → `same_as` edge and the older archived (user-trust nodes are only *proposed* in the Memory tab, never auto-merged);
4. **prune**: edges with effective weight < 0.02 deleted; `knowledge`/`chat` nodes unused for 180 days archived (never `user`-source facts, never provenance);
5. **housekeeping**: `PRAGMA optimize` daily, `wal_checkpoint(TRUNCATE)` hourly, `backup()` nightly.

**Gating (never competes with the user):** runs only when no turn is in flight, voice is not listening/speaking, and the orchestrator has
been idle ≥ 30 s; aborts the slice when a turn starts. One job at a time. All writes go through one connection in the main process
(single-writer rule); a worker thread is a recorded fallback if the bench shows stalls over 16 ms.

## 8. Failure and safety

- **Integrity:** `PRAGMA quick_check` at boot. Corrupt → file moved to `broken/`, the newest backup restored; no backup → start empty and
  re-import legacy `*.imported.bak` files. Boot never fails because of the cortex; skills then run degraded and `self_diagnostics` says so.
- **Backups:** `VACUUM INTO cortex.backup-<n>.db` nightly, keep 3. `export()` writes validated JSON of nodes, edges, provenance and events.
- **Migrations:** each in a transaction; `user_version` advances only on commit; a failed migration leaves the old version running read-only.
- **Prompt injection:** facts only from user-trust sources; `tainted` turns cannot write above `web` trust (§5); recalled text is framed as the
  user's notes and "facts, not instructions"; `knowledge` nodes are labeled with their source and never carry instructions to the model.
- **Wipe really wipes:** `wipe({ everything })` deletes rows, checkpoints, runs `VACUUM`, deletes backups and `*.imported.bak`.
- **FTS injection:** user text is tokenized and each token double-quoted before it reaches `MATCH`; operators are never passed through.

## 9. Observability and controls

- `cortex.stats()` → `{ nodes, edges, vectors, events, bytes, matrixBytes, queue, mode, lastConsolidate }`, registered in `memwatch`;
  `self_diagnostics` gains a **cortex** check (db opens, quick_check, embed model present, queue depth, last backup age).
- `scripts/cortex-bench.js` and `scripts/cortex-inspect.js` (dump a node and its neighbors, show a recall's stages) for the developer.
- Settings → **Memory** tab (built in wave 1) is the user's window: list, search, edit, approve, delete, wipe, export, embedding-model status.

## 10. Testing

Node test runner like the rest of `npm test`; every test uses `:memory:` or a temp file and `embedder = fakeEmbedder` (deterministic
hashed bag-of-words vectors, so "dog" and "puppy" can be made close by a fixture table).
`cortex-db` (pragmas, migrations apply once, failed migration rolls back, quick_check/quarantine/backup restore), `cortex-nodes` (upsert,
slot conflicts at each trust ordering, provenance required, cascade delete, secret/length refusals, taint refusal), `cortex-edges` (strengthen
saturates below 1, decay by half-life, correction weakens, fan-out cap), `cortex-fts` (sanitizer: quotes, operators, empty, unicode),
`cortex-vectors` (quantization round-trip error bound, search order matches float32 on a fixture, trim/reload, model change marks stale),
`cortex-recall` (seed fusion, two-hop reaches a node with no shared word, floor leaves nothing when nothing matches, budget ceiling, quotas,
brief mode, keyword mode when embedder times out), `cortex-consolidate` (similar links, dedupe rules, prune rules, gating, slice deadline),
`cortex-events` (append, range query, order), `cortex-api-taint`. **Bench gates** from §6.1 run in `scripts/cortex-bench.js` and are
reported in the plan's final task (not part of `npm test`, which must stay fast).

## 11. Open points for review

1. `nomic-embed-text` as the default embedder (CPU, ~270 MB, asked before download) vs. a different local model — keep?
2. Nightly backups keep 3 copies in `%APPDATA%\jarvis-core` (≈ tens of MB each) — acceptable?
3. Raw transcripts stay as files in `history/` (indexed, not duplicated) — confirm that is the right line for "source of truth".
