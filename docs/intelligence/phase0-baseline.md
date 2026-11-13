# Intelligence roadmap, Phase 0: reconnaissance and baseline (2026-11-13)

Branch `feat/jarvis-audit-pass` at `ea5ba2e` plus uncommitted `package.json` (`loc` script), `scripts/loc.js`, `.playwright-mcp/`, `clean-speaking.png` (none mine, none touched).
Everything below was read from the code or measured on this machine today. Where I did not trace or run something, it says so.
Added by Phase 0: `test/baseline-security.test.js`, `test/fixtures/intelligence-eval-v1.json`, `scripts/intelligence-eval.js`, `docs/intelligence/*`. No source file under `src/` was changed by Phase 0 itself; the later A-001 slices did change `src/` (see "Status after A-001 slices" below).

**Headline:** most of the roadmap's "systems" already exist under other names. The real gaps are narrower: (1) context from LiveState/the PC never reaches recall or intent, (2) intent is a regex-and-keyword layer with a 52% offline score on new phrasings, (3) the permission model is a single flag (`risk: 'confirm'`) and approvals are one anonymous slot, (4) tool timeouts do not cancel, (5) events are untyped fire-and-forget with no ids, provenance or dedupe, (6) there is no persisted multi-step graph with branches, only a linear task list. Phases should extend these, not add parallel systems.

## 1. Execution path as it runs today

`src/main/main.js` builds one `ctx` and wires everything; there is no second pipeline. Text and voice both end in `orchestrator.send(sessionId, text, { source, speaker })` (`src/core/orchestrator.js`).

| # | Step | Where | What it does |
|---|---|---|---|
| 1 | Input | chat IPC (`src/main/ipc.js`), voice (`voice/controller.js` → speaker verdict → `send`) | `speaker` is `owner` / `unsure` / `guest`; anything unknown fails closed as guest |
| 2 | Session | `core/session.js` | message pushed with send time; non-owner messages marked |
| 3 | Memory hook | `memoryBlock.onUserMessage` | a correction ("no, that's wrong") weakens last turn's recalled items |
| 4 | Pending-question merge | orchestrator `pendingAsk` | a ≤6-word answer is read with the request it answers |
| 5 | LiveState snapshot + follow-up | `livestate/index.js`, `livestate/followup.js` | "again", "undo that", "continue" resolved from recent tools/groups |
| 6 | **Deterministic fast path** (owner only) | `fastPath` chain in `main.js:354` | `confirm.handle` → memory skill → lyrics → tasks → media → `askOrDecline` (`skills/clarify.js`) → `instant` (time/date/maths/units) → `liveInstant`. First non-null wins, no model call. Non-owner gets only pure-read `instant` |
| 7 | Route plan | `brain/plan.js` over `brain/router.js` (regex) + `skills/select.js` | tier, think, tools on/off, depth/steps, picked skill groups (max 2, threshold 2), confidence high/medium/low; cooldown of failing tools/models |
| 8 | Low confidence | `select.js selectWithModel` | one constrained model call picks a group or ask/decline (4 s budget); fallback is the rule result |
| 9 | Prompt | `brain/prompt.js` via `promptInfo` | profile memory, media line, "Right now" LiveState line, caps line, group hints |
| 10 | Recall | `memory/block.js forTurn` → `cortex.recall` | ≤500 chars, FTS + vectors + 2-hop spreading; saved on the user message so later turns resend the same text |
| 11 | Model rounds | `streamRound` → provider (`providers/ollama.js`) | ≤5 tool rounds (+2 for 3+ step requests); tools ranked best-first by `skills/rank.js` |
| 12 | Tool call | `tools/constrain.js repairCall` → `registry.js run` | guest allowlist → taint check → `checkArgs` → run with `Promise.race` timeout |
| 13 | Confirm | `risk: 'confirm'` tool calls `confirm.propose`; turn ends with the question; next owner turn's plain "yes" runs it (`pc/confirm.js`) | |
| 14 | Claim check | `brain/guard.js` | unbacked "I did X" claims retracted and redone once; ungrounded figures checked once; soft-fail results never back a claim |
| 15 | After turn | `memoryBlock.afterTurn`, memory scheduler (idle only), metrics, LiveState via the bus | |

Multi-step: `tasks/runner.js` (via `task_*` tools and `tasksFast`) runs a stored linear step list through the same `tools.run`, write-ahead status per step, taint rules, resume asks before re-running a step cut off mid-call.
Proactive: `proactive/engine.js` + monitors (timers-soon, sysmon threshold) push text; they "never act".

