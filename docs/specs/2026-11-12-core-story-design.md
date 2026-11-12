# The AI core tells the turn's story

**Goal.** The neural lattice in the middle of the wallpaper already fires on real events (see `2026-11-12-brain-lattice-design.md`), but on screen it reads as a spinning ball of cyan haze. Keep it organic and alive, and make a glance answer: *what is JARVIS doing right now, and what did it just do?* (listening → recalling which memories → thinking deep → running which tool → answering → speaking).

**Where.** All work is in `jarvis-desktop` (`C:\Users\gdani\Projects\Apps\jarvis-desktop`, `wallpaper/`). No `jarvis-core` changes. The protocol stays as it is.

## Success criteria
1. Mid-turn, the caption under "AI CORE" names the current phase in words (e.g. `RECALLING · 3 MEMORIES`, `RUNNING · WEATHER`), with no flicker: each phase is shown for at least 600 ms.
2. The turn's steps sit in an arc of chips under the sphere and stay readable for 10 s after the turn ends.
3. A recall's path is followable by eye: pulses visibly travel hop by hop, the recalled items stay lit about 3 s with readable labels, and the path stays faintly drawn for the rest of the turn.
4. During a turn the sphere stops spinning and turns the region that is firing toward the viewer. At idle it drifts slowly, as today.
5. Firing clearly stands out from the resting tissue (dark floor, distinct hues per meaning).
6. No words from the conversation or tool arguments appear that the bridge's privacy rules do not already allow. The core's `tool.label` is never displayed.
7. Same frame budget as today, no per-frame allocations in the hot loops, and every existing test passes.

## Baseline
`jarvis-desktop` has uncommitted work: `wallpaper/js/neural-tree.js`, `test/neural-tree.test.js`, `test/lattice-brain.test.js`, and edits to `lattice.js`, `lattice-model.js`, `app.js`, `scene.js`, `ai-link.js`, `style.css`, `index.html`, `README.md`. It is committed as is, as the baseline, before any change. The arbor tissue stays.

## Inputs (events that already reach the wallpaper)
`state` (idle | listening | thinking | speaking | error, `detail`), `route` (`tier`, `think`, `model`), `reasoning`, `token` (`prob`, `alts`; text is blanked by the bridge), `tool` (`id`, `name`, `phase` start | end, `ok`; `label` is ignored), `net` (`source`, `ok`, `cached`), `context`, `turn` (`tps`, `model`), and `brain` (`op` recall {seeds, items, trail[[a,b,hop]]} | write {ids, count} | use {ids}).

## 1. `wallpaper/js/turn-story.js` (new; UMD like `lattice-model.js`; no DOM, no three.js)
`TurnStory.create({ now })` → `{ event(ev), step(dt), snapshot() }`. `app.js` feeds it every core event, next to `scene.aiEvent`.

**Turn lifecycle.** A turn starts when `state` leaves `idle` (to listening or thinking) and there is no open turn. It ends at `state: idle` or `state: error`. After the end, `linger` counts down from 10 s, and the snapshot reports `fade` (1 → 0 over the last 1.5 s). A new turn start clears the old story at once.

**Phases** (the caption). Each has `{ key, text, hue }`:

