# Phase 2 — Dynamic Intent & Capability Discovery Plan

Spec: docs/intelligence/adr-log.md A-002 + user brief (Phase 2). Extend, never duplicate.

## Global Constraints
- Extend existing: `src/core/skills/select.js` (`selectWithModel`), `skills/rank.js`, `skills/index.js` catalog, `providers/*.constrain`, `brain/plan.js`, `orchestrator.js`. NO new registry, router, or context system.
- Deterministic fast paths (orchestrator fastPath chain, instant, confirm) stay untouched and run BEFORE any model call. Simple-command latency must not regress (no model call when rule confidence is high AND group is read-only/safe).
- Interpretation never grants permission. `risk:'confirm'`, taint, GUEST_TOOLS, owner-only fastPath all still decide. Intent output can only choose among catalog group ids; invented ids dropped.
- Model output untrusted: validate against schema; malformed/timeout/null provider -> fall back to current rule result (never throw).
- Local-only (Ollama `constrain`), budget 4000 ms default, injected provider + clock for tests.
- Tests: node:test + node:assert/strict in test/*.test.js; use test/helpers/fake-provider.js `constrain`. Full `npm test` must stay green. Code comments explain why; files small (<250 lines); LF endings; conventional commits.
- Baseline: `node scripts/intelligence-eval.js` = 52.1% (37/71) rule-only.

### Task 1: Capability metadata
Add optional `category`, `sideEffects` ('none'|'read'|'write'|'external'), `requires` (string[] e.g. 'browser','owner'), plus group `summary` to tool/group defs; define schema + validator in `src/core/skills/capability.js`; `buildCatalog` exposes `catalog.cards` (per group: id,label,summary,examples,sideEffects,available(from status()),missingReason). Populate for all 19 groups from existing hints/risk (derive sideEffects from tool `risk` + READ_ONLY list when unset; don't duplicate lists, import). Update tool-manifest consistency test if needed. Tests: cards complete, unavailable group marked, no invented fields.

### Task 2: Intent schema + interpreter
New `src/core/skills/intent.js` (single module): `INTENT_SCHEMA` (JSON schema for constrain), `validateIntent(raw, catalog)` -> `{kind:'new'|'followup'|'correction'|'modify'|'chat', objective, groups[], confidence 0..1, missing[], ask, decline, reasoning, status:'ok'|'invalid'|'timeout'|'unavailable'}`, and `interpret({text, history, lastGroups, hint, live, catalog, provider, budgetMs})` which builds prompt from `catalog.cards` (available only; unavailable listed as unavailable) and calls `provider.constrain`. Handles null provider, throw, timeout, malformed -> `{status:...}` with no groups. Groups not in catalog dropped. Replaces/extends `selectWithModel` (keep its export working, delegate). Tests: novel phrasing, followup/correction/modify kinds, malformed, timeout, invented group, unavailable capability -> decline.

### Task 3: Discovery + gating in select
In `select.js`/`rank.js`: semantic+lexical shortlist of capability cards (existing embedder via injected `embed` fn, lexical fallback using examples+hints), multi-group combination (max 3 when interpretation lists several). Gating: call `interpret` when rule confidence low/medium, OR when a rule-picked group has sideEffects write/external and text looks like discussion/question/quoted/ambiguous (reuse existing clarify patterns, no new giant regex list); never when high-confidence + read-only. Merge: rule result vs interpretation resolution; high-side-effect + confidence < 0.6 -> ask, not act. Tests: multi-capability, ambiguous side-effect asks, simple command makes zero provider calls, latency guard.

### Task 4: Orchestrator wiring + decision record
Wire in `brain/plan.js` / `orchestrator.js` (around line 262): pass history tail, `lastGroups`, assembler `hint`, live snapshot to `interpret`; use model-written targeted question for ask (length-capped, sanitized) instead of fixed text; kind followup/correction/modify carries previous groups; emit decision (kind, groups, confidence, reasoning, status, ms) on existing bus `route` event. Authorization untouched. Integration tests via orchestration-decisions style: contextual follow-up ("do that again but louder"), correction, ambiguous destructive request asks, unavailable tool declines honestly, guest/untrusted cannot gain tools, confirm still required.

### Task 5: Eval + bench + docs
Extend `scripts/intelligence-eval.js` with `--model fake|ollama` mode (fake uses a deterministic oracle via fake-provider constrain over fixture rows; ollama optional/skipped if unreachable), report per-category delta vs `docs/intelligence/baseline-intelligence-eval-v1.json`, and latency of simple commands (rule-only path p50/p95 unchanged). Add a few new fixture rows only in a new fixture version v2 (don't edit v1). Update docs/intelligence/adr-log.md A-002 status + phase0 gaps closed. Run full `npm test`.