## 2. Existing-system inventory (Roadmap §0.2)

Maturity: **S** solid and tested, **P** partial, **N** none.

| Roadmap system | What exists | Maturity | Does not do | Phase it affects |
|---|---|---|---|---|
| Orchestrator | `orchestrator.js` (610 lines): one turn loop, retries, escalation, claim guards, guest/unsure lockout, window fitting | S | no objective object, no plan across turns except `tasks` | 2, 4 |
| Brain / intent router | `brain/router.js` regex → tier/depth/steps; `skills/select.js` weighted trigger words; `clarify.js` hand-written ask/decline lists; `instant*.js` | P | no structured intent (objective, entities, constraints, side effects); phrase lists are the primary mechanism | 2 |
| Skill/tool discovery and ranking | 19 skill groups, 98 tools; `select.js` (group), `rank.js` BM25-style lexical over name/aliases/hint/description/`examples` (14 tools have examples); `selectWithModel` for low confidence | P | no semantic (embedding) retrieval of capabilities; no availability/health/permission filtering; group cap 2 | 2 |
| Tool registry / capability contract | tool = `{ name, description, params, run, hint, aliases, mistakes, risk, needsClean, untrusted, direct, timeoutMs, examples }` | P | no capability id/category, side effects, reversibility, cost, idempotency, cancellation, verification, supported-system fields | 2, 4, 5 |
| Model / thinking routing | router hints + `ollama.js resolveModel` (installed models, VRAM-aware swaps, cooldown of failing models), `hints.avoid`, `prefer: fast` | S | routing keys on regex, not on measured uncertainty | 2 |
| Argument validation | `tools/args.js` coercion + `constrain.js validateArgs`; bad args never run the tool | S | undeclared keys are kept (tested, GAP); nested/prototype keys not examined | 5 |
| Conversation/session, context carry, clarification | `session.js`, `pendingAsk`, `lastGroups` (15-min TTL), `livestate/followup.js`, `clarify.js` | S | reference resolution only for "again/undo/continue/short answer"; no entity coreference ("the file we were working on") | 1, 2 |
| Cortex | `cortex/*` SQLite (nodes, edges, provenance, sources with trust, FTS5, vectors, events), recall = FTS + vector (RRF) + 2-hop spreading + freshness/confidence/importance/usage scoring, contradiction and duplicate handling, consolidation, maintenance, backups. 14 files | S | recall takes a `context` string but **no caller passes one** (see §4 G1); sensitivity/access classes not present | 1 |
| Embedding / semantic search | `cortex/embedder.js` (Ollama nomic-embed-text 768d), `vectors.js` (in-process matrix) | S | only used for memory; not for tools or capabilities | 1, 2 |
| Graph / spreading activation | `cortex/edges.js`: 12 edge types with half-lives and fan-out caps, `supersedes`, `contradicts`, `same_as` | S | no `depends_on`, `caused_by`, `resulted_in`, `belongs_to` for projects/tasks/files | 1 |
| Consolidation / contradiction | `consolidate.js`, `nodes.js` slot conflict policy, `cortex.isCorrection/weaken` | S | corrections only weaken last turn's recalled ids | 1 |
| LiveState | `livestate/index.js`: in-memory metadata (voice state, last 8 tools, route, turn ms, failed models) + pull sources (active window, media playing bool, timers, pending confirm, active task, last groups); persisted metadata-only | S for what it is | not world state: no apps, processes, devices, projects, health, per-fact observed/inferred/stale labels, no event history | 3 |
| Events | `bus.js` 27 lines: `emit(type, payload)` → `{type,t,...}`; sync delivery; `*` subscriber; listener errors isolated. Bridge `publicEvent` allowlists fields for the wallpaper | S as a bus | no id, correlation, source/trust, dedupe, priority, retention, backpressure, async delivery | 3 |
| PC automation | `pc/host.js` + PowerShell host, allowlist of apps, `safePath` roots, `actions-log.js`, undo journal | S | see §5 | 4, 5 |
| Browser/web | extension link (`media/ytmusic-link.js`, key + origin), `browser.js` tools, `net/public-fetch.js` (https only, DNS-rebinding guard, redirect cap), `net/fetcher.js` allowlisted | S | n/a | 5 |
| Voice | `voice/*`: Whisper/Windows STT, Piper TTS, VAD, wake, speaker recognition (owner/unsure/guest) | S | n/a (untouched) | n/a |
| Timers, reminders, proactive | `timers/*`, `proactive/engine.js` (priority, quiet hours, DND, cooldown, per-hour cap, duplicates collapse) | S | relevance is not event- or task-aware | 3 |
| Workflow / tasks | `tasks/plan.js` (validation, `$ref` of earlier results, expectations), `runner.js`, `store.js` (JSON files), pause/cancel/replan (max 2), crash sweep | P | linear only: no parallel, conditional, alternative, failure branches, per-step approval records, dry run, verification step | 4 |
| Permission / confirmation / security | taint model, `risk: 'confirm'`, guest allowlist, `speaker` lockout, `safePath`, `public-fetch`, bridge origin/host checks, `guardWebContents` | P | see §5 | 5 |
| Diagnostics / metrics / tests | metrics JSONL + dashboard, `self_diagnostics`, `self_log`, 1673 tests (Phase 0 count), offline benches (`skill-accuracy`, `orchestration-bench`, `cortex-*`) | S | no per-decision trace (why this group/tool was rejected) | 2, 5 |

