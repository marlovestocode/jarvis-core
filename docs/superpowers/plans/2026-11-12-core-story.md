# AI Core Turn Story Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the wallpaper's AI-core neural lattice tell the story of each turn: a live phase caption, a persistent step arc, and a focus mode (calm floor, settle-and-face motion, held and traced recalls). The lattice stays as organic as it is now.

**Architecture:** A new pure module `turn-story.js` derives phases and steps from the core events that already exist. `lattice-model.js` gains focus state (held items, recall trace, rings, meaningful sparks). `lattice.js` draws focus mode and the spring-driven motion. `app.js` renders the caption, the step arc and longer-lived memory labels as HTML through the existing collision placer. No `jarvis-core` changes.

**Tech Stack:** Plain browser JS (UMD modules), three.js r170 (`wallpaper/vendor/three.js`), `node --test` with `node:assert/strict`.

**Spec:** `C:\Users\gdani\Projects\Apps\jarvis-core\docs\specs\2026-11-12-core-story-design.md`. Read it first; this plan argues from it.

**Repo:** all code work happens in `C:\Users\gdani\Projects\Apps\jarvis-desktop`. Every path below is relative to that repo unless it says jarvis-core.

## Global Constraints

- Change no files in `jarvis-core` and change no event protocol.
- Never display, store in a snapshot, or log `ev.label`, `ev.text`, or any tool argument. Titles come only from friendly names, counts, model names, and `state.detail`.
- Constants (exact): `MIN_DWELL = 0.6` s, `LINGER = 10` s, fade over the last `1.5` s, `MAX_STEPS = 7`, focus ease rate `1/0.4` s, `HOLD_TIME = 3` s, held floor `0.6`, hot threshold `0.12` (12 entries), `PULSE_TIME` 0.45 → 0.75 s and `HOP_DELAY` 0.22 → 0.35 s blended by focus, rings max 16 and life 0.9 s, trace decay `1/1.5` s once focus < 0.05, bridges `budget * 0.025`, spring ω = 3/s, max 1.2 rad/s, retarget at most every 1.5 s, idle drift 0.05 rad/s, label min visible 2.5 s, at most 8 labels, chip radius `1.15 × r`, arc 200° → 340°.
- Palette colours only (`P.colors` / CSS vars). No new dependencies.
- Hot paths (`lattice.draw`, `drawTissue`, `limbTips`, `hotTips`, `app.js` per-frame placers) allocate no vectors or arrays per frame. Use scratch objects and reuse DOM elements.
- UMD pattern like `lattice-model.js`: `module.exports` in Node, `window.X` in the browser.
- Run `npm test` in jarvis-desktop before every commit; all tests pass.
- Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (or whatever the executing model's attribution line is).

## Review Focus

1. **Events with no open turn** (a `tool`, `brain` or `token` arriving while `state` is idle, as on the skill fast path, which emits `tool` start and end with no `thinking`): the expected behaviour is that it opens an implicit turn rather than being dropped or throwing. Test in Task 2.
2. **Bridge reconnect mid-turn** (`link` `up:false`): the story closes as if `state: idle` arrived and lingers, rather than staying "RUNNING" forever. Test in Task 2.
3. **Tool end with no matching start** (an unknown `id`, or the start was dropped): ignored with no phantom step. Test in Task 3.
4. **A graph refresh (`setGraph`) during a turn**: hold, trace and rings reset safely with arrays resized, and `setFocus` with ids no longer in the graph causes no NaN and no throw. Test in Task 4.
5. **No WebGL graph** (fewer than 8 nodes, generated lattice): `setFocus` is a no-op, `focusDir` is null, the motion spring never runs, and the caption and step arc still work. Test in Task 4 (model). The caption is checked in Task 9.

---

### Task 0: Baseline commit and branch

**Files:** the uncommitted files in jarvis-desktop listed by `git status`.

- [ ] **Step 1: Run the tests on the WIP.** Run `npm test` in jarvis-desktop. Expected: all pass. If any fail, stop and report; do not fix WIP silently.
- [ ] **Step 2: Commit the WIP as the baseline on `main`.**
```bash
git add -A wallpaper test README.md
git commit -m "chore: baseline neural-tree arbors and lattice-brain work"
```
Check `git status` afterwards. Only untracked junk, if any, may remain; list it in your report.
- [ ] **Step 3: Branch.** `git checkout -b feat/core-story`.

---

### Task 1: turn-story helpers (friendly names, shortModel, springTurn)

**Files:**
- Create: `wallpaper/js/turn-story.js`
- Test: `test/turn-story.test.js`

**Interfaces:**
- Produces: `TurnStory.friendly(name: string) → string`, `TurnStory.FRIENDLY: Record<string,string>`, `TurnStory.shortModel(m: string) → string`, `TurnStory.springTurn(s: {angle:number, vel:number}, dt:number, opts?: {omega=3, maxSpeed=1.2}) → {angle, vel}`. `angle` is the remaining angle to the target (≥ 0) and `vel` is signed, negative meaning closing.

- [ ] **Step 1: Write the failing tests**
```js
const test = require('node:test');
const assert = require('node:assert/strict');
const TS = require('../wallpaper/js/turn-story.js');

test('friendly: known tools map to short words, unknown ones are humanized and capped', () => {
  assert.equal(TS.friendly('get_weather'), 'WEATHER');
  assert.equal(TS.friendly('web_search'), 'WEB');
  assert.equal(TS.friendly('get_system_stats'), 'SYSMON');
  assert.equal(TS.friendly('set_timer'), 'TIMER');
  assert.equal(TS.friendly('youtube_music'), 'MUSIC');
  assert.equal(TS.friendly('some_new_long_tool_name'), 'SOME NEW LONG ');   // 14 chars
  assert.equal(TS.friendly(''), 'TOOL');
  assert.equal(TS.friendly(undefined), 'TOOL');
});
test('shortModel strips :latest and uppercases', () => {
  assert.equal(TS.shortModel('qwen3:14b'), 'QWEN3:14B');
  assert.equal(TS.shortModel('jarvis-worker:latest'), 'JARVIS-WORKER');
  assert.equal(TS.shortModel(null), '');
});
test('springTurn converges, never exceeds the speed cap, and is stable at dt 0.1', () => {
  for (const dt of [1 / 60, 0.1]) {
    let s = { angle: Math.PI, vel: 0 }, prev = s.angle;
    for (let t = 0; t < 5; t += dt) {   // π at a 1.2 rad/s cap needs ~2.6 s plus the settle
      s = TS.springTurn(s, dt);
      assert.ok(Number.isFinite(s.angle) && s.angle >= 0 && s.angle <= prev + 1e-9);
      assert.ok(Math.abs(s.vel) <= 1.2 + 1e-9);
      prev = s.angle;
    }
    assert.ok(s.angle < 0.01, `dt ${dt}: ${s.angle}`);
  }
});
```
- [ ] **Step 2: Run** `node --test test/turn-story.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement the helpers in `turn-story.js`.**
  - `FRIENDLY` starts from every entry of today's `LIMB_NAMES` in `lattice-model.js` and adds: `web_search` WEB, `web_open` WEB, `browser_*` BROWSER, `remember` / `forget_memory` / `memory_about` / `recall_chats` MEMORY, `set_timer` / `cancel_timer` / `list_timers` / `set_alarm` TIMER, `set_reminder` REMINDER, `youtube_music` / `ytm_library` / `ytm_play_library` / `ytm_playlist_edit` / `music_stats` MUSIC, `find_files` / `file_info` / `copy_files` / `move_files` / `rename_files` / `make_folder` / `zip_files` / `unzip` / `organize_by_type` / `search_file_text` / `read_document` / `list_recent_files` / `big_files` / `folder_size` / `delete_to_recycle_bin` / `open_path` FILES, `clipboard_*` CLIPBOARD, `open_app` / `close_app` / `focus_window` / `list_windows` / `window_*` / `desktop_switch` / `end_unresponsive_app` APPS, `screenshot` SCREEN, `more_skills` / `skills_list` SKILLS, `self_*` SELF.
  - Prefix patterns (`browser_`, `clipboard_`, `window_`, `self_`) are checked when there is no exact key.
  - Fallback: replace `_` with a space, uppercase, take the first 14 chars; an empty name gives `TOOL`.
  - `springTurn` uses a critically damped spring on the remaining angle, integrated with semi-implicit Euler. This is the algorithm:
```js
const acc = -omega * omega * s.angle - 2 * omega * s.vel;
let vel = Math.max(-maxSpeed, Math.min(maxSpeed, s.vel + acc * dt));
let angle = s.angle + vel * dt;
if (angle <= 0) { angle = 0; vel = 0; }
if (angle > s.angle) { angle = s.angle; vel = Math.min(0, vel); }   // never overshoot backwards
return { angle, vel };
```
- [ ] **Step 4: Run** `node --test test/turn-story.test.js`. Expected: PASS. (The reference algorithm reaches about 0.004 at 5 s with dt 0.1.)
- [ ] **Step 5: Make `lattice-model.js` read its names from `FRIENDLY`.** Require `turn-story.js` the same way it requires `neural-tree.js`, and build `LIMB_NAMES` as `TurnStory.FRIENDLY` (keep the export name). The tool event fallback uses `TurnStory.friendly(ev.name)`. In `index.html`, add `<script src="js/turn-story.js"></script>` before `js/neural-tree.js`. In `app.js`, replace the local `shortModel` with `TurnStory.shortModel`.
- [ ] **Step 6: Run** `npm test`. Expected: all pass.
- [ ] **Step 7: Commit** `feat(story): friendly tool names, shortModel, springTurn`.

---

### Task 2: TurnStory lifecycle, phases and dwell

**Files:**
- Modify: `wallpaper/js/turn-story.js`
- Test: `test/turn-story.test.js`

**Interfaces:**
- Produces: `TurnStory.create() → { event(ev), step(dt), snapshot() }`.
- Snapshot shape (used by Tasks 3, 8 and 9):
```
{ open: boolean, caption: { key, text, hue } | null, steps: Step[], fade: 0..1, focus: 0..1,
  focusIds: number[], focusTool: string | null }
hue ∈ 'recall' | 'write' | 'use' | 'skill' | 'error' | 'plain'
```
- Time is internal: `step(dt)` advances it, and events are stamped with the current internal time.

- [ ] **Step 1: Write the failing tests.** Use a helper `run(story, script)` where `script` is `[[seconds, ev], ...]`, stepping in 1/60 s increments and sending each event at its time.
  - `'idle story: closed, no caption, fade 0'`: `create().snapshot()` gives `open === false`, `caption === null`, `steps.length === 0`, `fade === 0`.
  - `'a turn opens on listening and closes on idle, then lingers 10 s and fades over the last 1.5 s'`:
    - state listening at 0 → `open`, caption `LISTENING`.
    - state idle at 1 → `open === false`, `fade === 1` at 1 + 8.4 s.
    - `0 < fade < 1` at 1 + 9.0 s.
    - During the linger the caption is `DONE · N STEPS` (N = `steps.length`), hue `plain`.
    - `fade === 0` and `steps.length === 0` at 1 + 10.1 s.
  - `'phase captions'`: after the sequence listening, thinking, then
    - `brain` recall `{ items:[1,2,3], seeds:[1] }` → `RECALLING · 3 MEMORIES`, hue `recall`
    - `route` `{ tier:'deep', think:true, model:'qwen3:14b' }` → `THINKING DEEP · QWEN3:14B`
    - `reasoning` → `REASONING`
    - `tool` start `get_weather` → `RUNNING · WEATHER`, hue `skill`
    - `token` → `ANSWERING`
    - `turn` `{ tps: 38.2 }` → `ANSWERING · 38 TOK/S`
    - state speaking → `SPEAKING`

    Events are spaced 1 s apart so dwell doesn't interfere.
  - `'dwell: a phase shows at least 0.6 s; only the newest pending phase is kept; error jumps the queue'`:
    - listening at 0, recall at 0.1, route deep at 0.2 → at 0.3 caption is `LISTENING`; at 0.61 caption is `THINKING DEEP …` (recall was skipped in the caption).
    - Then a tool start at 0.7 and state error `detail:'model timed out'` at 0.75 → at 0.76 caption is `ERROR · MODEL TIMED OUT`, hue `error`.
  - `'recall with only seeds counts at least 1'`: a recall `{ seeds:[5], items:[] }` gives `RECALLING · 1 MEMORIES`.
  - `'an event with no open turn opens an implicit turn'` (Review Focus 1): from idle, `tool` start `get_time` then end `ok:true` gives `open === true` and caption `RUNNING · TIME`. Without any state event, the turn closes 1.5 s after the last tool end and enters linger.
  - `'link down closes the turn'` (Review Focus 2): listening, then `{ type:'link', up:false }` gives `open === false` and `fade === 1`.
  - `'a new turn clears the lingering one'`: a turn ends, 2 s pass, state listening → `steps` only has this turn's entries.
  - `'focus eases to 1 while open and back to 0 in linger'`: focus is about 0.5 at 0.2 s after open (± 0.05), 1 after 0.4 s, and 0 at 0.4 s after close.
  - `'privacy: label, text and args never reach the snapshot'`:
    - Send `tool` start `{ name:'web_search', label:'web_search · “my secret”', args:{ query:'my secret' } }` and `token` `{ text:'secret words' }`.
    - Then `JSON.stringify(story.snapshot())` must not include `secret`. Check this after every step of the run.
- [ ] **Step 2: Run** `node --test test/turn-story.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement `create()`.** Keep three things:
  - an open-turn flag;
  - `shown` = `{ key, text, hue, at }`;
  - `pending` = a single phase or null. `step()` promotes `pending` once `t - shown.at >= MIN_DWELL`. `error` replaces `shown` immediately.

  Other rules:
  - Implicit turns close after `1.5` s with no events when no `state` event opened them.
  - The token rate is smoothed from token times (`rate += (inst - rate) * min(1, dt*3)`). `turn.tps` overrides it.
  - `detail` is uppercased and cut to 24 chars.
- [ ] **Step 4: Run** `node --test test/turn-story.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(story): turn lifecycle, phase captions with dwell and linger`.

---

### Task 3: TurnStory steps, merging and focus outputs

**Files:**
- Modify: `wallpaper/js/turn-story.js`
- Test: `test/turn-story.test.js`

**Interfaces:**
- Produces: `Step = { kind: 'recall'|'deep'|'tool'|'net'|'write'|'answer'|'speak'|'error', title: string, state: 'active'|'ok'|'fail', count: number, hue, t0: number, t1: number|null }`, plus `snapshot().focusIds` and `snapshot().focusTool` as in Task 2.

- [ ] **Step 1: Write the failing tests** (the expected titles are exact):
  - `'steps of a full turn, in order'`: listening → recall `{items:[1,2,3]}` → route deep `qwen3:14b` → tool start/end `get_weather` ok → write `{ids:[9,10], count:2}` → token → speaking → idle. Expected titles: `['RECALL · 3', 'DEEP · QWEN3:14B', 'WEATHER', 'LEARNED · 2', 'ANSWER', 'SPEAKING']`.
    - At the end, all states are `ok`.
    - `ANSWER`'s title becomes `ANSWER · 38 T/S` when a `turn {tps:38}` arrived.
    - The tool step's `state` is `ok`.
  - `'merging'`:
    - Two recalls with 3 and 2 items give one step `RECALL ×2 · 5`, `count === 2`.
    - The same tool started twice gives one step `WEATHER ×2`.
    - Two writes with counts 2 and 1 give `LEARNED · 3`.
    - A route deep twice gives one `DEEP` step.
  - `'tool fail and soft'`: end `ok:false` gives `state === 'fail'`. End `ok:true, soft:true` gives `ok`.
  - `'net inside an open tool only sets its ok; net alone adds an instant step'`:
    - Tool start `get_weather`, then `net {source:'weather', ok:false}`, then tool end `ok:true` → one step, `state === 'ok'` (the end wins).
    - `net {source:'news', ok:true}` with no open tool → a step `NEWS`, `state === 'ok'`, `t1 !== null`.
  - `'error marks the active step fail and adds ERROR'`: tool start, then state error → the tool step is `fail` and the last step is `ERROR`, `kind === 'error'`.
  - `'cap: at most 7 steps, the oldest finished step is dropped first'`: 9 distinct tools, each started and ended → `steps.length === 7` and the first title is the 3rd tool's name.
  - `'tool end with unknown id is ignored'` (Review Focus 3): end `{id:'nope', name:'get_time'}` with no start → `steps.length === 0` and there is no caption change.
  - `'focusIds and focusTool'`:
    - After recall `{items:[4,5], seeds:[4]}`: `focusIds` deep-equals `[4,5]`.
    - Recall `{items:[], seeds:[7]}`: `[7]`.
    - Write `{ids:[9]}`: `[9]`.
    - While a tool is open, `focusTool === 'get_weather'`; after it ends, `null`.
- [ ] **Step 2: Run** `node --test test/turn-story.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement steps in `event()`.**
  - Open tools are tracked in a `Map(id → step)`.
  - When the list is full, drop the oldest step whose `state !== 'active'`, else the oldest.
  - At turn end, every `active` step becomes `ok` and gets `t1`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(story): turn steps, merging, focus ids`.

---

### Task 4: Model focus, held items, trace, followable pulses, rings

**Files:**
- Modify: `wallpaper/js/lattice-model.js`
- Test: `test/lattice-brain.test.js`

**Interfaces:**
- Consumes: the Task 2/3 snapshot fields `focus`, `focusIds`, `focusTool`.
- Produces:
  - `model.setFocus({ focus: number, ids: number[], tool: string|null }) → void`.
  - New `step()` snapshot fields: `focus: number`, `focusRegion: string|null`, `focusDir: [x,y,z]|null`, `hold: Float32Array` (per node, in seconds), `trace: Float32Array` (per link), `rings: {i, t, hue}[]` (t in 0..1).
  - `hot` now uses threshold 0.12, holds up to 12 entries, and puts held nodes first.

- [ ] **Step 1: Write the failing tests** (reuse `graph()` from the file):
  - `'held: recalled items stay at least 0.6 for 3 s, then decay'`:
    - setGraph, setFocus `{focus:1, ids:[], tool:null}`, recall `{items:[100,101], seeds:[100], trail:[]}`.
    - After stepping 2.9 s, `act[siteOf(100)] >= 0.6`.
    - After 3.0 s more, `act[siteOf(100)] < 0.6`.
  - `'hot: threshold 0.12, max 12, held first'`: a recall of 14 items gives `hot.length === 12`, and every held index precedes every non-held one.
  - `'trace: a recall sets exactly its trail links; it survives while focus > 0 and decays after'`:
    - trail `[[100,101,1],[101,102,2]]` → the trace is 1 at those two link indices and 0 elsewhere.
    - Step 5 s at focus 1 → still 1.
    - setFocus focus 0 and step 1.6 s → all trace is 0.
  - `'pulses are slower under focus'`: recall `{ seeds:[100], items:[], trail:[[100,101,1]] }`. With focus 0, `act[siteOf(101)] > 0` after 0.46 s. With focus 1, `act[siteOf(101)] === 0` at 0.6 s and `> 0` at 0.76 s.
  - `'rings: seeds and a firing skill neuron add rings that expire after 0.9 s; at most 16'`:
    - A recall with 20 seeds gives `rings.length === 16`.
    - After 0.91 s, `rings.length === 0`.
  - `'focusRegion is the majority region of ids; a tool focuses skills; null without a graph'`:
    - ids that map to 3 `fact` nodes and 1 `chat` node give `memory`.
    - `{tool:'get_weather'}` with a skills graph gives `skills`.
    - A fresh model with no graph gives `focusRegion === null` and `focusDir === null` (Review Focus 5).
  - `'setGraph mid-turn resets focus arrays safely'` (Review Focus 4):
    - Recall, then `setGraph(graph(60))`, then `setFocus({focus:1, ids:[999999], tool:null})`, then `step(0.1)`.
    - Lengths: `hold.length === 60` and `trace.length === links.length`.
    - Every value is finite, and nothing throws.
- [ ] **Step 2: Run** `node --test test/lattice-brain.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - Add the arrays `hold` and `trace`, sized in `setGraph` next to `act`.
  - `setFocus` stores `focus` and recomputes `focusRegion` from `ids` (`info[i].region`, majority, ties go to the first found). With `tool` set, it uses `skills`. When neither resolves, it keeps the previous value. It is a no-op without a graph.
  - In `step()`:
    - `pulseTime = 0.45 + 0.3*focus` and `hopDelay = 0.22 + 0.13*focus`. The delay applies when a recall is received, so use the focus at that moment.
    - Hold counts down, and `act` is floored at 0.6 while hold > 0.
    - Rings advance `t += dt/0.9`.
  - `light()` for a skill sets a ring with hue `HUE.skill`. Recall seeds get rings with hue `HUE.recall`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS. Existing tests that assert `hot.length <= 8` or the 0.3 threshold get updated to the spec values; say so in the commit body.
- [ ] **Step 5: Commit** `feat(lattice): focus region, held recalls, recall trace, slower pulses, rings`.

---

### Task 5: Meaningful sparks and calmer tissue

**Files:**
- Modify: `wallpaper/js/lattice-model.js` (the token case), `wallpaper/js/neural-tree.js` (`maxBridges`)
- Test: `test/lattice-brain.test.js`, `test/neural-tree.test.js`

**Interfaces:**
- Consumes: `hold` and the limbs (Task 4).
- Produces: spark `pts` is a 4-point path `[[x,y,z] ×4]`; a held/skill spark ends at `[0,0,0]`. Spark objects gain `src: 'held'|'shimmer'`.

- [ ] **Step 1: Write the failing tests:**
  - `'sparks start at a held node and end at the core'`:
    - Recall items `[100,101]`, then 4 tokens.
    - Every spark with `src === 'held'` has `pts[0]` equal to the position of node 100 or 101 (within 0.02, because of jitter) and `pts[3]` deep-equal to `[0,0,0]`.
    - The sources alternate (round-robin).
  - `'with nothing held, sparks are inner shimmer'`: a token with no recall gives `src === 'shimmer'` and every `pts` point has radius ≤ 0.25.
  - `'an open skill tether is a spark source'`: a tool start whose group is in the graph, then a token → `pts[0]` is at that skill neuron.
  - In `neural-tree.test.js`: `'bridges are at most budget*0.025'`: `grow(somas, {budget: 4500}).bridgeCount <= Math.floor(4500*0.025)`.
- [ ] **Step 2: Run** `npm test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - Held and skill sources are round-robin over the held indices followed by the open tether sites.
  - The path is soma → soma × 0.66 → soma × 0.33 → origin, with seeded jitter of ±0.015 on the middle two points, using the model's `rand`.
  - A shimmer spark is a 4-point random walk inside radius 0.25.
  - Ghost alternates use the same rule with `ghost: true`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lattice): sparks flow from recalled memories into the core; halve bridges`.

---

### Task 6: Focus-mode drawing

**Files:**
- Modify: `wallpaper/js/lattice.js`

**Interfaces:**
- Consumes: the snapshot fields from Tasks 4 and 5.
- Produces: `hotTips(keepIds = [])` returns at most 8 entries of `{ id, kind, label, act, hue, held, pos }` (held first), plus any `keepIds` still in the graph. Position objects come from a fixed pool of 8 `Vector3`s.

There are no unit tests (three.js). Verification is by the demo in Task 10. Every sub-step below is a separate edit.

- [ ] **Step 1: Floor and region dimming.**
  - In `drawTissue`, multiply dendrite, bridge and axon base brightness by `(1 - 0.55*f)`.
  - For nodes whose `info[n].region !== s.focusRegion`, multiply by another `(1 - 0.65*f)` (precompute a per-node factor once per frame).
  - Dormant points are drawn only when `f < 0.05`.
- [ ] **Step 2: Hues.** `hueCol` is recall = `cSoft.clone().lerp(white, .35)`, write = `cGold`, use = `cAccent`, skill = `cSoft.clone().lerp(white, .7)`. Add `cCrit` for a failed tether. Pulse heads use `sprite(.26)`, and pulse trails are 6 segments: resize `pTPos`/`pTCol` to `MAXP*6*6` and loop `k = 1..6`.
- [ ] **Step 3: Trace.** For each axon `L`, add `0.35 * s.trace[L]` × the recall hue to its colour.
- [ ] **Step 4: Rings.** Create a pool of 16 `T.Sprite`s, each with its own `SpriteMaterial` using a ring texture: a second canvas texture with a transparent centre and alpha peaking at radius 0.8, additive. Each frame, ring `k` sits at node `i`'s position, scaled `0.04 + 0.1*t`, its colour is the hue × `(1 - t)`, and unused sprites are hidden.
- [ ] **Step 5: Deep glow.** Add a centre `Sprite` in gold with opacity `0.5 * s.depth * f`.
- [ ] **Step 6: Tether head.** While a tether limb is open (`grow > 0`), draw a pooled small sprite at the curve parameter `(t % 0.8)/0.8` of the drawn curve. It is crit when `!ok`.
- [ ] **Step 7: Allocation hygiene.**
  - Replace `.clone()` and `s.pulses.slice` in the pulse loop with scratch vectors and an index-bounded loop.
  - In `draw`, hoist `head`, `tail`, `fb` and `mid` to module scope.
  - In `limbTips`/`hotTips`, use the pooled vectors.
  - Use `s.sparks` with index bounds instead of `slice(-MAXS)`.
- [ ] **Step 8: Run** `npm test` (no regressions), then load `?demo=1&demo=ai-live` (Task 10's server) and check the console for errors.
- [ ] **Step 9: Commit** `feat(lattice): focus mode drawing — calm floor, distinct hues, trace, rings, deep glow`.

---

### Task 7: Settle-and-face motion

**Files:**
- Modify: `wallpaper/js/lattice.js` (`create` signature and `draw`), `wallpaper/js/scene.js:224`

**Interfaces:**
- Consumes: `TurnStory.springTurn` (Task 1), and `s.focus` and `s.focusDir` (Task 4).
- Produces: `HoloLattice.create(T, P, parent, model, { camera })`. `scene.js` passes `{ camera: cam }`.

- [ ] **Step 1: Restructure the groups.** `lean = new T.Group()` is added to `parent`, and `group` (the spin) is added to `lean`. The listening lean (`rotation.x`, `position.y`) moves to `lean`. Every `group.localToWorld` call stays on `group`.
- [ ] **Step 2: Idle drift.** When `f < 0.05`, call `group.rotateY(0.05*dt)`. Delete the `swirl` and `rate` speed terms.
- [ ] **Step 3: Face the focus.** When `f >= 0.05` and `s.focusDir`:
  - Latch `targetDir`. Update it only when it changed and at least 1.5 s has passed since the last update.
  - `camDir` = `lean.worldToLocal(scratch.copy(camera.position)).normalize()`.
  - `qT.setFromUnitVectors(targetDirV, camDir)`.
  - `rem = group.quaternion.angleTo(qT)`.
  - `st = TurnStory.springTurn({ angle: rem, vel }, dt)`.
  - `group.quaternion.rotateTowards(qT, rem - st.angle)`.
  - `vel = st.vel`.

  Reset `vel = 0` whenever the target is re-latched. No camera passed → skip facing (drift only).
- [ ] **Step 4: Run** `npm test`. In the demo, the recall should turn the MEMORY region to the front within about 2 s with no snap, and drift should resume after the linger.
- [ ] **Step 5: Commit** `feat(lattice): settle and face the firing region during a turn`.

---

### Task 8: Wiring the story into scene and app (caption)

**Files:**
- Modify: `wallpaper/js/app.js` (`aiListeners`, the frame loop around `scene.frame(dt, opts)`, `coreLabel` display), `wallpaper/js/scene.js` (expose `setFocus`, `aiBusy`), `wallpaper/style.css`

**Interfaces:**
- Consumes: `TurnStory.create` (Tasks 2 and 3) and `model.setFocus` (Task 4).
- Produces: `scene.setFocus(o)` → `latModel.setFocus(o)` (a no-op without a model); `scene.focusRegion() → string|null` (from `latSnap`); and the `story` instance and per-frame `ss` snapshot in `app.js` that Task 9 reads. `scene.aiBusy()` is unchanged.

- [ ] **Step 1: Wire the story.**
  - `const story = window.TurnStory ? TurnStory.create() : null;` and push `ev => story?.event(ev)` onto `aiListeners`.
  - In the frame loop, before `scene.frame`, call `story.step(dt)`, take `const ss = story.snapshot()`, and call `scene.setFocus({ focus: ss.focus, ids: ss.focusIds, tool: ss.focusTool })`.
  - In the frame-rate line of the loop, use `scene.aiBusy() || ss.open || ss.fade > 0` so the story keeps the full frame rate.
- [ ] **Step 2: Caption.**
  - `#ai-state` contains two stacked `<span>`s and a dot `<i>`.
  - While `ss.open || ss.fade > 0`, set class `story` and write `caption.text` into the span that is currently hidden, then swap the `.on` class (CSS opacity transition 250 ms).
  - Set the dot's class to the hue. It pulses while `ss.open`.
  - Otherwise, restore `coreLabel()`.
  - CSS: `.story` is 11 px `var(--font-mono)` in `var(--hot)`. The dot is 5 px; hue classes map to `--accent-soft`, `--gold`, `--accent` or `--crit`.
  - Write only when the text changes (no per-frame DOM writes).
