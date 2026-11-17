# Phase 2B — Dynamic Tool Calling & Execution Intelligence (design)

Status: draft for approval. Date: 2026-11-13. Branch: feat/jarvis-audit-pass.
Development rule (user): all implementation subagents use Sonnet 5.5 at medium effort.

## Intent

Jarvis should work out what a request needs, discover which tools can do it
(even when the user's words share nothing with tool names), combine them in the
right order, adapt to real results, recover from failures, and stop when done,
without weakening any security boundary. Do not just improve the keyword
matcher; change how the tool decision is made.

## Findings that shape the design (recon, HEAD 682a853)

- Selection is group-level only (`skills/discover.js` `resolveSelection`, `intent.js`). The
  chat model then sees every tool of the chosen groups with full schemas. BM25
  (`skills/rank.js`) reorders, never filters.
- `embed` is an optional parameter of `createOrchestrator`; likely unwired in
  `main.js` (to verify). Cortex embedder is used for memory only.
- Tool metadata is thin: `risk` only; side effects derived from a hand-kept
  `READ_ONLY` set (`tasks/effects.js`). ADR A-004 (`effect/reversible/idempotent/verify`) planned, unbuilt.
- Loop (`orchestrator.js:384`) is serial, 5 rounds (+2 if steps>=3). Per-turn duplicate
  guard (`seenCalls`) cannot tell read from write. No cross-turn idempotency ledger.
- Tools are never retried in chat; after 2 failures a tool is blocked.
- Security chokepoint: `tools/registry.js exec()`/`scopedRun` (guest allowlist, taint,
  args check, timeout). Taint from an untrusted result applies only after the
  result returns (`orchestrator.js:548`), unsafe for parallel batches.
- Results are plain strings; follow-ups carry group ids only, not entities/results.
- Task runner (`tasks/runner.js`) already has write-ahead state, retry, replan, `$ref` chaining;
  reuse its ideas, do not duplicate it.
- Evals score group selection only; real-model (Ollama) bench never run.

## Goals

1. Tool-level hybrid discovery (lexical + semantic + metadata filters + model),
   so the model sees top-K relevant tool specs, not whole groups.
2. Per-tool contract: effect (read/write/external), idempotent, reversible, verify, requires.
3. Adaptive loop: decide if a tool is needed, re-discover after results, parallel
   reads, chained results, wrong-tool detection, recovery, clean stop, budget.
4. Working memory: structured results and entities per session so references
   ("that file", "continue the previous task") resolve and done work is not repeated.
5. Idempotency/execution ledger across turns for side-effecting calls; result verification.
6. Measurable eval vs the current implementation.

## Non-goals

- No new registry, executor, router, or task system; extend `registry.js`,
  `skills/*`, `orchestrator.js`, `tasks/*`.
- No loosening of guest/taint/confirm rules; no model-granted permissions.
- Not rewriting the fastPath skills, voice, or Cortex memory.
- No MCP/runtime third-party tool registration (static registry stays).

## Anti-goals (failure even if tests pass)

- More tokens or latency for simple commands (simple commands stay model-free).
- Any path (parallel, chained, retried, autonomous) that bypasses `exec()` security.
- Eval numbers that only pass because fixtures were tuned to the implementation.

## Approaches considered

- **A (chosen): tool-level discovery on top of `resolveSelection` plus adaptive loop**
  inside the existing orchestrator and registry. Reuses everything; groups remain
  the availability/permission unit.
- B: plan-first DAG executor. Rigid, contradicts deciding the next step from results.
- C: expose all tools to the model. Token cost scales with registry; fails large-registry goal.

## Design (approach A)

### 1. Tool cards and contracts (`skills/capability.js`)
Per-tool card `{name, groupId, summary, params digest, effect, idempotent, reversible,
verify?, requires[], available}`. Declared on the tool when present; otherwise derived
(confirm => write; `READ_ONLY` => read; unknown => write, fail closed). Registry
consistency test extended; `tool-manifest.json` kept in sync.

### 2. Discovery (`skills/discover.js`, `rank.js`)
Stage: group gate (existing) -> candidate tools from allowed groups AND from a
global tool index when groups are unsure -> hybrid score (BM25 over card text +
embeddings, cached per tool, + metadata filters: availability, guest/taint
eligibility, effect vs request) -> top-K specs sent to the model (K small, adaptive).
A `find_tools` meta-tool lets the model request more tools mid-turn (counted in the
existing `MAX_EXTRA_LOADS` budget, same security checks before loading). Outcome
"no capable tool" is explicit (decline/ask, never an invented tool). Wire `embed` in
`main.js` with the 250 ms cap and BM25 fallback when unavailable.

### 3. Execution layer (`registry.js`, `orchestrator.js`)
- Round batching: calls in one round that are all `effect=read` and independent run
  in parallel; any write/external/confirm call runs alone and in order.
- Taint rule: results from `untrusted` tools in a batch taint the turn before any
  later non-read call is authorized.
- Ledger: per-session record `{key(name+normalized args), effect, status, resultRef, ts}`;
  duplicate write/external calls are refused or returned from the ledger; duplicate reads
  are served from the cache within a TTL. Replaces the blunt `seenCalls`.
- Recovery policy by failure class: transient -> one retry with backoff; bad args ->
  `repairCall`; unavailable/wrong tool -> re-discover excluding it; unrecoverable -> stop and
  report. Timeouts and aborts are classified. Tools declaring `verify` are checked after action.
- Everything goes through `exec()`; no second authorization path.

### 4. Working memory (`context/*`, `livestate/*`)
Session store of structured tool results (id, tool, entities such as file/path/url/title,
short summary, full text capped) feeding: reference resolution in the interpreter hint,
"continue the previous task" (last goal + remaining steps), and ledger lookups.
Prompt block is compact and counts against the existing context budget.
Retrieved content stays marked untrusted.

### 5. Adaptive loop (`orchestrator.js`, `brain/*`)
Per turn: need-a-tool check (chat/knowledge answerable -> no tools, no extra tokens),
discovery, call rounds, after each round evaluate: objective met / result incomplete (re-discover
or call more) / wrong tool (reconsider, exclude) / unjustified to continue (stop).
Round and token budgets scale with task complexity; cap remains enforced.

### 6. Evaluation (`scripts/`, `test/fixtures/`)
New fixtures + bench covering: unfamiliar phrasing, ambiguity/references, large synthetic
registries (100-500 tools), multi-tool workflows, sequential vs parallel, wrong-tool recovery,
missing capability, malformed args/failed execution, approval-required actions, duplicates and
partial failures. Metrics: tool-selection accuracy, task completion, unnecessary calls,
execution failures, latency, token overhead. Runs baseline (current code path) vs new, with the
fake oracle in CI and optional live Ollama via flag. Held-out fixtures not used for tuning.

## Constraints

- Node, `node:test`; `npm test` stays green (currently 1792 pass). Windows host.
- Ollama-only provider; constrained decode available (`constrain`), small models.
- Guests remain default-deny; confirm tools only propose; user words resolve confirmations.

## Increment order (each ships green with tests)

1. Tool cards/contracts. 2. Discovery + `find_tools` + embeddings wiring. 3. Execution layer
(ledger, parallel reads, recovery, verify). 4. Working memory. 5. Adaptive loop. 6. Eval + final
review (duplication, security gaps, perf, incomplete paths).

## Author's calls (from builder check; change any you disagree with)

1. **Duplicates.** Ledger key = tool + normalized args + session, with a short TTL (default 60 s) for
   writes/externals. A hit returns the recorded result marked "already done" instead of re-running.
   A deliberate repeat ("send it again", "add another") is recognised by the interpreter's
   `kind` (modify/new with repeat intent) and by the user's own words in the current turn, and
   passes a `force` flag that only the orchestrator (never the model) can set. Tools with
   `idempotent=false` and no `force` are never silently re-run.
2. **Eval gates.** Existing group-selection evals must not regress (fake oracle: v1 >= 62/71, v2 >= 27/31;
   rule-only baseline unchanged). Simple commands: zero model calls and no added latency on the fast
   path (existing guard stays). Overhead budget for non-simple turns: tool-spec tokens must drop vs
   baseline on large registries; extra model calls per turn <= 1 by default. The fake oracle simulates
   model tool choices from a scripted policy, so loop behaviour (recovery, completion, chaining) is
   measurable in CI; live Ollama is an optional flag, not a gate.
3. **Adaptive evaluation is heuristic first.** Signals: empty result, error class, repeated call,
   result lacking requested entity, `verify` outcome. No extra model call per round; the chat
   model itself decides the next call from the structured result plus a short status note. A
   constrained model call is allowed only on a flagged ambiguity, once per turn, within the 1-call budget.
4. **Working memory.** In-memory, per session, owner only (guests get none, so no leakage), TTL 15 min
   like `lastGroups`, capped size, cleared on restart. Same store serves voice and chat for the owner's
   session. Content stays marked untrusted and is never promoted to instructions.
5. **Ineligible tools.** Discovery hides tools the caller cannot use (guest/taint) from top-K, but
   records them so the outcome can be "not permitted" rather than "no capable tool". `find_tools`
   applies the same eligibility checks, and `exec()` remains the only authority.
6. **verify.** Declarative: `verify: {tool, args: (callArgs, result) => args, expect}` naming a read tool
   already in the registry. Added in increment 1 only to a few high-value tools (file write/open,
   timers/reminders, media control); a verify failure is reported as a partial failure, not auto-retried.
7. **Retries.** Automatic retry only for `effect=read` or `idempotent=true` tools. A timed-out write is
   not retried; it is checked via `verify` if declared, else reported as unknown outcome.

## Left to the builder

Exact K, TTLs, budgets and thresholds (tuned by eval); card text format; ledger storage
(in-memory per session vs persisted); naming of new modules (prefer extending existing files).