## 3. Architecture ownership (Roadmap §0.6) mapped to real modules

| Roadmap role | Real owner today | Phase work is |
|---|---|---|
| Cortex | `src/core/cortex` | keep; add relationship types and metadata only if Phase 1 proves a need |
| LiveState | `src/core/livestate` | extend (Phase 3), do not add a second state store |
| Event infrastructure | `src/core/bus.js` | extend the envelope, keep the API (Phase 3) |
| Context Engine | **did not exist as a unit at Phase 0** (now `src/core/context/assemble.js` + `providers.js` exist: live and task providers wired, memory provider not wired). At Phase 0 the pieces were: Pieces: `memory/block.js` (recall), `promptInfo` in `main.js` (media, profile, live line, hardware), `plan()` (live → routing) | a thin assembler over these (Phase 1), not a new store |
| Intent Engine | **does not exist.** Pieces: `router.js`, `select.js`, `clarify.js`, `instant*.js`, `followup.js`, `selectWithModel` | structured intent object produced from those (Phase 2) |
| Capability discovery | `skills/select.js` + `skills/rank.js` over the tool registry | add semantic retrieval and availability filtering there (Phase 2) |
| Orchestrator | `orchestrator.js` | stays the only turn pipeline |
| Workflow engine | `tasks/*` | extend to a graph only if Phase 4 justifies it |
| Security authority | **spread across** `registry.js` (taint, guest, args), `confirm.js`, `pc/paths.js`, `net/*`, `brain/guard.js`, `tasks/runner.js` (re-checks taint) | consolidate behind the existing `registry.exec` boundary (Phase 5) |
| Verification | per tool, ad hoc (`media` verifies state, `files` re-reads names after rename, zip re-lists) and `brain/guard.js` for claims | a declared `verify` per capability (Phase 4) |

## 4. Verified gaps and limitations (as of Phase 0, before the A-001 slices)

