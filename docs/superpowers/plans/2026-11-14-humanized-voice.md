# Humanized Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jarvis speaks concisely and like a person (with a slight deadpan robotic edge): new default dialect, natural spoken numbers/dates/times, a human voice-mode queue readout, and varied canned replies.

**Architecture:** (1) a new `human-jarvis` preset in `dialect.js` carrying prompt wording plus a `spoken: 'natural'` flag; (2) `articulate()` in `speech-text.js` branches on that flag for times/dates/numbers; (3) a new pure module `src/core/voice/spoken-list.js` that formats durations, totals and title lists for voice, plus a no-immediate-repeat variant picker; (4) `media/skill.js` uses those for voice-mode replies only. Typed chat output is untouched.

**Tech Stack:** Node (CommonJS), `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-14-humanized-voice-design.md`

## Global Constraints
- Existing presets `british-formal`, `neutral`, `casual` remain selectable and keep their behaviour (`spoken` flag absent/`'literal'`).
- Voice mode only: `source === 'voice'` / `voice` true. Typed-chat strings stay exactly as today.
- Exact titles and artists are never altered or dropped from a readout the user asked for by count; only durations/totals are rounded, and long lists are shortened only with an explicit "N more" statement.
- No model call for canned replies. No TTS engine change. No financial code touched (no vault changelog needed).
- Replies stay short: dialect prompt text stays compact (small local models).
- Do not commit unless the user asks (repo CLAUDE.md); the commit steps below are skipped until then.

## Review Focus
- Queue of 1 song, 2 songs, and exactly the "read-aloud" cutoff (boundary of N titles).
- Queue with missing durations / `h:mm:ss` durations / zero durations: total omitted or correct, never "NaN".
- Titles that look like numbers or times ("1st things first", "3:00", "2026"): not mangled by the new number rules.
- Variant picker never repeats the same line twice in a row, and never throws on a one-variant list.
- Saved user config still says `dialect: 'british-formal'`: the new default must not silently override an explicit choice; document how to switch.

---

### Task 1: `human-jarvis` dialect preset

**Files:**
- Modify: `src/core/voice/dialect.js` (add preset, set `DEFAULT_ID = 'human-jarvis'`, expose `spoken` in `resolve()`)
- Modify: `src/core/config.js:70` (default `speech.dialect: 'human-jarvis'`)
- Test: `test/dialect.test.js` (create)

**Interfaces:**
- Produces: `resolve(speech)` result gains `spoken: 'natural' | 'literal'`; preset id `'human-jarvis'` appears in `list()`.

- [ ] **Step 1: Write failing tests** in `test/dialect.test.js`: `resolve({})` has `id === 'human-jarvis'` and `spoken === 'natural'`; `resolve({dialect:'british-formal'}).spoken === 'literal'`; `list()` includes `human-jarvis`; `settings.js` accepts `speech.dialect = 'human-jarvis'` (reuse the existing settings-validation test helper if one exists); the `human-jarvis` `diction` string contains "fragment", forbids "Certainly", and is under 1200 chars.
- [ ] **Step 2: Run** `node --test test/dialect.test.js` → FAIL.
- [ ] **Step 3: Implement the preset.** `character`: dry, deadpan, precise, quietly warm; answer first in as few words as possible, fragments allowed, no butler formality, no gushing, no humour on errors/stress. `diction`: contractions; light spoken habits used sparingly and never on errors ("so", "right", "hm", "about", "just", "a couple"); vague quantities for non-exact figures; vary confirmations ("Done", "Got it", "On it") and never repeat one twice in a row; say times like a person ("quarter past three", "half past nine"), dates as weekday/"tomorrow"/"the twelfth", temperatures as "about twenty"; reuse `VARY`, `ACK`, `SHARED_NEVER`; `register: PLAIN_REGISTER`, `contractions: true`, `dateOrder: 'mdy'`, `numberAnd: false`, `pauses: true`, `spoken: 'natural'`. Add `spoken: 'literal'` to the other three presets.
- [ ] **Step 4: Run** `node --test test/dialect.test.js` → PASS.
- [ ] **Step 5: Run full suite** `npm test`; for each failing test that only asserts the old default dialect's wording, update its expectation to the new behaviour (list each updated test in the final report). Anything failing for another reason: stop and investigate.