| trigger | key | text |
|---|---|---|
| `state` listening | listening | `LISTENING` |
| `brain` recall | recalling | `RECALLING · N MEMORIES` (N = items, at least 1) |
| `route` tier deep, or think | deep | `THINKING DEEP · <short model>` |
| `reasoning` | reasoning | `REASONING` |
| `tool` start, or `net` with no open tool | tool | `RUNNING · <FRIENDLY>` |
| first `token` of the turn | answering | `ANSWERING`, then `ANSWERING · <tps> TOK/S` once a rate exists (smoothed rate from token timing, or `turn.tps`) |
| `state` speaking | speaking | `SPEAKING` |
| `state` error | error | `ERROR` + ` · <detail>` cut to 24 chars, uppercased (detail is the core's own status text, already public) |
| turn ended | done | `DONE · <n> STEPS` during the linger |

The short model name follows `app.js`'s `shortModel` rules (move that function into `turn-story.js` and export it, so both use one copy).

**Dwell.** The caption phase changes at most once every `MIN_DWELL = 0.6 s`. Newer phases queue (keep only the latest pending one), and `error` jumps the queue. Steps are always recorded, whether or not their phase was shown.

**Steps** (the arc): an ordered list, at most `MAX_STEPS = 7` (when full, the oldest finished step is dropped). A step is `{ kind, title, state: 'active'|'ok'|'fail', count, hue, t0, t1 }`:
- recall → `RECALL · N`. A later recall in the same turn merges: `count++`, title `RECALL ×k · N` with N = total items.
- deep route → `DEEP · <short model>`, at most once per turn.
- tool start → `<FRIENDLY>` active. Tool end → `ok` (✓) or `fail` (✗); `soft` counts as ok. The same tool name again merges into `×k`. A `net` event during an open tool only sets that tool's ok. A `net` event with no open tool adds a short step `<FRIENDLY>` that ends at once.
- write → `LEARNED · count` (merges).
- first token → `ANSWER` active, finished at turn end with ` · <tps> T/S` if known.
- `state` speaking → `SPEAKING` active, finished at turn end.
- error → the active step becomes `fail`, and an `ERROR` step is added.

**Friendly names.** `FRIENDLY` maps tool names to short words (start from today's `LIMB_NAMES`, and add the rest of the core's tools: `web_search` WEB, `memory_*` MEMORY, `set_timer`/timers TIMER, `youtube_music`/`ytm_*` MUSIC, files FILES, pc PC, clipboard CLIPBOARD, `more_skills` SKILLS…). Fallback: strip a known prefix, replace `_` with a space, uppercase, cut to 14 chars. `LIMB_NAMES` in `lattice-model.js` then reads from this map, so there is one source.

**Focus.** Turn-story does not know regions. It reports what fired most recently: `focusIds` (the newest recall's items, else its seeds, or the newest write's ids) and `focusTool` (the open tool's name, which wins while open). The lattice model turns these into a region (section 2). `focus` (0..1) eases toward 1 while a turn is open and toward 0 during the linger (rate `1/0.4 s`).

**Privacy rule (tested).** Nothing in a snapshot comes from `ev.label`, `ev.text`, or any argument. Titles are built only from friendly names, counts, model names, and the state's `detail`.

## 2. Model changes: `lattice-model.js`
- `setFocus({ focus, ids, tool })`, called each frame by the scene with turn-story's snapshot. It stores `focus` and computes `focusRegion` (the majority region of `ids` that are in the picture; the skills region for a tool; otherwise it keeps the previous value). It is reported in `step()` as `focus` and `focusDir` (that region's `dir`).
- **Held items:** a recall's `items` get `hold[i] = HOLD_TIME (3 s)`. While held, `act` does not decay below `0.6`. The `hot` threshold drops from 0.3 to 0.12 and the list grows from 8 to 12 entries (held nodes first), so the labels in section 4 have candidates. `lattice.hotTips()` returns up to 8 entries and adds `held: true|false`.
- **Trace:** a new `trace` (Float32Array per link). Each recall trail link sets `trace[k] = 1`. Trace decays only once focus falls below 0.05 (rate `1/1.5 s`), so it lasts the whole turn plus the linger. It is reported in the snapshot.
- **Followable pulses:** pulse time and hop delay blend by focus: `PULSE_TIME` 0.45 → 0.75 s, `HOP_DELAY` 0.22 → 0.35 s.
- **Rings:** recall seeds and a firing skill neuron add `{ i, t: 0, hue }` to `rings` (max 16, lasting 0.9 s), reported in the snapshot.
- **Meaningful sparks:** with a tree and held items (or an active skill neuron), a token spark runs from a held node (round-robin) to the core centre along a 4-point path (soma → the soma's position scaled by 0.66 → by 0.33 → (0,0,0)), with a small seeded jitter. With nothing held it is a "shimmer" spark (a chain inside radius 0.25, ghost brightness). Ghost alternatives keep their meaning (fainter, same rule).
- **Bridge budget** halved: `neural-tree.js` `maxBridges = budget * 0.025`.

## 3. Drawing: `lattice.js`
Everything is scaled by `f = s.focus`:
- **Floor:** dendrite, bridge and axon base brightness × `(1 - 0.55 f)`. Nodes outside `focusRegion` × another `(1 - 0.65 f)`. Dormant points only show when `f < 0.05`.
- **Hues** (palette only): recall = accent-soft lerped 35% to white, write = gold, use = accent, skill = white-hot (accent-soft lerped 70% to white), error = crit. Pulse heads use sprite size 0.26 (was 0.2), and trails use 6 segments (was 3), sized for `MAXP`.
- **Trace:** traced axons draw an extra `0.35 × trace` in the recall hue on top of their base colour.
- **Rings:** a new Points layer (or a small pool of ring meshes) draws each ring growing from 0.04 to 0.14 radius while fading.
- **Deep glow:** a centre sprite in gold, opacity `0.5 × depth × f`.
- **Tool tether:** as today, plus a bright head that runs the length of the drawn curve every 0.8 s while the call is open. It turns crit on failure.
- **Motion:** split the group into `lean` (outer, keeps today's x-lean and y offset) and `spin` (inner, holds the network). At idle, `spin` drifts at 0.05 rad/s about y. Swirl and rate no longer add speed. While `f > 0.05` and `focusDir` exists: get the camera direction in `lean`'s local space each frame, form the target quaternion `setFromUnitVectors(focusDir, camDir)`, and move `spin.quaternion` toward it with a critically damped spring (ω = 3/s, angular speed capped at 1.2 rad/s). Re-target at most every 1.5 s. When `f` returns to 0, drift resumes from the current orientation. The spring maths lives in a pure helper `springTurn(state, target, dt)` (in `turn-story.js` or `lattice-model.js`) so it can be unit-tested without three.js.
- **Allocation hygiene:** remove `.clone()`, `.slice()` and `new T.Vector3()` from `draw`/`drawTissue`/`limbTips` hot paths. Use module-level scratch vectors and precomputed spark/limb arrays.

## 4. Text: `app.js`, `index.html`, `style.css`
- **Caption:** while a story is open or lingering, `#ai-state` shows `snapshot.caption.text` with class `story` (11 px mono, `--hot`, a leading 5 px dot that pulses while the phase is active, coloured by hue). Phase changes crossfade over 250 ms: two stacked spans, swap and fade. Otherwise it shows today's `coreLabel()`.
- **Step arc:** a new `<div id="ai-steps">` holds up to 7 chip elements, reused and never rebuilt per frame. Chip k of n sits on an arc around `coreXY` at radius `1.15 × r`, angle `200° + (k + .5) / n × 140°` (screen space, lower half). The chips are joined by one SVG polyline in the existing `#leaders` SVG (1 px, accent at 25%). A chip is 9 px mono with 0.2em letter-spacing: active = `--hot` and pulsing, ok = accent-soft at 70%, fail = `--crit`, and the ✓/✗ suffix is in text. The whole arc's opacity is `fade`. Chips register in the collision placer at priority 2 (after data tags) and, when blocked, shift outward along the radius (+0, +12, +24 px) or hide.
- **Memory labels:** at most 8 (was 6). Order: held recall items, then write, then use, by `act`. A label shows while held or `act > 0.12`, and stays at least 2.5 s once shown (`shownAt` per id). It is placed through the collision placer with a 6 px leader tick drawn in `#leaders`. Labels still come only from `/ai/brain/labels`, which is unchanged.
- **Region names:** `focusRegion`'s name goes to opacity `0.2 + 0.8 f`.
- **Idle FPS:** `aiBusy()` is also true while a story is open or lingering.

## 5. Demo
Extend `ai-link.js` `demoScript()` into one full turn of about 20 s that hits every step: wake → listening → recall (seeds, items, a 2-hop trail) → deep route → reasoning → a tool that succeeds → a tool that fails → tokens → write → speaking → idle, then about 12 s of idle linger. Add `?demo=ai-live&story=fast` for a turn with no recall and no route (tokens and one tool only). Keep the loop.

## 6. Tests (`node --test`, jarvis-desktop)
- `test/turn-story.test.js` (new): turn start and end; the phase order across the demo script; dwell (two phases inside 600 ms → the second shows at 600 ms; error preempts); merging (recall ×2, the same tool ×2, write counts); tool ✓/✗ and `soft`; `net` during and outside a tool; the 7-step cap; linger and fade timing; a new turn clears; `focusIds`/`focusTool`; the privacy rule (an event with `label: '“secret”'` and token `text` never shows up in any snapshot string); `FRIENDLY` fallback; `shortModel`; `springTurn` converges, never exceeds the cap, and is stable at dt 0.1.
- `test/lattice-model.test.js` and `test/lattice-brain.test.js` (extend): hold keeps items at 0.6 or above for 3 s; recall sets the trace on exactly the trail links; trace persists while focus is above 0 and decays after; pulse time scales with focus; rings are created and expire; sparks start at a held node and end at the origin; `focusRegion` is the majority region; the bridge count is at most `budget × 0.025`.
- All existing tests pass.

## 7. Visual check
Serve `wallpaper/` on 127.0.0.1, open `index.html?demo=1&demo=ai-live` at 1920×1080, and take screenshots at listening, recalling, deep, tool, tool fail, answering, speaking and linger. Check them against the success criteria. Read the console: no errors.

## Out of scope / follow-ups
- `jarvis-core` `toolLabel()` (`src/core/orchestrator.js`) puts tool query words (`“…”`) on the public `/ai/stream`, which breaks the bridge's "no words on the stream" rule. Fix it in core separately: strip `label` in `publicEvent`, or send it only to the chat window. This design never reads it.
- Installing to Wallpaper Engine (`apply/*.ps1`) stays a manual step for the user.
- Explicit `phase` events from the core (only if inference turns out to be wrong in practice).