| ID | Gap | Evidence | Needed by |
|---|---|---|---|
| G1 (slice 1 done: owner turns now pass app, window title if enabled, and active task title; cross-system assembler slice implemented 2026-11-13, see `adr-log.md` A-001, measured below on fakes) | Recall's `context` parameter (lexical nudge from "what the user is doing now") exists in `cortex/recall.js:106` and `memory/block.js:13`, but the orchestrator call (`orchestrator.js:316`) never passes it and `memory/system.js` has no `context`. LiveState's active window, media, task and last groups never influence recall | grep of all callers | 1 |
| G2 (done in commit 27e666e, with two modes: mid-chat "continue" recalls the previous user message, an opening "continue" uses window/task, else the newest earlier chat; for whole-message "continue / carry on / pick up where we left off": uses window or task, else newest earlier chat) | Recall cannot answer "what are we working on / continue where we left off": it is a per-message query with `previousUserText` only when the message has <3 tokens | `block.js:15-16` | 1 |
| G3 | Rule-layer intent: 52.1% on the new 71-row set; 1 of 8 non-action sentences ("how do I shut down a computer") avoids loading an action group; injection-shaped text loads `pc`/`browser` groups | §6 | 2 |
| G4 | The existing "fresh" skill set is 76.3%; known misses are paraphrases the trigger words do not cover. Decline/ask are three narrow hand-written regex lists (`clarify.js`) | `sa_fresh` | 2 |
| G5 | `risk` has 3 values in practice: `confirm` (11 tools), `safe` (49) and unset (38). Code reads only `=== 'confirm'`; `'safe'` is documentation. `safe` includes writes (`zip_files`, `unzip`, `copy_files`, `make_folder`, `clipboard_write`, `set_system_volume`, `bluetooth_set`, `audio_output_set`); unset includes writes (`ytm_playlist_edit`, `forget_memory`, `cancel_timer`, `monitor_set`) | catalog dump | 5 |
| G6 | `tasks/effects.js READ_ONLY` is a second hand-kept list (45 names) of what the tool metadata should say; it already disagrees in kind with `risk` | file | 4, 5 |
| G7 | A tool timeout is `Promise.race` (`registry.js:93`): the caller gets "timed out", the tool keeps running (tested). 20 tools set `timeoutMs`; the signal in `ctx` is the turn's, never aborted by the timeout | `GAP` test 7 | 4, 5 |
| G8 | Approval is one anonymous slot: a new `propose` silently replaces the pending one; no approval id, action fingerprint or session binding (tested). Replay is already prevented (consumed once, 60 s TTL, owner-only fast path) | `GAP` test 4 | 4, 5 |
| G9 | Undeclared tool arguments pass through (tested) | `GAP` test 5 | 5 |
| G10 | File tools validate a path string with `safePath` and then re-use the string with `renameSync`/`writeFileSync` etc. (`wx`/`COPYFILE_EXCL` only stop overwrites): validate-then-use race with junction swaps; no handle-based ops | `GAP` test 11 | 5 |
| G11 | `bus.emit` events carry no id/source/trust/correlation; delivery is synchronous in-process; no dedupe or backpressure. Only `net` and tool events carry provenance-like fields | `bus.js` | 3 |
| G12 | World state is one metadata ring: no apps, processes, devices, projects. Each source returns "now" with no observed-at or confidence, except media (60 s) and timers | `livestate/index.js` | 3 |
| G13 | Tasks are linear; no step approval record, no dry run, no independent verification step, no branches | `tasks/plan.js` | 4 |
| G14 | Intent decisions are not recorded: why a group/tool was picked or rejected is lost (only the route event and the metrics counters survive) | orchestrator | 2, 5 |
| G15 | Cortex recall bench gates failed on this run (p95 19.0 ms vs 15; rss delta 71.8 MB vs 64) while the 2026-11-12 pass had them green (11.7 ms). Run was concurrent with other work (tests had just finished); **not re-run in isolation**, so noise vs regression is unresolved | bench output | 1 |

Not gaps (preserve): corrections weaken recall; contradiction/duplicate/stale handling in recall; taint propagation into tasks; guest default-deny; crash-safe task steps; DNS-rebinding guard; bridge allowlist; claim guards; the instant/skill fast paths.

## 5. Security baseline (Roadmap §0.4)

Authorization points, in the order a tool call meets them: speaker lockout → guest allowlist (`registry.js:20`) → `risk:'confirm'` needs clean turn (`tainted`) → `checkArgs` → run. Confirm tools only *propose*; the action runs from `confirm.handle`, which sees only the user's own words and only for the owner (non-owner turns skip the whole skill chain).