### Task 2: Natural numbers, times and dates in `articulate()`

**Files:**
- Modify: `src/core/voice/speech-text.js` (`articulate`, clock-time and date branches; add `naturalTime(h, m)` helper)
- Test: `test/speech-text.test.js` (add natural-dialect cases; existing literal cases keep passing using an explicit `resolve({dialect:'british-formal'})`)

**Interfaces:**
- Consumes: `d.spoken` from Task 1.
- Produces: `naturalTime(h: number, m: number, ap?: 'A'|'P'): string` (internal, not exported unless tests need it).

- [ ] **Step 1: Failing tests** (dialect `human-jarvis`): `'3:15 PM'` → `'quarter past three'`; `'3:30 PM'` → `'half past three'`; `'3:45 PM'` → `'quarter to four'`; `'3:00 PM'` → `'three'` when followed by "o'clock" context is not needed: use `'three o'clock'`; `'3:05 PM'` → `'five past three'`; `'15:00'` → `'three o'clock'`; `'9:00 AM'` → `'nine in the morning'` only when AM/PM was written and hour < 12, otherwise `'nine o'clock'`; odd minutes (`'3:07'`) → `'three oh seven'`. Dates: `'2026-11-14'` with injected today `2026-11-14` → `'today'`; `+1 day` → `'tomorrow'`; within 6 days → weekday name; otherwise `'November fourteenth'` (year dropped when current year). Numbers: `'21.4 degrees'` is left to the prompt (no code rounding); `'1st things first'` and a bare `'2026'` title survive unchanged. Literal dialect cases from the existing test (`'3 oh 5 P M'`) still pass with `british-formal`.
- [ ] **Step 2: Run** `node --test test/speech-text.test.js` → new cases FAIL.
- [ ] **Step 3: Implement.** In the clock-time and ISO-date replacements, if `d.spoken === 'natural'` use `naturalTime`/natural dates, else existing code. Date "today" is `d.today?.() ?? new Date()` so tests can inject; `resolve()` need not set it. Year-words rule unchanged for dates with another year. Quarter/half only for minutes 15/30/45; 05/10/20/25/35/40/50/55 → "five past", "ten past", "twenty past", "twenty-five past", "twenty-five to", "twenty to", "ten to", "five to".
- [ ] **Step 4: Run** `node --test test/speech-text.test.js` → PASS. Then `npm test`; fix expectations only where the change is intended.

### Task 3: Spoken list/duration/variant helpers

**Files:**
- Create: `src/core/voice/spoken-list.js`
- Test: `test/spoken-list.test.js` (create)

