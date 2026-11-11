# Cortex Wave 3 (Looked-up Knowledge, Timers and Reminders) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** What JARVIS looks up on Wikipedia or the web is kept in the cortex as `knowledge` nodes (source, quote, URL, fetch time) and reused, cited with its age, before going online; timers, alarms and reminders move from `timers.json` into the cortex as `reminder` nodes linked to the wave 1 entities they mention, behind the unchanged timer-store interface.

**Architecture:** One new adapter per store, both over the public cortex verbs only (no SQL outside `src/core/cortex`): `src/core/knowledge/store.js` (write, find-before-network, conflicts, reuse count) used by `tools/knowledge.js` and `tools/web.js` through an optional `knowledge` dependency; `src/core/timers/cortex-store.js` (same surface as `timers/store.js`) plus `timers/import.js`. `memory/system.js` builds both on its live cortex handle; `main.js` only swaps the timer store and passes `knowledge` to the catalog (one small, last commit).

**Tech Stack:** cortex (`src/core/cortex`, node:sqlite), Node test runner. No new dependencies, no model calls.

**Spec:** [docs/specs/2026-11-11-cortex-wave3-knowledge-timers-design.md](../../specs/2026-11-11-cortex-wave3-knowledge-timers-design.md) (W3 §n). Core: [cortex core design](../../specs/2026-11-11-cortex-core-design.md) §4.3 (slot conflicts), §5 (API). Wave 1: [plan](2026-11-11-cortex-w1-memory.md) (entities, `entityKey`, `memory_about`, `createMemorySystem`).

## Global Constraints

- Network rules unchanged: the allowlist (`src/core/net/policy.js`), the master switch (`config.online.enabled`) and the per-source switches, web limits (30 per ten minutes) and `web.checkQuery` ("never anything personal in a query"). Nothing in the cortex path opens a socket.
- Reuse never sends anything: the cortex check is local; whatever does go online goes through the same `fetcher` / `web` calls as today.
- Distillation is mechanical: the stored text is the passage text the tool already produced. No model call, and no `model`-trust knowledge node.
- Trust: `wiki` 70, `web` 40 (core `TRUST`); knowledge writes are always `tainted: true` (these tools are `untrusted`), so they can never be `user`/`tool` trust.
- Freshness: `stable` (Wikipedia) 90 days, `news-ish` (web pages and searches) 3 days, `volatile` (current/latest/price…) never stored, only an event `lookup`.
- Weather, alerts, news headlines and sports scores stay only in the fetcher's cache: those tools are not touched.
- Timers: `scheduler.js`, `proactive/engine.js`, `tools/timers.js` and their tests do not change; a timer is committed before JARVIS says it is set; boot fires overdue ones once as missed.
- Secrets never stored (cortex guard on every write; a refused write never breaks the lookup that produced it).
- No `eval/run.js` and no live-model check while JARVIS runs: those go to `docs/superpowers/plans/2026-11-11-cortex-wave3-checklist.md`, never claimed verified.
- `main.js` is touched once, last, small (wave 2 edits it in parallel).
- LF line endings; stage by explicit path; one commit per task; `npm test` green after each (baseline 1128); commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions this plan makes where the spec is silent or conflicts (approved; further rulings go to the ledger)