| Question | Finding | Evidence |
|---|---|---|
| Does every execution path pass authorization? | Model tool calls: yes (`exec`). Tasks: yes, through `tools.run` (so guest/taint/args apply) plus their own re-check of taint on confirm steps. Fast-path skills (media, timers, memory, lyrics) act without `exec`: they are owner-only and take only the user's text | `main.js:354`, orchestrator owner gate |
| Operation-specific permissions? | No. One flag; see G5 | catalog |
| Approvals bound to exact action? | Bound to "the one pending action" for 60 s; not to an id/fingerprint/session | test 3, 4 |
| Replay? | Prevented (single consume, TTL) | test 3 |
| Untrusted content influences execution? | Contained: 25 tools flagged `untrusted` taint the turn; confirm tools and memory writes (`needsClean`: remember, forget_memory, monitor_set) refuse a tainted turn; tasks keep the taint across resume. **But** the rule layer still *offers* action tools on injection-shaped text (G3); the barrier is the taint/confirm model, not the selector | tests 1, 8; eval `untrusted-content` 0/2 |
| Filesystem / network | Paths: roots, UNC/device/ADS/drive-relative refused, realpath of nearest parent (tested). Check-then-use race remains (G10). Network: public fetch https-only, resolved-address check inside the socket lookup, 3 redirect cap, size cap (tested); the bridge binds 127.0.0.1, host and origin checked, event fields allowlisted | tests 10, 12, 13; `bridge.js` |
| Timeouts / cancellation | The turn's `AbortSignal` is real (user stop, model timeout). Tool timeout is not (G7). The task runner stops at step boundaries only | test 7 |
| Duplicate side effects | Tasks: a step "running" at restart asks before re-run (tested). Tool-level: a timed-out then retried call can run twice (task runner retries once on non-`NO_RETRY` errors, and `timed out` is in `NO_RETRY` so it does not, but a model re-issuing the call is blocked only by the exact-call de-dup within a turn) | `runner.js:10`, orchestrator `seenCalls` |
| Secrets in logs | Not audited in Phase 0: the metrics store holds no conversation text (per the 11-12 audit); I did not scan `jarvis.log` / `actions.log` writers for argument redaction. `actions.log` stores `args` of confirmed PC actions | `confirm.js:45`; **unverified** |
| IPC | `src/main/ipc.js` and `guardWebContents` were not traced in Phase 0 | **unverified** |

`test/baseline-security.test.js` (13 tests, all passing) pins six boundaries that hold and four gaps as they stand today. A later phase that fixes a gap must replace that test deliberately.

## 6. Measured baselines (all offline, this machine, 2026-11-13)

| Measure | Result | Command |
|---|---|---|
| Full suite | **1673 tests at Phase 0** (1660 before my additions + 13 new, 0 fail, 19.5 s); **1730 tests, 0 fail after the A-001 slices** | `npm test` |
| Skill selection, tuned set | 100% (101) | `node scripts/skill-accuracy.js` |
| Skill selection, heldout (no longer independent) | 100% (45) | `--set heldout` |
| Skill selection, **fresh (never tuned)** | **76.3%** (act 26/31, ask 0/2, decline 0/2, answer 3/3) | `--set fresh` |
| Orchestration decisions | 89% (284/319): route 26/26, instant 26/26, live 16/16, ask 12/12, context 8/8, models 11/11, runtime 4/4, **tool top-3 128/149 (86%), top-1 104/149 (70%)**, tool-learned 53/67 | `node scripts/orchestration-bench.js` |
| **Intelligence eval v1 (new)** | **52.1% (37/71)**; 13 non-action rows still load an action group; rule layer 0.4 ms/request | `node scripts/intelligence-eval.js` |
| Cortex recall (50k nodes) | p95 19.0 ms (gate 15), upsert 0.35 ms, open+first recall 278 ms, db 53.7 MB, rss delta 71.8 MB (gate 64). **Two gates red on a noisy run; not re-run alone (G15)** | `node scripts/cortex-bench.js` |
| Context assembler (cross-system slice, **fakes**) | 200 runs, timeoutMs 40, budget 800 chars: healthy p50 0.24 ms / p95 0.44 ms; one throwing provider p50 0.27 / p95 0.46 ms (200 errors recorded); one hanging provider p50 47.15 / p95 48.09 ms (bounded by the timeout, 200 errors recorded). Package 741 chars, 10 items, hint 143 chars; never over 800 (max 774 over all runs). Dropped in the mixed sample: budget 16, access 2, invalid 1, stale 1, superseded 1, duplicate 1. **Limits:** fake LiveState/tasks/memory block, no real Cortex store, no live model, no disk: shows assembler overhead and the timeout bound, not retrieval quality. Numbers are from one run on this machine. | `node scripts/context-bench.js` (`--json`) |

Intelligence eval v1 by category: direct 5/5, indirect 3/6, unusual 3/5, slang 2/5, follow-up 4/6, multi-system 3/5, historical-context 3/6, ambiguous 2/6, missing-prerequisite 5/6, unavailable 4/7, **must-not-act 1/8**, requires-authorization 2/4, **untrusted-content 0/2**. Full miss list: `node scripts/intelligence-eval.js`. Stored: `docs/intelligence/baseline-intelligence-eval-v1.json`.

How to read it: the rule layer *offers* tool groups, the model still chooses, and risky tools still need the user's yes. "must-not-act 1/8" therefore means tools are offered on chatter ("tell me a joke about timers" loads `timers`), not that actions run. It is still the wrong direction for Phase 2: a wrong exposure plus a small model is how a false action starts.