**Interfaces (Produces):**
- `spokenDuration(totalSeconds: number): string` — `<45s` "under a minute"; `<=90s` "about a minute"; `<60min` "about N minutes" (rounded to 5 above 10 minutes: 33:06 → "about half an hour" at 28-32 min is "about half an hour", 33 → "about thirty-five minutes"; exact rule: round to nearest 5 above 10 min, "half an hour" at 30, "an hour" at 60, "about an hour and a half" at 90, otherwise "about H hours" / "about H hours and N minutes" with N rounded to 15).
- `parseClock(v: string): number | null` — `m:ss` or `h:mm:ss` to seconds (moved from `skill.js`'s local `sec`).
- `spokenSongs(items: {title: string, artist?: string, duration?: string}[], opts?: {max?: number}): string` — default `max = 4`. Rules: if all artists equal, lead "N from {artist}:" (N spelled out) then titles; otherwise "{title} by {artist}" each; titles joined "a, b, c, then d" (last connector "then" for 4+ items, "and" for 2-3); beyond `max`, append " {N-spelled} more after that." Exact titles, never altered. One item → "{title} by {artist}".
- `pick(variants: string[], lastKey: string): string` — module-level memory of the last index per `lastKey`; never returns the same index twice in a row when `variants.length > 1`; returns the only variant for length 1.

- [ ] **Step 1: Failing tests:** the 12-song Scrim queue from the user's example (durations in the spec of the report) → string starts `"Twelve from Scrim:"`, contains `Clairaudience`, `Tale of the Missing Man` exact titles (titles taken verbatim from input), does not match `/\d\./` or `/\(\d:\d\d\)/`, contains "eight more after that"; durations summing to 33:06 → "about half an hour" excluded (33:06 → "about thirty-five minutes" per rule above; assert that exact string); one song; two songs from different artists; missing durations skipped (`spokenDuration` input from parseable ones only, `null` total when none parse); `pick` called 50 times with 3 variants never repeats consecutively; `pick(['x'], 'k')` returns `'x'`; `parseClock('1:02:03') === 3723`, `parseClock('abc') === null`.
- [ ] **Step 2: Run** `node --test test/spoken-list.test.js` → FAIL.
- [ ] **Step 3: Implement** per the signatures above (spell numbers with `intWords`-style helper; export a small `words(n)` from this module for 1-30 rather than importing speech-text internals).
- [ ] **Step 4: Run** → PASS.

### Task 4: Voice-mode media replies use the helpers

**Files:**
- Modify: `src/core/media/skill.js` (`upNext` lines ~214-232; a few canned `say()` lines: "Done.", "Queue cleared.", "Liked.", "Removed …", "Added to the queue", "Next up")
- Test: `test/media.test.js` (or `test/coherence.test.js` if it already builds the media skill with `fakeYtm`; follow whichever constructs `createMediaSkill`)

**Interfaces:**
- Consumes: `spokenSongs`, `spokenDuration`, `parseClock`, `pick` from Task 3.

- [ ] **Step 1: Failing tests:** with a fake ytm queue of the 12 Scrim songs and an explicit count of 12: voice reply matches `/^Twelve from Scrim:/`, has no `"1."`, no `"(2:37)"`, ends with "about thirty-five minutes in total." (match the Task 3 rule), and mentions "eight more after that"; the same call with `source: 'text'` still returns the existing numbered format `Next 12: 1. “Clairaudience” by Scrim (2:37); …. Total 33:06.` (regression guard); default (no count) voice reply no longer says "then …, then …" for 3+ songs beyond the Task 3 format; `'Done.'` in voice comes from a variant set `['Done.', 'Got it.', 'There.']`, never the same twice in a row across 20 calls; text mode keeps `'Done.'` exactly.
- [ ] **Step 2: Run** the test file → FAIL.
- [ ] **Step 3: Implement.** In `upNext`: when `voice`, build the reply with `spokenSongs(q.next, {max: 4})` and, if durations parse, `` `${spokenDuration(total)} in total.` ``; keep the `asked` suffix wording ("Only N are queued.") and the repeat-ONE / empty replies, varied with `pick`. Replace local `sec` with `parseClock`. In `ytmControl`/`find`, wrap the listed canned strings with `voice ? pick([...], key) : original`; the `record` argument of `say` (what the model sees) stays the literal text.
- [ ] **Step 4: Run** the test file → PASS; then `npm test` → all green (update only intentionally-changed voice expectations).

### Task 5: Docs and end-to-end check

**Files:**
- Modify: `docs/jarvis-prompt-rules.md` (one short section: the `human-jarvis` dialect, `spoken` flag, voice-mode helpers, how to switch back to `british-formal`).

- [ ] **Step 1:** Add the doc section.
- [ ] **Step 2:** Run `npm test` and the eval/golden tests the repo already has (`npm run` scripts for `eval` if present); report any unrelated pre-existing failures separately.
- [ ] **Step 3:** Tell the user: a saved setting of `speech.dialect = 'british-formal'` in their config overrides the new default; pick "human-jarvis" in Settings → How he talks (or delete the saved value), and he must restart/reload for the prompt to pick it up.

---

**Self-review notes:** every spec goal maps to a task (dialect → 1; numbers/dates → 2; helper + queue → 3/4; variants → 3/4; docs → 5). Names consistent: `spoken`, `spokenSongs`, `spokenDuration`, `parseClock`, `pick`. Rule in Task 3 for durations is pinned (33:06 → "about thirty-five minutes"), so the "about half an hour" phrase in the spec's example is satisfied only for ~30 min queues; this is called out in the report.
