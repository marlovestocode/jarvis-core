# Adaptive Reasoning and Model Orchestration — Design

Date: 2026-11-12
Roadmap item: 3 (adaptive reasoning and model orchestration), sub-project 2. Builds on the Live State foundation (`2026-11-12-live-state-design.md`).

## Goal

Let routing use the LiveState snapshot: decide fast vs deep, which tools to offer and which Ollama model serves the turn from the task, the recent tool and model failures, voice vs text and a pending confirm. Skip the LLM when a skill can answer a live-state follow-up. Do not retry a tool or model that just failed.

Success:
- Failed tools and models are avoided across turns for a short cooldown.
- A pending confirm and voice vs text change the route as described below.
- With live state absent, behavior is identical to today. Full test suite and `eval/run.js` stay green.

## Decisions (from brainstorming)

- Failure memory reaches across turns: a cooldown of about 2 min, nothing persisted.
- "Skip the LLM": follow-up resolution only. No new skill handlers, no read-only state answers; the `fastPath` chain is unchanged.
- Confirm and voice have minimal, bounded effects.
- Approach A: one pure `plan()` module wraps the unchanged `route()` and `selectGroups()`.

## Out of scope

New skill handlers, answering state questions from the snapshot, per-tool or per-model health scores, persistence across restarts, voice caps on tool rounds or tool-spec counts, any change to Cortex.

## Constraints

- Every new input is optional; absent live state equals today's behavior.
- `route()` and `selectGroups()` keep their signatures and behavior.
- Live state stores metadata only: never tool args, output text or error text.

## Component 1: `src/core/brain/cooldown.js` (new, pure)

`cooling(snap, now) → { tools: Set<string>, models: Set<string> }`.

- A tool cools when its weighted failures in the last 2 min reach 2: `ok:false` counts 1, `soft` counts 0.5, `ok:true` counts 0. Input is `snap.tools` (`{ name, ok, soft, t }`).
- A model cools by the same rule over `snap.models` (`{ name, t }`, each entry is one failure, weight 1).
- Missing or malformed input returns empty sets. Never throws.
- The cooldown applies only where an alternative exists (enforced by the consumers below).

## Component 2: `src/core/brain/plan.js` (new, pure)

`plan(text, snap, { source, lastGroups, fu, catalog, route, selectGroups }) → { hints, picked, avoid: { tools, models }, notes }`.

`route` and `selectGroups` are injected (no import cycles, easy tests). `plan()` runs them unchanged on `text`, then applies these rules in order; each fires only when its input exists.

1. **Follow-up `continue`** (`fu.kind === 'continue'`): this is the logic now inline in `orchestrator.js`, moved. `fu.groups` seeds `selectGroups` as `lastGroups`; when nothing beyond `core` is picked, `picked = fu.groups`; a chat route becomes `{ tier: 'deep', tools: true, think: false, reason: 'follow-up' }`. A `media` follow-up does not touch the route (the fast path serves it).
2. **Pending confirm**: `snap.confirm` exists, younger than 5 min, and the message is not a yes/no (`fu.kind !== 'confirm'`). A route with `tools === false` becomes `{ tier: 'deep', tools: true, think: false, reason: 'confirm pending' }`. If `snap.confirm.group` is set and known to the catalog, it is added to `picked`.
3. **Voice**: `source === 'voice'`, route is deep, `depth === 1`, `steps === 1`, `think` false, at most one non-core group picked, no confirm pending. Then `hints.prefer = 'fast'`. Never set for thinking or multi-step requests.
4. **Cooldown**: `cooling(snap)` → `avoid.tools` (returned for the orchestrator) and `avoid.models`; the most recent cooling model is set as `hints.avoid`.
5. **Notes**: short strings (`cooldown: web_search`, `confirm pending`, `voice: fast`) appended to the `route` event reason.

With `snap` absent, or on any exception, `plan()` returns exactly what the direct `route()` and `selectGroups()` calls return today.

## Component 3: LiveState model-failure ring (`src/core/livestate/index.js`)

- New bounded ring `models`: last 6 `{ name, t }`, entries expire with the same prune as tools (10 min).
- Fed by a new bus event `modelfail` `{ model }`. Only the model name is read from the event.
- `snapshot()` gains `models`; existing fields are unchanged.

## Component 4: `resolveModel` `hints.prefer` (`src/core/providers/ollama.js`)

When `hints.prefer === 'fast'` and `auto()`: return the fast model if it is configured, differs from the main model, is installed (`lastTags`), has the `tools` capability (via `lastModels` when known) and is not `hints.avoid`. Otherwise fall through to the existing logic. Without the hint the function is unchanged.

## Wiring

- `orchestrator.js`: when `live` is set, one `plan()` call replaces the direct `route()` and `selectGroups()` calls and the inline `continue` handling; `hints.avoid` flows into `resolveModel`; `currentSpecs()` drops `avoid.tools` unless that leaves no tool; the model-call catch emits `modelfail` with the failed model; `plan().notes` extend the `route` event reason. The existing "skill match" and "escalated" upgrades stay. With `live` absent the old path runs.
- `main.js`: the `confirm` source may include an optional `group`.
- `route()` and `selectGroups()` are not modified.

## Errors and performance

`plan()` and `cooling()` are wrapped; on failure the orchestrator logs one warning and uses plain `route()`/`selectGroups()` output. All synchronous over at most 8 tool and 6 model entries, well under 1 ms. Nothing is persisted; cooldown entries expire on their own.

## Testing (`test/*.t` style)

- `cooldown`: weights (`ok:false` 1, `soft` 0.5), the 2 min window, empty and malformed input.
- `plan`: `snap` absent equals the direct calls; each rule fires only on its own input, with a negative case each; voice never gets `prefer` when thinking or multi-step; a throwing `route()` falls back; `continue` reproduces the current inline behavior.
- `livestate`: `modelfail` fills the ring, bounded, expiring, no text stored.
- `ollama.resolveModel`: `prefer: 'fast'` honored only when the fast model is installed, has `tools` and is not `avoid`; otherwise identical to without the hint.
- `orchestrator`: `live` absent is unchanged; a cooling tool is dropped but never the last one; a model failure emits `modelfail` and the next turn avoids that model; a pending confirm turns a chat route into a tools turn.
- `eval`: `eval/run.js` accepts an optional per-case `live` fixture (a snapshot); about 12 new cases in `eval/questions.json`: confirm pending ("actually cancel that" → tools), voice single-step (`prefer: 'fast'`), voice multi-step (none), failed tool dropped, failed model avoided, "do it again" → continue, and negatives where the same phrases with no live state route as today.

## Commits

Only new files are staged (modules, tests, docs). Existing files this change edits are already modified in the working tree; those hunks are left uncommitted and listed for the user.
