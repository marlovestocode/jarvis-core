# Architecture decision log (intelligence roadmap)

Status: the A-001 slices are implemented (see A-001 below); every other record remains **Proposed** and needs user approval before its phase starts.
Gap ids (G1..) are in `phase0-baseline.md` §4. Baseline numbers are in §6 there.

## A-001: Context assembly extends existing recall, no new store (Phase 1)
- **Status: first slice implemented 2026-11-13** (`livestate/context.js`, wired at `orchestrator.js` recall call, tests `test/live-context.test.js`). G2 slice implemented (commit 27e666e; `memory/block.js` CONTINUE + `lastWork`, `sessionId` passed from orchestrator).
- **"Continue" rule (G2) has two modes:** mid-chat, the previous user message (plus live context) is the recall query; an opening message (no previous message, or one with under 2 content tokens such as "yes") uses the newest earlier chat first with the live hint appended only as a nudge, recalled non-brief (commit e688cb7; first two-mode commit f4737c7). `test/orchestrator.test.js:415` was extended with `sessionId` (additive).
- **Cross-system slice implemented 2026-11-13** (commits 5a9c6cf, dbe4ac8, 05f6dae, c47d8c8, 23272e2, 154c36f): `src/core/context/assemble.js` (assembler: validate, redact, access, freshness, supersede, rank, dedupe, 800-char budget) and `providers.js` (livestate, tasks, memory), used by the orchestrator for the recall hint and wired in `main.js`. The hint is built only from an item's optional `query` (app name, task title), never from display sentences (commit 6640859); the orchestrator passes its one per-turn snapshot to the providers. Plainly: a thin assembler over existing sources was built (the earlier "module with providers" rejection is superseded by it); today production uses only its `hint` and counts. `text`, items, budget and supersede are groundwork for a future prompt block, and the memory provider is unwired for the same reason. The orchestrator emits a `ctxpkg` bus event (counts only, named to avoid the gauge event `context`). Measured on fakes by `scripts/context-bench.js` (see `phase0-baseline.md` §6).
- **Not done:** prompt block with freshness labels; file/project and browser/event providers; relationship expansion beyond Cortex's own; retrieval quality on a real store; live-model check; memory provider is not wired in production; the task-title taint label (the runner tracks `task.tainted` but `active()` does not expose it; before package text goes into a prompt, expose it and label such tasks untrusted); minor issue in `providers.js` (the `mem:<index>` id fallback when ids are missing); ISO dates like 2026-11-13 are redacted to `[number]` by the digit rule; the `ctxpkg` event is not consumed by metrics yet. Implemented rule: a previous user message with under 2 content tokens counts as no previous message.
- **Existing:** `memory/block.js forTurn` → `cortex.recall`; `promptInfo` in `main.js`; `plan()`; `live.snapshot()`.
- **Gap:** G1 (recall `context` arg never passed), G2 (no "continue where we left off").
- **Change:** one small function in `memory/` that builds the `context` string from LiveState (active window, media, active task, last groups) and passes it to `forTurn`. A "current work" lookup from `tasks.active()` plus the newest chat summary.
- **Alternatives:** new Context Engine module with its own store (rejected: duplicates Cortex/LiveState; a thin assembler over the existing sources was built instead, see above); do nothing (G1 stays).
- **Owns data:** none new. Cortex = history, LiveState = now.
- **Contracts:** `forTurn` already accepts `context`; backward compatible. No schema change.
- **Security:** context is information only. Guest and unsure turns get none (same as memory today). Window titles already gated by `config.livestate.windowTitle`.
- **Performance:** one extra lexical query, light weight 0.2 already coded. Skip on `brief` turns.
- **Failure:** any throw → empty context, turn unchanged.
- **Tests:** unit for the builder; recall test with and without context; orchestrator test that guest gets none.
- **Measure:** new retrieval rows (to write, with a real store) plus `cortex-bench` unchanged; eval history rows.

## A-002: Intent as a record built from existing layers (Phase 2)
- **Existing:** `router.js`, `select.js`, `clarify.js`, `instant*.js`, `followup.js`, `selectWithModel`.
- **Gap:** G3, G4, G14. Eval v1 52.1%, must-not-act 1/8, untrusted-content 0/2.
- **Change:** `select.js` returns, beside `picked`, a decision record `{objective?, groups, scores, rejected, confidence, clarify}`; add a cheap "this is chatter or quoted text" check before action groups load. No new engine module unless the record outgrows `select.js`.
- **Alternatives:** LLM intent call every turn (rejected: cost, latency, small local model); full Intent Engine module (deferred until the record proves too big).
- **Contracts:** `picked` array and its hidden `confidence` stay. Record is additive.
- **Security:** selection never grants anything; taint + confirm still decide.
- **Performance:** rule layer is 0.4 ms now; keep under 5 ms; model call only on low confidence as today.
- **Tests:** eval v1 must not drop in any category; `skill-accuracy` tuned sets stay 100%; fresh set must not fall below 76.3%.
- **Risk:** tuning to eval v1 rows. Rule: write a second, held-out set before tuning.