- [ ] **Step 3: Check the caption in the demo.** Run the demo. The caption should read `LISTENING` → `RECALLING · 3 MEMORIES` → `THINKING DEEP · JARVIS-WORKER` → … with no flicker.
- [ ] **Step 4: Run** `npm test`. **Commit** `feat(wallpaper): live turn caption under the AI core`.

---

### Task 9: Step arc, memory labels, region focus

**Files:**
- Modify: `wallpaper/index.html` (add `<div id="ai-steps"></div>` after `#ai-regions`), `wallpaper/js/app.js` (`placeBrain`, `placeRegions`, new `placeSteps`, which is called in the frame loop after `placeLabels()`), `wallpaper/js/scene.js` (`brainLabels(keepIds)` passes through to `lattice.hotTips(keepIds)`), `wallpaper/style.css`

**Interfaces:**
- Consumes: `ss.steps`, `ss.fade`, `ss.open` (Task 8's `story`), `hotTips(keepIds)` (Task 6), `place(key, x, y, w, h, hide)` and `coreXY` (existing, `app.js:55-88`), and `svg = $('leaders')`.

- [ ] **Step 1: The step arc** (`placeSteps`).
  - Keep 7 chip `div`s, created once. For chip k of n:
    - `a = (200 + (k + .5)/n*140) * π/180`
    - position `(coreXY.x + cos a * 1.15 r, coreXY.y - sin a * 1.15 r)`; screen y goes down, and 200°–340° lands in the lower half.
  - Place through `place('step'+k, …, true)`. When blocked, retry at radius + 12 px and then + 24 px before hiding.
  - The text is `title` plus ` ✓`/` ✗` for `ok`/`fail` tool and net steps. Classes are `active`, `ok` and `fail`.
  - One `<polyline id="ai-steps-line">` in `#leaders` joins the placed chip centres, stroked accent at 25%.
  - The container's opacity is `ss.open ? 1 : ss.fade`.
  - Update the DOM only when a chip's text or class changes.
  - CSS: 9 px mono, letter-spacing .2em; `.active` is `--hot` with a pulse keyframe; `.ok` is `--accent-soft` at 70% opacity; `.fail` is `--crit`.
- [ ] **Step 2: Memory labels** (`placeBrain`).
  - 8 elements.
  - Keep a `shownAt` `Map(id → ms)`. Pass `keepIds` = ids shown within the last 2500 ms to `scene.brainLabels(keepIds)`.
  - Place each label with `place('mem'+id, …, true)` after the step chips, so it has lower priority.
  - Draw a 6 px leader tick in `#leaders` from the node's screen position toward the label; keep a pooled set of 8 `<line>` elements.
  - Opacity: `held ? 1 : min(1, act*1.4)`, with a floor of 0.5 inside the keep window.
  - Fetching labels from `/ai/brain/labels` is unchanged.
- [ ] **Step 3: Region focus.** In `placeRegions`, the region whose `key === scene.focusRegion()` gets opacity `0.2 + 0.8*ss.focus` instead of the formula used today.
- [ ] **Step 4: Run the demo.**
  - The chips appear under the sphere in order and don't overlap panels.
  - The labels for recalled items stay readable about 3 s and carry leader ticks.
  - Everything fades out about 10 s after idle.
  - The console has no errors.
- [ ] **Step 5: Run** `npm test`. **Commit** `feat(wallpaper): turn step arc, longer-lived memory labels, focused region name`.

---

### Task 10: Demo turn and visual verification

**Files:**
- Modify: `wallpaper/js/ai-link.js` (`demoScript`, and `?story=fast`)
- Test: `test/ai-link.test.js`

**Interfaces:**
- Consumes: `TurnStory` (Tasks 2 and 3).
- Produces: `demoScript({ fast = false } = {})`. `runDemo` reads `story=fast` from `location.search` when present.

- [ ] **Step 1: Write the failing test.** `'demo script drives a full story'`: feed `demoScript()` events in time order into `TurnStory.create()` (stepping between events). Expected:
  - The step kinds, in order, include `recall`, `deep`, `tool` (ok), `tool` (fail), `answer`, `write`, `speak`.
  - The captions seen include every phase key: listening, recalling, deep, reasoning, tool, answering, speaking.
  - The script's last event is at least 12 s after its `state: idle`, which leaves room for the linger.

  A second test: `demoScript({ fast: true })` produces no `recall` and no `deep` steps, and at least one `tool` and one `answer`.
- [ ] **Step 2: Run** `node --test test/ai-link.test.js`. Expected: FAIL.
- [ ] **Step 3: Rewrite `demoScript`.** It follows spec §5: one turn of about 20 s with a 2-hop recall trail, a tool that succeeds (`get_weather`) and one that fails (`web_search`, `ok:false`), tokens, a write, speaking, idle, then about 12 s idle. Keep the boot and context events at the start. Keep the existing `'demo mode plays a looping scripted sequence with every event kind'` test passing.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Visual check.**
  - Serve with `python -m http.server 8765 --bind 127.0.0.1 --directory wallpaper`.
  - Open `http://127.0.0.1:8765/index.html?demo=1&demo=ai-live` at 1920×1080.
  - Take screenshots at listening, recalling, deep, tool, tool fail, answering, speaking and linger, plus `&story=fast`.
  - Check each one against spec success criteria 1–5. Read the console: no errors.
  - With `?debug`, `window.__fps.frameMs` is no worse than on `main` (measure both).
  - Save the screenshots under `out/shots/core-story/`.
- [ ] **Step 6: Commit** `feat(demo): full scripted turn for the core story; screenshots`.

---

### Task 11: Docs and handoff

**Files:**
- Modify: `README.md` (the wallpaper section: one paragraph on the caption, step arc and focus mode, and `?demo=ai-live&story=fast`)

- [ ] **Step 1:** Update the README. Run `npm test` (all pass).
- [ ] **Step 2: Commit** `docs: core story`. Do not push and do not run `apply/*.ps1`; installing to Wallpaper Engine is for the user to do.
- [ ] **Step 3: Report.** List the branch `feat/core-story`, the screenshot paths, the frame-time comparison, and anything that deviated from the spec. Restate the out-of-scope core follow-up: `toolLabel()` in jarvis-core `src/core/orchestrator.js` leaks query words onto `/ai/stream`.