| # | Gap / conflict | Plan's choice |
|---|---|---|
| E1 | Order of offline library, cortex and online for `lookup_knowledge` / `read_article` | offline library → cortex → online. Offline-library passages are **not stored** (the library is already on disk; copies would only grow the db). The cortex check runs only where today's code would go online. |
| E2 | §2 says node text ≤ 600 chars but also a 2,000-char per-page cap; core caps `knowledge` at 2,000 | stored text = the exact passage text the tool returned for that article/page, cut at 2,000 on a word boundary; quote = its first 240 chars. The 600 figure is dropped (a reused answer would carry a quarter of what the online one did). |
| E3 | Key scheme details | `kn:<host>:<slug>`, slug = lowercase letters/digits joined by `-`, ≤ 120. Wikipedia (lookup and read through the wiki API, source `wiki`): host `wikipedia.org`, slug of the article title; `read_article` adds `#<section slug or "article">`. `web_open`: host of the page, slug of path+query; a `*.wikipedia.org/wiki/<Title>` page maps to the **same** key as the wiki-API article (so the core slot policy sees the conflict). `web_search`: `kn:search:<slug of the query>`, source `web` ref `duckduckgo`. |
| E4 | What counts as `volatile` | the tool's query/focus matches `/\b(latest|current(ly)?|today|tonight|right now|now|this (?:week|morning|afternoon|evening)|breaking|live|price|prices|cost|stock|shares?|exchange rate|score|scores|weather|forecast)\b/i` → not stored, never reused, event `lookup { tool, volatile: true }` |
| E5 | Recall scores are normalized (top seed = 1), so "score ≥ θ" alone cannot say "confident" | a hit is confident when `score ≥ θ·1.3` (θ = 0.55, 1.3 = the max of confidence × importance factors at activation 1) **and** ≥ 2/3 of the query's content words (`guard.ftsTokens`) appear as whole words in the node's title + text. Constants exported; a labeled-query test fixes them. |
| E6 | Recall budget 1,200 vs 2,000-char nodes (a node longer than the budget is never packed) | recall `{ kinds: ['knowledge'], budget: 6000 }` for ranking only; the hit's full text comes from `node.get`. |
| E7 | Ages in `data` | the cortex `data` guard reads any 13+ digit run as a card number, so `fetchedAt`, `at`, `created`, `firedAt` are ISO strings, not epoch ms. |
| E8 | Refresh of the same key | same source kind → `node.update` in place (no archived copy per refresh); higher trust → `upsert` (core: old value archived, `supersedes`); lower trust → `upsert` (core: separate node, `contradicts` edge, the wiki node untouched). |
| E9 | "A conflict is told to the user" | when the node being served (from memory or just written) has a live `contradicts` neighbor, the tool result adds `Another source (<web|wikipedia>, <host>) says differently: "<quote>". Tell the user both and which is more reliable.` Different sites on different keys are not compared (left to the model and the existing "say when sources disagree" rule). |
| E10 | When a stale node is served | only when `config.online` is off for that source, or the online call **throws**; "nothing found" online is not a failure. Text: `last known, from <YYYY-MM-DD> (could not refresh)`. |
| E11 | Reuse count | `cortex.reinforce([id])` (ticks `uses`) + event `lookup { tool, host, reused: true }`; bus `net { source: 'cortex', host, ok: true, cached: true, ageMs, stale }` so the turn's lookups show "from memory". |
| E12 | `knowledge —about→ entity` | when `entityKey(title)` names an existing active entity (wave 1); otherwise no link. No model call. |
| E13 | How the parity tests run "unchanged" against the cortex | `timers/store.js` (the file store) stays as the reader the importer uses, with its own tests. New `timers/cortex-store.js`. `test/timer-store-parity.test.js` swaps `createTimerStore` in the require cache for a cortex-backed factory (one db per `dirname(file)`), then requires `timers-scheduler.test.js` and `timers-tools.test.js` as they are. |
| E14 | Reminder node shape and the store's `remove(id)` (the scheduler calls it both to fire and to cancel) | key `reminder:<id>`, text = label when ≥ 3 chars else the kind word, `data { type, label, at, created, state, firedAt? }` (E7), source `user` ref `timers` (one row, reused). Pending = status `active`. `remove`: `due ≤ now` → `state:'fired'`, `firedAt`, event `reminder_fired { timerId, late }` (late = more than 60 s past due); otherwise `state:'cancelled'`. Both then archived, so `list()` is one `node.list` of active reminders, cached in memory like the file store. |
| E15 | A label the secret guard refuses ("change my password", a long number) | `add` throws `Could not save the timer: its label looks like a password, key or long number. Say it another way` — nothing is said set. |
| E16 | Cortex unavailable (in-memory fallback or read-only) | `add` throws `Could not save the timer: …` (the old store's "persisted" guarantee: an in-memory cortex would lose it on restart). |
| E17 | Import of `timers.json` | uses `store.js` to read (valid entries only, corrupt file → `broken/` as today), one `cortex.transaction`, `meta import_timers`, rename to `timers.json.imported.bak` (existing `.bak` → `timers.json.<ts>.imported.bak`); marker present → rename only. Overdue entries import as pending, so boot fires them once as missed (current behavior). |
| E18 | §5 "per store: in cortex / file / mirror" | `src/core/self/stores.js` exports `STORES` (name → `'cortex'|'file'|'mirror'`) and `storesLine()`; `checks.js` gains a `data stores` check that prints it. Wave 2 adds its own rows there. |

## Review Focus

1. **A knowledge write the cortex refuses** (a URL or passage holding a 13+ digit number or the word "password", an over-long key) → the lookup still answers from the online result; nothing stored; logged. Test in Task 1.
2. **Master switch off, fresh hit in memory** → served from memory (no socket is opened by it); **stale** hit with the switch off → served as "last known, from <date>"; switch off and no hit → today's text. Test in Task 2.
3. **The same question twice within the TTL** → the second answer makes zero fetcher/web calls, says "from memory, fetched … ago", and `uses` goes up. Test in Tasks 2 and 3.
4. **App restarted after a timer fired, and again** → fired once (missed on the first boot), never again: fired nodes are archived. Test in Task 4.
5. **A reminder whose label the secret guard refuses** → `set_reminder` reports it could not save; nothing is set; scheduler not armed. Test in Task 4.

---

## File Structure

```
src/core/knowledge/store.js     NEW  createKnowledgeStore({ cortex, now, log }) — classify, save, find, served, reuse
src/core/tools/knowledge.js     CHANGED  optional `knowledge` dep: reuse before online, save after online
src/core/tools/web.js           CHANGED  optional `knowledge` dep: same for web_search / web_open
src/core/skills/knowledge/index.js, skills/web/index.js   CHANGED  pass `knowledge` through
src/core/timers/cortex-store.js NEW  createCortexTimerStore({ cortex, now, log, entities }) — same surface as store.js
src/core/timers/import.js       NEW  importTimersJson({ cortex, file, log })
src/core/memory/system.js       CHANGED  builds knowledge + timerStore, runs the timers import
src/core/self/stores.js         NEW  STORES map + storesLine()
src/main/checks.js              CHANGED  'data stores' check
src/main/main.js                CHANGED  (last) timer store from the memory system; catalog gets `knowledge`
docs/jarvis-prompt-rules.md     CHANGED  "Where facts come from"
eval/questions.json             CHANGED  reuse questions (not run)
test/knowledge-write.test.js, knowledge-reuse.test.js, knowledge-taint.test.js, timer-store-parity.test.js,
test/timer-links.test.js, timer-import.test.js, net-policy-unchanged.test.js     NEW
docs/superpowers/plans/2026-11-11-cortex-wave3-checklist.md   NEW
```

---

### Task 1: `knowledge/store.js` — write, find, conflicts (W3 §2, E2–E9, E11, E12)

**Files:** Create `src/core/knowledge/store.js`; tests `test/knowledge-write.test.js`, `test/knowledge-taint.test.js`.

**Interfaces:**
- `createKnowledgeStore({ cortex, now = Date.now, log = () => {} }) →`
  - `classify(text) → 'volatile' | null` (E4); `TTL = { stable: 90 * 864e5, 'news-ish': 3 * 864e5 }`.
  - `keyFor({ host, title, section })` and `keyForUrl(url) → { key, host, title? }` (E3, wikipedia URL mapping).
  - `save({ key, host, title, section?, url, text, sourceKind: 'wiki'|'web', ttlClass: 'stable'|'news-ish', tool, query? }) → { id, conflict?: 'contradicts'|'replaced', refreshed?: true } | { skipped: 'volatile'|'source'|'refused', reason? }` — never throws; `sourceKind` other than wiki/web → `skipped:'source'`; `classify(query)` volatile → event only; cortex refusal → `skipped:'refused'`, logged. One `wiki`/`web` source row per `(kind, ref=url)` reused via `source.find`. Always `tainted: true`. E8 refresh rule, E12 link.
  - `find(query, { allowStale = false }) → Promise<hit|null>` (E5, E6) and `get(key, { allowStale })` (exact key, for `read_article` / `web_open`); `hit = { id, key, text, url, title, host, sourceKind, fetchedAt, ageMs, stale, conflicts: [{ sourceKind, host, quote }] }`.
  - `label(hit) → string` — `"<Wikipedia|web: host>, from memory, fetched <describeAge>"`, or `"…, last known, from <YYYY-MM-DD> (could not refresh)"` when stale (E10).
  - `conflictNote(hit) → string` ('' when none) (E9); `reused(hit, tool)` (E11, emits through an optional `bus`, so the factory also takes `bus = null`).
  - `REUSE_THETA = 0.55`, `REUSE_COVERAGE = 2/3` exported.

- [ ] **Tests first** (`knowledge-write`): `save stores the exact passage text and a ≤ 240-char quote`, `text over 2,000 cut on a word boundary`, `data has url/title/fetchedAt (ISO)/ttlClass`, `volatile query → no node, one lookup event`, `same key same source → updated in place, one node, no archived copy`, `web write on a wiki key → contradicts edge, wiki text unchanged, conflictNote names the web host`, `wiki write on a web key → replaces (supersedes)`, `title naming a known entity → about edge`, `a passage with a 16-digit number → skipped 'refused', no throw` (Review Focus 1), `no node with a model source after any save`; (`knowledge-taint`): `save with sourceKind 'user' or 'tool' → skipped 'source'`, `every knowledge provenance is wiki or web`, `a cortex user-source write with tainted:true is still refused after knowledge saves` (core rule in place).
- [ ] Run `node --test test/knowledge-write.test.js test/knowledge-taint.test.js` → FAIL (module missing).
- [ ] Implement; tests green; `npm test` green; commit `feat(knowledge): knowledge nodes in the cortex with source, age and conflicts`.

### Task 2: reuse in `lookup_knowledge` and `read_article` (W3 §3, E1, E10)

**Files:** Modify `src/core/tools/knowledge.js`, `src/core/skills/knowledge/index.js`; test `test/knowledge-reuse.test.js`.

**Interfaces:**
- `createKnowledgeTools({ fetcher, kiwix, getConfig, bus, knowledge = null })` and `createGroup({ ..., knowledge })`; without `knowledge` behavior is today's (existing `knowledge-tools` tests unchanged).
- `lookup`: offline library unchanged (not stored) → `knowledge.find(q)` fresh+confident → `wrapSource(label, text + conflictNote)` and `reused` → else online as today; on success each article among the ranked passages is saved (`key` per E3, `text` = `formatPassages` of that article's passages, `stable`); online off or throwing → `knowledge.find(q, { allowStale: true })` → "last known" text, else today's text.
- `readArticle`: same with `knowledge.get(keyFor({ host:'wikipedia.org', title, section }))`.
- The result tells the model it is from memory and how old (in the `SOURCE DATA (…)` label).

- [ ] **Tests first** (fake fetcher counting calls): `first lookup goes online and stores one node per article`, `second lookup of the same question: zero fetches, label says from memory and the age, uses +1, net event cached:true source cortex` (Review Focus 3), `stale (91 days) not served when online; refetch updates the same key`, `stale served "last known, from <date>" when online is off` and `when the fetch throws`, `master switch off + fresh hit → served, no fetch` (Review Focus 2), `offline library hit → nothing stored`, `read_article second read of the same section: zero fetches`, `a question sharing one word with a stored node is not served` (E5 labeled set: 6 should-hit / 6 should-miss queries, all classified right), `conflict note in the reused result`.
- [ ] Run → FAIL; implement; green; `npm test`; commit `feat(knowledge): answer from stored knowledge before going online`.

### Task 3: reuse in `web_search` and `web_open` (W3 §2–§3, E3, E4)

**Files:** Modify `src/core/tools/web.js`, `src/core/skills/web/index.js`; tests in `test/knowledge-reuse.test.js` (new cases), `test/web.test.js` unchanged.

**Interfaces:**
- `createWebTools({ web, knowledge = null })`, `createGroup({ web, getConfig, knowledge })`.
- `web_search`: `classify(query)` volatile → straight online, nothing stored; else `knowledge.find(query)` → hit served → else `web.search` as today, the result block (titles, hosts, snippets, URLs) saved at `kn:search:<slug>` (`news-ish`, source web ref `duckduckgo`). `web.search` throwing (off / limit / network) → `find(query, { allowStale: true })` → "last known", else rethrow (today's refusal text kept).
- `web_open`: `knowledge.get(keyForUrl(url).key)` fresh → served (no `web.open`); else `web.open`; the readable text cut to 2,000 (E2) saved under the page key (`news-ish`, source web, ref = url) — `focus` only shapes what is returned, the stored text is the page's first 2,000 readable chars.
- Personal-query refusal (`web.checkQuery`) still happens inside `web.search` before any network; a refused query stores nothing.

- [ ] **Tests first** (fake `web`): `search stored, second identical search: zero web.search calls, from memory`, `volatile search ("latest iPhone price") → not stored, second call goes online`, `refused personal query → nothing stored, refusal text unchanged`, `web_open twice: one web.open`, `web_open of en.wikipedia.org/wiki/Eiffel_Tower after a wiki lookup of it → contradicts, wiki node unchanged, note in the result`, `page text > 2,000 cut`, `web off + stale stored search → last known`.
- [ ] Run → FAIL; implement; green; `npm test`; commit `feat(knowledge): web searches and pages kept and reused with their age`.

### Task 4: cortex-backed timer store + parity + links (W3 §4, E13–E16)

**Files:** Create `src/core/timers/cortex-store.js`; tests `test/timer-store-parity.test.js`, `test/timer-links.test.js`.

**Interfaces:**
- `createCortexTimerStore({ cortex, now = Date.now, log = () => {} }) → { list(), get(id), add(t), remove(id) }` — same shapes as `store.js` (`{ id, kind, label, due, created }`, id `/^t/`, copies returned); `add` re-reads the node (`node.find`) before returning, throws `Could not save the timer: …` on any refusal (E15, E16); after add, links `reminder —about→ entity` for every active entity (wave 1, `kind:'entity'`) whose text occurs in the label (word boundary, case-insensitive), weight 0.5.
- `remove(id)` per E14; returns `false` when unknown or already archived.

- [ ] **Tests first** (`timer-store-parity`): the swap of E13, then `require('./timers-scheduler.test.js')` and `require('./timers-tools.test.js')` (all their cases pass on the cortex backing, including commit-before-confirm and missed-on-boot); plus own cases: `restart: a new store on the same cortex lists the timer`, `fired → archived, state fired, reminder_fired event with late flag; a later boot does not fire it again` (Review Focus 4), `cancel → state cancelled, no event`, `in-memory fallback cortex → add throws could not save`, `secret label → add throws, list empty; set_reminder reports it` (Review Focus 5), `empty label stored with the kind word as text, label '' returned`. (`timer-links`): `"Take Rex to the vet" links to entity Rex`, `"rexford" does not link to Rex` (word boundary), `memory_about("Rex") lists the reminder`, `no entities → no links, no throw`.
- [ ] Run → FAIL; implement; green; `npm test` (timers/scheduler/proactive files untouched: `git diff --stat` shows none of them); commit `feat(timers): timers and reminders in the cortex, linked to entities`.

### Task 5: `timers.json` import (W3 §4, E17)

**Files:** Create `src/core/timers/import.js`; test `test/timer-import.test.js`.

**Interfaces:** `importTimersJson({ cortex, file, log = () => {}, now = Date.now }) → { imported, skipped, already?: true }` writing through `createCortexTimerStore`'s node shape (shared helper `toNode(t)` exported from `cortex-store.js`), keeping each timer's id.

- [ ] **Tests first**: `timers.json → pending reminder nodes with the same ids, file renamed .imported.bak`, `second run: already, nothing added`, `crash after commit before rename → rename only`, `overdue entry imported and fired once as missed by scheduler.start()`, `corrupt file → nothing imported, file in broken/, no marker`, `existing .imported.bak → timestamped name`.
- [ ] Run → FAIL; implement; green; `npm test`; commit `feat(timers): one-time timers.json import`.

### Task 6: memory system wiring, diagnostics, prompt rules (W3 §5)

**Files:** Modify `src/core/memory/system.js`, `src/main/checks.js`, `docs/jarvis-prompt-rules.md`; create `src/core/self/stores.js`; tests `test/boot-memory.test.js` (new cases), `test/self-checks.test.js` (new case), `test/net-policy-unchanged.test.js`.

**Interfaces:**
- `createMemorySystem(...)` also returns `knowledge` (`createKnowledgeStore({ cortex, bus, log, now })`) and `timerStore` (`createCortexTimerStore({ cortex, now, log })`), and runs `importTimersJson({ cortex, file: dataDir/timers.json, log })` after the memory import (errors logged, boot continues).
- `STORES = { 'memory facts': 'cortex', 'chat summaries': 'cortex', knowledge: 'cortex', timers: 'cortex', 'chat history': 'file', config: 'file', 'lookup cache': 'file' }`; `storesLine() → "in cortex: …; file: …"`; check id `data stores`.
- Prompt rules: section "Where facts come from": user words > tool results > Wikipedia > web > model guesses; say when an answer came from memory and how old it is; name both sources when they conflict.

- [ ] **Tests first**: `boot: timers.json imported into the cortex and the system's timerStore lists it`, `boot: knowledge store present and saves`; `self-checks: data stores line lists knowledge and timers as in cortex`; `net-policy-unchanged`: no file under `src/core/cortex/`, nor `knowledge/store.js`, `timers/cortex-store.js`, `timers/import.js` requires `node:net|http|https|tls|dgram` or calls `fetch(`; `src/core/net/policy.js` and `src/core/web/service.js` unchanged against the merge base (`git diff --quiet main -- …` when git is available, skipped otherwise).
- [ ] Run → FAIL; implement; green; `npm test`; commit `feat(cortex): knowledge and timers in the memory system; data stores check; prompt rule`.

### Task 7: `main.js` wiring (last, small)

**Files:** Modify `src/main/main.js` only.

- `ctx.timerStore = ctx.memorySystem.timerStore` replaces the `createTimerStore({ file })` line (and its require); the catalog options gain `knowledge: ctx.memorySystem.knowledge`.
- [ ] `node --check src/main/main.js`; `npm test` (syntax test covers main); commit `feat(cortex): wire wave 3 into JARVIS`.

### Task 8: checklist, eval questions, bench, stage report

**Files:** `docs/superpowers/plans/2026-11-11-cortex-wave3-checklist.md` (who-is-X answered from memory the second time; "from memory" shown in the UI; conflict told; set/cancel/fire a reminder across a restart; `memory_about` lists a reminder; the timers.json import on the real data folder; data stores line in diagnostics), `eval/questions.json` (2 reuse questions, not run).

- [ ] Write them; `npm test`; `node --expose-gc scripts/cortex-bench.js` (gates unchanged; report numbers); commit `docs(cortex): wave 3 checklist and eval questions`.
- [ ] Final whole-branch review (fresh, most capable model) and one fix pass; push the branch.