**Limits of this baseline (do not oversell it):** the 71 rows are written by one author (me) in one sitting, labelled from the request, not independent; they test the rule layer only, not the model's tool pick, argument construction, wording, execution or verification; latency, token and model-call counts for live turns, workflow reliability, and retrieval relevance on a real store were **not measured** (they need the live model and the user's data: `node eval/run.js`, not run, GPU in use per the earlier pass).

## 7. Overlap risks (Roadmap §0.3) and what to do about each

| Risk | Where it would appear | Decision |
|---|---|---|
| Context Engine becomes a second Cortex | Phase 1 | It assembles from `cortex.recall`, `live.snapshot()`, `sessions`, `tasks.active()`; it owns no table |
| World-state becomes another LiveState | Phase 3 | Add entity sources to LiveState's `register()`; keep metadata-only rule |
| Capability discovery becomes another registry | Phase 2 | Add optional fields to the tool definition; `rank.js` stays the single ranker |
| Event layer becomes another orchestrator | Phase 3 | Keep `bus.js`; extend the envelope; consumers only update LiveState/notify |
| Workflow bypasses orchestration/security | Phase 4 | Keep calling `tools.run`; steps are subject to the same guard |
| Second permission framework | Phase 5 | Replace the `READ_ONLY` set and the `safe/none` convention with a field on the tool; keep `registry.exec` the only gate |
| Second memory ingest | Phase 1 | Use `memory/extract.js` and `cortex` verbs |

## 8. Dependency map (who must change together)

`tools/registry.js` ← every tool and skill group, `tasks/runner.js`, `main.js`, `skills/rank.js`, tests `tool-registry-consistency`, `untrusted-flags`. A new optional tool field is backward compatible; changing `exec` semantics touches all of them.
`orchestrator.js` ← `brain/plan.js`, `skills/select.js`, `memory/block.js`, `livestate`, `voice/controller.js`; tests `orchestrator*`, `routing-integration`, `livestate-orchestrator`.
`bus.js` ← metrics collector, bridge (`publicEvent` allowlist), LiveState, proactive, memory scheduler, voice controller, self checks. Adding envelope fields is compatible; the bridge allowlist already drops unknown fields.
`cortex` schema ← `migrations/001-schema.js` only; persisted at `<data>/cortex.db`; any change needs a numbered migration and the backup path in `maintenance.js`.

## 9. Proposed sequence and gate status

| Phase | Gate A recon | Proposed first slice (smallest change that closes a verified gap) |
|---|---|---|
| 0 | **done** | this document, the baseline tests and eval set |
| 1 | partial (cortex, block, plan traced; session/IPC not) | wire LiveState/active-window/task into the existing `context` argument of recall (G1); a "what are we working on" lookup from `tasks.active()` + last groups + recent chat summary (G2). No new store |
| 2 | partial | declare `examples`/`category`/`sideEffects` on tools; semantic rerank of low-confidence turns with the existing embedder; record the decision (G3, G4, G14); target is the eval rows, measured against §6 |
| 5 (security items G5, G7-G10) | partial | the roadmap says security applies from Phase 0; the cheapest, lowest-risk items are G9 (reject undeclared args, default on a flag), G7 (abort signal on timeout + `ctx.signal` actually aborted), G8 (id + fingerprint on the pending slot) |
| 3, 4 | not started | depend on 1 and 2; ADRs A-005 to A-007 in `adr-log.md` |

**Status after A-001 slices:** Phase 1 slices for G1 and G2 and the cross-system context assembler are implemented (commits 27e666e, 5a9c6cf, dbe4ac8, 05f6dae, c47d8c8, 23272e2, 154c36f; see `adr-log.md` A-001 for what is not done). The table above is the Phase 0 proposal. The remaining phases are not started. Before Phase 2 starts, read §4 and the ADR log; `adr-log.md` lists the decisions I would ask you to approve.

## 10. Not verified in Phase 0

Live-model behaviour and every number that depends on it; `src/main/ipc.js`, `guard.js` content, `windows.js`; `voice/controller.js` beyond how it calls `send`; log redaction; token counts; whether `cortex-bench` red gates are noise; extension code. Existing docs (`source-of-truth.md`, `orchestration-pass-2026-11-12.md`, `audit-2026-11-12-results.md`) were read and cross-checked against code for the facts used here; two statements were re-measured (skill-accuracy, orchestration-bench) and match.
