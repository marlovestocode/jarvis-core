# Cortex Core (Part A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/core/cortex/`: one local SQLite brain (nodes, weighted edges, provenance, events, int8 vectors, spreading-activation recall, idle consolidation) with the public API of core spec §5, proven by `npm test` and by the bench gates of §6.1.

**Architecture:** `db.js` is the only file that imports `node:sqlite`; every other module receives a `db` handle (prepared-statement cache + `tx()`), never raw SQL from outside `src/core/cortex/`. `index.js` `open()` assembles sources, nodes, edges, events, vectors, recall, consolidate and maintenance into one object. Nothing in this stage touches `main.js` or any skill: wiring starts in wave 1.

**Tech Stack:** Node `node:sqlite` (`DatabaseSync`, FTS5, JSON1, recursive CTEs), Node test runner (`npm test` = `node --test "test/**/*.test.js"`), typed arrays for vectors, Ollama `/api/embed` behind an injected `fetch`.

**Spec:** [docs/specs/2026-11-11-cortex-core-design.md](../../specs/2026-11-11-cortex-core-design.md) (cited as §n below).

## Global Constraints

- No new dependency. Only `src/core/cortex/db.js` may `require('node:sqlite')` (§1, §3). A test enforces it (Task 1).
- Nothing outside `src/core/cortex/` runs SQL; the model never gets a SQL surface (§3, §5).
- All times epoch ms; all ids `INTEGER PRIMARY KEY` (§4).
- Every write: text 3–2,000 chars (per-kind caps below), `guard.SECRET` refused, `data` JSON ≤ 4 KB, `kind`/`type` from closed sets, all SQL parameterized (§5).
- Taint rule enforced inside the cortex: `tainted: true` → `upsert` refuses source kind `user`/`tool`; `reinforce` is a no-op (§5).
- Errors are `CortexError(code)`; nothing in the cortex crashes the process; open never throws for a corrupt file (§5, §8).
- The embedder talks only to the configured local Ollama host; tests use the fake embedder only. **No model download** in this stage without the user's yes (`nomic-embed-text`, ~270 MB).
- Bench gates (§6.1), at 50,000 nodes / 200,000 edges / 20,000 vectors: recall p95 ≤ 15 ms without query embedding; `node.upsert` ≤ 1 ms; open + first recall ≤ 300 ms; cortex resident memory ≤ 64 MB; db file ≤ 100 MB. Turn never waits > 120 ms for the embedder.
- Vector default: int8 + per-vector scale, L2-normalized, dim 256; must keep ≥ 95% top-10 overlap with full float32 (§6.3).
- Consolidation slice ≤ 8 ms synchronous, then yield (§7).
- Repo is LF. Stage by explicit path only; never stage files this plan does not list (the tree carries someone else's uncommitted work).
- One commit per task; `npm test` green after each (baseline 892).

## Decisions this plan makes where the spec is silent (approve or change)

| # | Gap in the spec | Plan's choice |
|---|---|---|
| D1 | `wipe({ everything })` cannot do wave 1's "wipe kinds fact, entity, chat" | `wipe({ kinds?: string[], everything?: boolean })`; `everything` also deletes backups and `*.imported.bak` |
| D2 | §4.4 "weaken on a user correction" has no API verb | add `cortex.weaken(itemIds)` (`w ← w·0.6` on edges touching those nodes); the regex check (`no|wrong|that's not|stop saying`) is exported as `cortex.isCorrection(text)` and called by wave 1 |
| D3 | Lower-trust write to an occupied slot must become a "separate node", but `UNIQUE(kind,key)` forbids a second row with that key | the separate node gets `key = NULL` and `data._slot = <key>`, plus the `contradicts` edge to the slot node |
| D4 | "Higher trust than the stored node": trust of what? | the slot node's **highest provenance trust** (not `confidence`, which carries the +5 bonus) |
| D5 | "+5 per additional *independent* source" | independent = distinct `(source.kind, source.ref)` pair |
| D6 | `recency(last_used)` is not defined | `recency = 0.5 + 0.5 · 0.5^(days since (last_used ?? updated) / 30)` |
| D7 | Per-kind quotas have no numbers | with ≥ 2 kinds having candidates, one kind may fill at most 60% of the budget; leftover is released after every kind is exhausted. `opts.quotas = { kind: fraction }` overrides (wave 1 passes its own) |
| D8 | Edge half-lives and fan-out caps are not listed (only `next` = 90 d, in wave 2) | table in Task 4 |
| D9 | Closed node and event kinds | nodes: `fact, entity, chat, knowledge, reminder, track, artist, playlist, file, folder` (every kind any wave names, so waves need no migration); events: `play, action, playlist_edit, tool, reminder_fired, lookup` |
| D10 | Per-kind text caps | fact 300, entity 120, chat 1,200, knowledge 2,000, reminder 200, track/artist/playlist 300, file/folder 600 |
| D11 | `nomic-embed-text` needs task prefixes | `embed(texts, { signal, role: 'doc'|'query' })`; the Ollama embedder prepends `search_document: ` / `search_query: `; truncation to `dim` is client-side (first `dim` floats, then re-normalize) |
| D12 | `recall` must wait up to 120 ms for a query vector | `recall()` is `async`; without an embedder (or under 3 content words) it never awaits anything slow |
| D13 | Gating signals live in the orchestrator/voice (not built here) | `consolidate.tick({ deadlineMs, isIdle })`: `isIdle()` is injected; wave 1 wires it. Also `open({ isIdle })` default `() => true` for tests only |
| D14 | memwatch registration and the `self_diagnostics` cortex check need `main.js`, which has someone else's uncommitted edits | **deferred to wave 1** (first wiring stage). Core exports `stats()`, `trim()`, `health()` ready for it |
| D15 | Re-import after a corrupt file with no backup | core only sets `meta.recovered_empty = <ts>`; each wave's importer re-reads its `*.imported.bak` when its `meta.import_*` marker is missing |
| D16 | §11 open points (embedder choice, 3 nightly backups, transcripts in `history/`) | plan assumes the spec's defaults: nomic-embed-text, keep 3, transcripts stay |

## Blocked on the user

- **Recall-quality gate needs the real model.** `nomic-embed-text` is not installed (`ollama list`, 2026-11-11). Task 1 builds the quality harness and runs it with the fake embedder; the real check (int8/256 vs float32, ≥ 95% top-10) runs only after you approve `ollama pull nomic-embed-text` (~270 MB, CPU, `num_gpu: 0`). Until then stage A cannot be called complete.
- **Boot gate risk.** `PRAGMA quick_check` on a ~100 MB file may alone exceed 300 ms. If the bench shows it, the plan stops and reports; the fallback (quick_check after first recall, still before any write) is your call.

## Review Focus

1. **Unicode / punctuation-only / operator-shaped queries** (`"`, `NEAR`, `*`, `-`, `AND`, emoji, accented words) → recall returns `mode: 'empty'` or keyword hits, never an FTS syntax error. Test: Task 2 `ftsQuery` cases + Task 7 `recall('" OR * NEAR(')`.
2. **Slot write while the slot node is archived** → the write revives the slot (status `active`) and archives nothing else. Test: Task 3 `upsert to archived slot revives it`.
3. **Embedder hangs or returns the wrong dimension** → recall finishes in keyword mode within ~120 ms; a wrong-dim vector is refused, not stored. Test: Task 6 `wrong dim refused`, Task 7 `embedder never resolves`.
4. **Remove a node mid-spread** (deleted between seed and spread) → recall skips it, no throw. Test: Task 7 `missing neighbor skipped`.
5. **Clock going backwards** (`now()` earlier than `last_used`) → effective weight and recency are clamped (Δdays ≥ 0), never > stored weight. Test: Task 4 `negative age clamps`.

---

## File Structure

```
src/core/cortex/
  db.js              open file/:memory:, pragmas, stmt cache, tx(), readOnly fallback, close
  migrations/001-schema.js   all §4.1 tables, indexes, FTS5 + triggers
  migrations/index.js        ordered list
  guard.js           SECRET, caps, ftsQuery(), CortexError, isCorrection()
  sources.js         add(), trustOf(), TRUST defaults
  nodes.js           upsert/get/find/list/archive/remove, conflict policy, confidence
  edges.js           TYPES table, link/unlink/neighbors, effective(), strengthen/weaken, lazy use flush
  events.js          add/query
  embedder.js        createFakeEmbedder(), createOllamaEmbedder(), withQueryCache()
  vectors.js         quantize/dequantize, matrix, search(), put(), stale marking, trim()
  recall.js          seeds (FTS + vector, RRF), spread, score/pack
  consolidate.js     tick(): embed queue, link, dedupe, prune, housekeeping
  maintenance.js     quickCheck/quarantine/restore, backup(), export(), wipe()
  index.js           open() → public API
scripts/cortex-bench.js     gates of §6.1
scripts/cortex-quality.js   int8/dim recall-quality check (§6.3)
scripts/cortex-inspect.js   dump a node + neighbors; show recall stages
test/cortex-*.test.js
test/fixtures/cortex-quality.json   labeled queries + docs for the quality check
docs/superpowers/plans/2026-11-11-cortex-core-checklist.md
```

---

### Task 1: Recall-quality harness (§6.3, plan's first task)

**Files:** Create `scripts/cortex-quality.js`, `test/fixtures/cortex-quality.json`, `test/cortex-quality.test.js`; vector helpers live in `src/core/cortex/vectors.js` (only the pure functions below in this task).

**Interfaces:**
- Produces (in `vectors.js`): `l2normalize(f32: Float32Array) → Float32Array`, `truncate(f32, dim) → Float32Array` (first `dim`, re-normalized), `quantize(f32) → { scale: number, v: Int8Array }` (scale = max|x|/127), `dequantize({ scale, v }) → Float32Array`, `dotI8(a: Int8Array, sa, b: Int8Array, sb) → number`.
- Produces (script): `node scripts/cortex-quality.js [--embedder fake|ollama] [--dim 256]` → prints `overlap@10=<x>` and exits 1 when `< 0.95`.

- [ ] **Step 1:** Fixture: 200 short docs and 40 labeled queries (mixed topics: pets, music, places, work, health). Plain JSON `{ docs: [{id,text}], queries: [{q, relevant: [id]}] }`.
- [ ] **Step 2:** Failing tests `cortex-quality`: `quantize round-trip max error ≤ scale/2`; `dotI8 matches float dot within 2%` on 50 random unit vectors (seeded PRNG); `truncate returns unit length`.
- [ ] **Step 3:** Implement the five pure functions.
- [ ] **Step 4:** Script: embed docs and queries (`role` doc/query), compute top-10 by float32 full dim and by int8 at `--dim`; report mean overlap; with `--embedder fake` it must run in CI-free mode (no network).
- [ ] **Step 5:** `npm test` green; `node scripts/cortex-quality.js --embedder fake` prints a number. Real run is a checklist item (blocked on download).
- [ ] **Step 6:** Commit `feat(cortex): vector quantization and recall-quality harness`.

### Task 2: db, migrations, guard (§3, §4.1, §5 validation, §8 FTS injection)

**Files:** Create `src/core/cortex/db.js`, `migrations/index.js`, `migrations/001-schema.js`, `guard.js`; tests `test/cortex-db.test.js`, `test/cortex-fts.test.js`.

**Interfaces:**
- `openDb({ file, migrations = defaultList, log }) → db` where `db = { raw, stmt(sql) (cached prepare), tx(fn) (BEGIN IMMEDIATE/COMMIT/ROLLBACK, nested → SAVEPOINT), readOnly: boolean, version: number, close() }`.
- Pragmas: `journal_mode=WAL` (files only), `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=2000`, `cache_size=-8000`, `mmap_size=0`, `temp_store=MEMORY`.
- Migration module shape: `{ version: 1, name: 'schema', up(raw) }`. Each runs in its own transaction; `PRAGMA user_version` set inside it. A throw rolls back, logs, and reopens the file read-only (`readOnly: true`).
- `guard.js`: `SECRET` (the exact regex from `src/core/memory/store.js:10`, copied; wave 1 deletes the old file), `CAPS` (D10), `MAX_DATA = 4096`, `class CortexError extends Error { code }`, `ftsQuery(text) → string|null` (lowercase, split on non-letter/digit using `\p{L}\p{N}`, drop tokens < 2 chars, max 12 tokens, each wrapped in `"…"` joined with ` OR `; `null` when nothing remains), `isCorrection(text) → boolean` (`/^\s*(no\b|wrong\b|that'?s not\b|stop saying\b)/i`), `checkText(kind, text)`, `checkData(obj) → string`.
- Schema exactly §4.1, plus: `FOREIGN KEY` with `ON DELETE CASCADE` from `provenance.node_id`, `edge.src`, `edge.dst`, `vec.node_id` to `node.id`; `event.node_id` `ON DELETE SET NULL`; indexes `edge(dst,type)`, `node(kind,status,last_used)`, `event(kind,at)`, `event(node_id,at)`; FTS triggers `node_ai`, `node_ad`, `node_au` (au only when `text` changes).

- [ ] **Step 1:** Failing tests `cortex-db`: `pragmas set` (foreign_keys 1, journal_mode wal on a temp file); `migrations apply once` (open twice → `version 1`, no error); `failed migration rolls back and opens read-only` (inject `{version:2, up(){ create table x(a); throw }}` → table `x` absent, `user_version 1`, `readOnly true`); `cascade delete` (insert node+provenance+edge+vec rows via `db.stmt`, delete node → 0 rows each); `fts trigger keeps index` (insert/update/delete node → MATCH reflects it); `only db.js requires node:sqlite` (grep `src/` for `node:sqlite` → exactly one file).
- [ ] **Step 2:** Failing tests `cortex-fts`: `ftsQuery('"hello" AND world*')` → `'"hello" OR "and" OR "world"'`; `ftsQuery('')`, `ftsQuery('!!! ""')` → `null`; `ftsQuery('Café über NEAR(x)')` → tokens `"café" OR "über" OR "near"` (single-char `x` dropped); each output used in a real `MATCH` on `:memory:` with no throw; `isCorrection('no, that is wrong')` true, `isCorrection('now play')` false; `checkText('fact','my password is x')` throws code `secret`.
- [ ] **Step 3:** Implement. Run `npm test` → green. Commit `feat(cortex): sqlite db, schema migration and guard`.

### Task 3: sources and nodes (§4.2, §4.3, §5 upsert)

**Files:** Create `sources.js`, `nodes.js`; test `test/cortex-nodes.test.js`.

**Interfaces:**
- `createSources(db, { now }) → { add({ kind, ref, title?, trust? }) → id, get(id) → { id, kind, trust, ref, title, at } }`. `TRUST = { user:100, tool:90, import:100, wiki:70, web:40, model:20 }`.
- `createNodes(db, { now, sources, onWrite }) → { upsert, get, find, list, archive, remove, touch(ids) }`:
  - `upsert({ kind, key?, text, data?, importance = 0.5, status = 'active', source, quote?, tainted = false }) → { id, created: boolean, conflict?: 'replaced'|'kept'|'contradicts' }` — `source` is a source id. Whole write in one `tx`.
  - Conflict policy: D3/D4. `replaced` = new trust > stored, or equal (newer wins): old text/data copied into a new archived node (key NULL, `data._slot`), `supersedes` edge new-slot → archived copy, weight 1. `contradicts` = lower trust. Same text (normalized) on the same slot = add provenance only, no conflict.
  - Confidence (D5): recomputed on every provenance insert.
  - `get(id)` → node with parsed `data` and `sources: [{kind, trust, ref, at, quote}]`. `find({kind,key})` → node|null. `list({ kind, status = 'active', limit = 50, offset = 0, order = 'updated'|'last_used'|'uses' })`.
  - `archive(id)`, `remove(id)` (cascade). `touch(ids)` buffers `uses+1, last_used=now` in a Map; `flushUses()` writes the batch (called by index.js once a minute and on close).
  - `onWrite(id, kind)` hook (index.js uses it to queue embeddings).
- Taint: `tainted && source.kind ∈ {user, tool}` → `CortexError('tainted')`.

- [ ] **Step 1:** Failing tests: `upsert new fact` (created true, confidence 100 for user source); `provenance required` (no `source` → code `no_source`); `quote cut to 240`; `secret refused`; `text too long for kind` (fact 301 chars → `too_long`); `data over 4 KB refused`; `unknown kind refused`; slot cases `higher trust replaces` (web then user → conflict `replaced`, slot text = user's, one archived copy linked `supersedes`), `equal trust newer wins`, `lower trust contradicts` (user then web → `contradicts`, slot unchanged, new node key NULL with `data._slot`); `same text adds provenance` (two sources → confidence = 100 + 5 capped 100; with wiki then web: 70+5 = 75); `upsert to archived slot revives it`; `taint refuses user and tool, allows web`; `remove cascades`; `list order and paging`; `touch is lazy until flush`.
- [ ] **Step 2:** Implement. `npm test` green. Commit `feat(cortex): sources, nodes and slot conflicts`.

### Task 4: edges and plasticity (§4.4)

**Files:** Create `edges.js`; test `test/cortex-edges.test.js`.

**Interfaces:**
- `TYPES` (D8) — `{ halfLife (days), fanOut }`:
  `mentions 60/20 · part_of 365/20 · from 365/10 · by 365/5 · contains 365/50 · next 90/10 · similar 120/5 · same_as 3650/5 · supersedes 3650/2 · contradicts 3650/5 · touched 30/20 · about 180/20`.
- `effective(w, lastUsed, type, now) = w · 0.5^(max(0, now − lastUsed)/864e5 / halfLife)`.
- `createEdges(db, { now }) → { link(src, dst, type, { weight? }) , unlink(src, dst, type), neighbors(id, { types?, depth = 1, limit = 20 }) → [{ id, type, weight /*effective*/, hop, via }], strengthen(pairs, eta), weaken(nodeIds, factor = 0.6), prune(floor = 0.02) → n }`.
  - `link` new edge: weight = `opts.weight ?? 0.3`; existing edge: `w ← eff + 0.3·(1−eff)` (explicit-link η) or `max(eff, opts.weight)` when weight given. Weights stored clamped to `(0, 1]`, saturating `< 1` for η updates.
  - `strengthen(pairs: [srcId, dstId][], eta = 0.15)`: for each existing edge in either direction, `w ← eff + eta·(1−eff)`, `last_used = now`. Creates no edges.
  - `neighbors` both directions (src and dst sides), per-type fan-out cap applied per node, ordered by effective weight.

- [ ] **Step 1:** Failing tests: `strengthen saturates below 1` (100 rounds → `< 1`, monotonic); `decay by half-life` (`mentions` edge w 0.8, 60 days later effective 0.4); `negative age clamps`; `weaken multiplies 0.6`; `fan-out cap` (30 `mentions` neighbors → 20 returned); `depth 2 returns hop 2 with via`; `unknown type refused`; `prune removes below floor only`.
- [ ] **Step 2:** Implement. `npm test` green. Commit `feat(cortex): weighted edges with decay and Hebbian updates`.

### Task 5: events (§4.1 event, §5)

**Files:** Create `events.js`; test `test/cortex-events.test.js`.

**Interfaces:** `createEvents(db, { now }) → { add({ kind, nodeId?, payload, at? }) → id, query({ kind, since?, until?, nodeId?, limit = 100, order = 'asc'|'desc' }) → [{ id, at, kind, nodeId, payload }], count({ kind? }) → n, deleteWhere({ kind, before?, keepNewest? }) → n }`. Payload JSON ≤ 4 KB, `guard.SECRET` applied to the serialized payload (refuse with `secret`).

- [ ] **Step 1:** Failing tests: `append and range` (since inclusive, until exclusive); `order asc/desc`; `nodeId filter`; `payload parsed back equal`; `unknown kind refused`; `node delete sets node_id NULL`; `deleteWhere keepNewest`.
- [ ] **Step 2:** Implement. `npm test` green. Commit `feat(cortex): append-only events`.

### Task 6: embedder and vector store (§6.2, §6.3)

**Files:** Create `embedder.js`; extend `vectors.js`; tests `test/cortex-vectors.test.js`, `test/cortex-embedder.test.js`.

**Interfaces:**
- `Embedder = { id: string, dim: number, embed(texts: string[], { signal, role }) → Promise<Float32Array[]>, status() → Promise<{ ok, model, reason? }> }`.
- `createFakeEmbedder({ dim = 256, synonyms = {} }) → Embedder` — deterministic: lowercase words, map via `synonyms` (e.g. `{ puppy: 'dog' }`), FNV-1a hash each word to 2 signed buckets, L2-normalize. `id = 'fake'`.
- `createOllamaEmbedder({ getConfig, fetch, model = 'nomic-embed-text', dim = 256 }) → Embedder` — POST `${host}/api/embed` `{ model, input, options: { num_gpu: 0 }, keep_alive: '30s' }`; prefixes per D11; truncate to `dim`. `status()` checks `/api/tags` for the model (never pulls).
- `withQueryCache(embedder, { size = 256, timeoutMs = 120 }) → { query(text) → Promise<Float32Array|null> }` — LRU, `AbortController` timeout → `null`, under 3 content words → `null` without calling.
- `createVectors(db, { dim, now }) → { put(nodeId, f32), remove(nodeId), search(qF32, k = 20) → [{ id, score }], has(nodeId), staleCount(), markStaleIfModelChanged(modelId, dim), stats() → { vectors, matrixBytes }, trim() }`. Matrix built lazily on first `search` from `vec`; `put` updates DB and the loaded matrix in place (grow by doubling). Wrong length → `CortexError('dim')`. `meta.embed_model`, `meta.embed_dim`; a change flags all rows stale (`dim` column kept, plus `meta.embed_stale_before = <max id>`), stale rows still served until replaced.

- [ ] **Step 1:** Failing tests: `fake embedder: synonyms close` (cos(dog, puppy) > cos(dog, invoice)); `search order matches float32 on fixture` (top-5 identical on 100 fake vectors); `trim drops matrix, next search reloads`; `model change marks stale, old vectors still searched`; `wrong dim refused`; `query cache hit skips embed`; `query timeout → null in ≤ 150 ms` (embedder that never resolves); `short query → null, no call`; ollama embedder with a fake `fetch`: request body has `num_gpu: 0`, prefix `search_query: `, response truncated to 256 and unit length; `status` false when the model is missing.
- [ ] **Step 2:** Implement. `npm test` green. Commit `feat(cortex): embedders and int8 vector store`.

### Task 7: recall (§6)

**Files:** Create `recall.js`; test `test/cortex-recall.test.js`.

**Interfaces:**
- `createRecall({ db, nodes, edges, vectors, queryVector /* (text) → Promise<f32|null> */, now }) → { recall(query, { budget = 1000, kinds?, brief = false, quotas?, now? }) → Promise<{ text, items: [{ id, kind, score, source, age }], ms, mode: 'hybrid'|'keyword'|'empty', stages? }> }`.
- Seeds: FTS `bm25` top 20 (status active, kinds filter) + vector top 20; RRF `a₀ = Σ 1/(60 + rank)`. Spread: 2 hops, `a(n) += a(m)·w_eff·0.5^hop`, per-type fan-out, floor 0.02, ≤ 200 nodes touched, prepared statements in a loop. Score §6.3 formula with D6 recency. Quotas D7. `brief`: budget/2, kind `chat` dropped. Line format: `${text} [${sourceLabel} · ${age}]` where sourceLabel ∈ `you said|tool|import|wikipedia|web|guess` and age `today|Nd|Nmo|Ny`. Lines over the remaining budget are skipped (not cut).
- `stages` only when `opts.debug` (for `cortex-inspect.js`).

- [ ] **Step 1:** Failing tests: `seed fusion ranks a node found by both above either alone`; `two-hop reaches a node with no shared word` ("my dog" → entity `rex` → fact "Rex has a vet visit in March"); `nothing matches → mode empty, text ''`; `budget ceiling` (text.length ≤ budget for budgets 100/500/1000); `quotas` (50 matching chats + 3 facts, kinds both → facts present); `brief halves and drops chats`; `keyword mode when embedder times out` (and `ms` < 200); `archived nodes never returned`; `operator query safe` (`'" OR * NEAR('`); `missing neighbor skipped`.
- [ ] **Step 2:** Implement. `npm test` green. Commit `feat(cortex): spreading-activation recall`.

### Task 8: maintenance and public API (§5, §8, §9)

**Files:** Create `maintenance.js`, `index.js`; tests `test/cortex-api.test.js`, `test/cortex-api-taint.test.js`, extend `test/cortex-db.test.js` (integrity).

**Interfaces:**
- `open({ file = ':memory:', log, bus, embedder = null, now = Date.now, isIdle = () => true, backups = 3 }) → cortex` exactly §5, plus D1 `wipe({ kinds?, everything? })`, D2 `weaken(itemIds)`, `isCorrection(text)`, `health() → { ok, readOnly, quickCheck, embedder, queue, lastBackupAt, recoveredEmpty }`, `stats() → { nodes, edges, vectors, events, bytes, matrixBytes, queue, mode, lastConsolidate }`, `trim()` (drops matrix + statement cache rebuild-on-demand). `reinforce(ids)`: co-use strengthen (η 0.15) on edges among `ids` + `nodes.touch(ids)`; no-op when last recall was in a tainted turn — callers pass `{ tainted }`: `reinforce(ids, { tainted })`.
- Boot: `quick_check`; not `ok` → move file (+ `-wal`, `-shm`) to `<dir>/broken/<ts>-cortex.db`, copy newest `cortex.backup-<n>.db`; none → empty file + `meta.recovered_empty`. Any failure → in-memory empty cortex with `health().ok = false`; `open` never throws.
- `backup()`: `VACUUM INTO <dir>/cortex.backup-<ts>.db`, keep newest `backups`. `export()` → `{ version, nodes, edges, provenance, sources, events }` (validated JSON, no vectors). `wipe({ kinds })`: delete those nodes (cascade); `wipe({ everything: true })`: all rows, `wal_checkpoint(TRUNCATE)`, `VACUUM`, delete backups and `<dir>/*.imported.bak`.
- Every public method catches internal errors except `CortexError` it means to throw; `recall` never throws (returns `mode: 'empty'` and logs).

- [ ] **Step 1:** Failing tests `cortex-db` (integrity): `corrupt file quarantined and backup restored` (write garbage over the db after a backup); `no backup → empty, recovered_empty set`; `open never throws on unreadable path`.
- [ ] **Step 2:** Failing tests `cortex-api`: full §5 surface present (`typeof` checks); round trip upsert → recall → reinforce raises edge weight; `weaken` lowers it; `wipe({kinds:['fact']})` keeps other kinds; `wipe({everything})` removes backups and `*.imported.bak` in the temp dir; `export` JSON parses and has the rows; `stats` numbers match; `trim` then recall works.
- [ ] **Step 3:** Failing tests `cortex-api-taint`: tainted upsert with user/tool source → `tainted`; web source OK; `reinforce(ids, { tainted: true })` changes no weight.
- [ ] **Step 4:** Implement. `npm test` green. Commit `feat(cortex): public API, integrity, backup, export, wipe`.

### Task 9: consolidation (§7)

**Files:** Create `consolidate.js`; wire into `index.js`; test `test/cortex-consolidate.test.js`.

**Interfaces:** `createConsolidate({ db, nodes, edges, vectors, embedder, maintenance, now, isIdle, log }) → { tick({ deadlineMs = 8, isIdle? }) → Promise<{ did: string[], aborted: boolean }>, queue: { push(id), size } }`. Embed kinds: `fact, entity, chat, knowledge, reminder`. Order §7: (1) embed batch of 16 (async; slice yields while awaiting), (2) link `similar` top 5 at cos ≥ 0.82 weight = cos, (3) dedupe cos ≥ 0.95 same kind equal top trust → `same_as` + archive older, **except** user-trust nodes → `data.proposedMerge = <id>` only, (4) prune edges < 0.02 effective; archive `knowledge`/`chat` with `last_used` (or `updated`) older than 180 d, never nodes with a `user` provenance, (5) housekeeping by timestamps in `meta`: `PRAGMA optimize` daily, `wal_checkpoint(TRUNCATE)` hourly, `backup()` daily. Only one tick at a time (re-entrant call returns `{ did: [], aborted: true }`). Checks `isIdle()` before each step; false → stop.

- [ ] **Step 1:** Failing tests: `similar link made at ≥ 0.82, not below`; `dedupe archives older equal-trust non-user node`; `user-trust duplicates only proposed`; `prune edges and old knowledge/chat, keeps user facts`; `not idle → nothing done`; `idle turns false mid-tick → aborted`; `slice deadline: each synchronous step ≤ 8 ms` on 2,000 nodes (measure with `performance.now()` around each step; allow CI slack ×3 in the test, the bench reports the real number); `overlapping tick refused`; `housekeeping runs once per period`.
- [ ] **Step 2:** Implement. `npm test` green. Commit `feat(cortex): idle consolidation`.

### Task 10: bench, inspect, checklist, report (§6.1, §9, §10)

**Files:** Create `scripts/cortex-bench.js`, `scripts/cortex-inspect.js`, `docs/superpowers/plans/2026-11-11-cortex-core-checklist.md`.

**Interfaces:**
- `node --expose-gc scripts/cortex-bench.js [--nodes 50000 --edges 200000 --vectors 20000 --keep <dir>]`: builds the corpus in a temp dir with a seeded PRNG (realistic fact/chat/knowledge texts from a word list), fake embedder for node vectors (dim 256), then measures: `upsert` mean and p95 over 1,000 fresh writes; close; **boot** = `open()` + first `recall()` wall time; **recall** p50/p95/p99 over 1,000 queries without a query embedder; **rss delta** (after gc) from before open to after the recall loop with the matrix loaded; **db bytes** (file + wal after checkpoint); a consolidation slice max. Prints a table and `GATE PASS|FAIL` per gate; exit 1 on any FAIL.
- `node scripts/cortex-inspect.js <db> node <id>` | `recall "<query>"` — prints node, provenance, neighbors; recall stages (seeds, spread, packed).
- Checklist: real-model quality run, embedder on CPU with JARVIS running (VRAM unchanged), boot inside the real Electron (Node 24 / SQLite 3.53), ExperimentalWarning noise in the app log.

- [ ] **Step 1:** Write the bench and run it. Record the real numbers in the stage report. Any FAIL → stop and report with output (no tuning without the user's say).
- [ ] **Step 2:** `node scripts/cortex-quality.js --embedder fake` → record; mark real run blocked.
- [ ] **Step 3:** `npm test` full run, record count (expected 892 + new).
- [ ] **Step 4:** Commit `chore(cortex): bench, inspect tool and manual checklist`.

---

## Not in this stage

`main.js` wiring, memwatch registration, `self_diagnostics` cortex check, Settings → Memory tab, any importer, any skill change: wave 1 onward (D14, D15).