## A-003: Semantic capability retrieval via the existing embedder (Phase 2)
- **Existing:** `rank.js` lexical BM25 over tool text; embedder only used by Cortex.
- **Gap:** paraphrase misses (indirect 3/6, slang 2/5, unusual 3/5); tool top-1 70%.
- **Change:** embed tool name+hint+examples once, cached on disk, used only to rerank when rule confidence is low. Needs a decision: is Ollama embed model always up? If down → lexical only.
- **Alternatives:** write more `examples` (cheap, helps, overfits); skip (ceiling stays).
- **Compat:** no registry change. Cache is derivable, safe to delete.
- **Measure:** eval v1 indirect/slang/unusual, `orchestration-bench` tool top-3, added latency.
- **Open question for user:** accept a dependency of discovery on the embed model being installed?
- **Implemented (Phase 2B):** tool-level discovery embeds the tool cards through the existing embedder, wired in `src/main/main.js` (`createToolIndex({ embed: embedTexts })`). Embedding is capped at 250 ms per turn and never blocks: a slow or missing embed model falls back to lexical BM25, so the dependency is soft. The decision to depend on the embed model (question 2 below) is therefore not forced, but still needs the user's acknowledgement. Real-embedder recall is not measured (the eval uses a hashed fake embedder); see `phase2b-tool-intelligence.md`.

## A-004: Capability metadata as optional tool fields (Phase 2, 4, 5)
- **Existing:** tool = `{name, description, params, run, hint, aliases, mistakes, risk, needsClean, untrusted, direct, timeoutMs, examples}`.
- **Gap:** G5, G6.
- **Change:** add optional `effect: 'read'|'sensitive-read'|'write-reversible'|'write'|'destructive'|'admin'`, `reversible`, `idempotent`, `verify`. Derive `tasks/effects.js READ_ONLY` and the `risk` field from `effect`; delete the hand list. `risk:'confirm'` stays until every tool has an `effect`.
- **Compat:** fields optional. `test/tool-registry-consistency.test.js` extended to require `effect` on every tool once filled.
- **Security:** `effect` is declared by the tool author, never by the model or content.
- **Tests:** consistency test; classification review by user for the 98 tools (49 `safe` + 38 unset need a human look; list in baseline §4 G5).
- **Implemented (Phase 2B, deviation from the six planned values):** the tool field is `effect: 'read'|'write'|'external'` plus optional `idempotent`, `reversible`, `volatile` and `verify` (`skills/capability.js` `EFFECT_VALUES`, `skills/toolcards.js`). The six-value form (`sensitive-read`, `write-reversible`, `destructive`, `admin`) was NOT built: `risk:'confirm'` already carries the destructive/admin distinction, and `READ_ONLY` in `tasks/effects.js` stays the one read list the derivation falls back to. A tool that declares `effect:'read'` but has `risk:'confirm'` is treated as `write`. Classification review by the user is still open (decision 4 below). Measured effect: `docs/intelligence/phase2b-tool-intelligence.md`.

## A-005: Event envelope extension, same bus (Phase 3)
- **Existing:** `bus.js` (27 lines).
- **Gap:** G11, G12.
- **Change:** optional `id`, `source`, `trust`, `corr` on emitted events; dedupe + coalesce helper for noisy sources; keep sync delivery. LiveState gets entity sources via `register()` (apps, windows, devices) with `observedAt`.
- **Alternatives:** new async event bus (rejected: no consumer needs async; every consumer is in-process).
- **Compat:** bridge `publicEvent` allowlist already drops new fields. Existing events unchanged.
- **Open question:** which environment sources are wanted first (app launch/close? devices?). Need user priority before Gate B.

## A-006: Workflow graph only if linear tasks prove too small (Phase 4)
- **Existing:** `tasks/*` linear, write-ahead, taint-aware.
- **Gap:** G13.
- **Change (smallest):** add per-step `approval` record, `verify` step type, `dryRun` for steps whose tool declares it. Branch/parallel only if a real use case in the eval set needs it.
- **Alternatives:** DAG engine now (rejected: speculative).
- **Persistence:** extend task JSON, old files keep loading (missing fields = defaults).

## A-007: Security consolidation inside `registry.exec` (Phase 5; some items earlier)
- **Existing:** guest allowlist, taint, args check in `registry.exec`; confirm slot in `pc/confirm.js`.
- **Gap:** G7, G8, G9, G10.
- **Changes, in order of low risk:**
  1. G9: reject undeclared args when tool sets `strictArgs` (default off first, then on after tests).
  2. G7: create a per-call `AbortController`, pass its signal in `ctx`, abort on timeout; tools that ignore it still report "unknown outcome" not "failed".
  3. G8: pending action gets `id` + fingerprint (tool+args hash); `handle` checks it; second proposal while one pending = refuse or replace with notice.
  4. G10: handle-based ops for rename/write in `files.js`/`pc.js`. Largest change, Windows-specific. Needs its own ADR before work.
- **Compat:** each step has a test; the 4 `GAP` tests in `test/baseline-security.test.js` are replaced on purpose.
- **Not touched:** confirm TTL, owner-only fast path, taint rules.

## Decisions I need from the user
1. Approve A-001 as Phase 1 first slice?
2. A-003: ok to depend on the embed model for discovery?
3. A-007 items 1-3 now (small, security applies from Phase 0 per roadmap), or wait?
4. Who reviews the effect classification in A-004?
