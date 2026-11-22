# Speaker Recognition and Guest Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** JARVIS tells the owner's voice from another voice, stops mistaking the owner for a stranger, and answers strangers in a locked-down guest mode.

**Architecture:** `speaker.js` gains scoring against the best-matching prints, a three-way `verdict`, a bounded self-updating profile and additive enrolment. The voice controller keeps a per-conversation verdict (most restrictive wins) and passes it to `orchestrator.send(..., { speaker })`. A non-owner turn is tainted (confirm-tools, memory writes refused); a guest turn also loses the owner's personal context and every acting or writing shortcut before the model.

**Tech Stack:** Node (CommonJS), `node:test` (`npm test`), onnxruntime WeSpeaker model (unchanged), Electron main wiring.

**Spec:** `docs/superpowers/specs/2026-11-13-speaker-recognition-design.md` (read its "Settled after the builder check" and "Owner decisions" sections).

## Global Constraints

- Local only: voiceprints stay in `<data>/voiceprint.json`; only scores are logged, never audio or text.
- Verdict bars: `owner` score >= `speakerThreshold` (0.45); `unsure` from `speakerGuestBelow` (0.30) up to it; `guest` below. `lenient` lowers both by 0.1, and a lenient `owner` is reported as `unsure` (reading yes, acting no).
- Fail open: no profile, missing model or an error gives `owner`; a strict (spoken yes) check fails closed unless the verdict is `owner`. Audio under 0.5 s gives no verdict (caller keeps the previous one).
- Top-k scoring: mean of the 3 best cosine similarities against individual prints (all of them when fewer than 3).
- Profile cap 30 prints total, at most 20 learned. Learn only when score >= `speakerLearnAbove` (0.60), audio >= 1.5 s, not lenient, verdict `owner`, `speakerLearn` true. Learning replaces only a learned print (the one closest to the new one); enrolled prints are never evicted by learning.
- `speakerGate: false` = no gating at all (every voice is the owner). `speakerGate: true` follows `speakerMode`: `guest` (default) or `block` (clear guests ignored as today; `unsure` passes but cannot act).
- Tainted turns cannot start `risk:'confirm'` tools or write memory/clipboard (`tools/registry.js` `tainted`). Non-owner turns reuse that.
- Typed chat and the hotkey start as `owner`. No new free text on the public `/ai/stream` (the `speaker` bus event carries only `{ ok, score, verdict }`, bridge allowlist updated for those fields).
- New and edited files keep LF line endings (`git ls-files --eol`). The working tree may hold other sessions' uncommitted edits (e.g. `package.json`): stage only your own files by explicit path, never `git add -A`.
- Commit messages: `type(scope): subject`, ending with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- A guest or unsure voice says "call me Bob" / "remember that ..." / "turn the volume to 10" / "lock the PC": no personal data changes and no confirm-tool runs via the model, `fastPath`, instant answers or memory shortcuts (Task 4).
- A stranger repeatedly scoring 0.30 to 0.50 never gets learned, and learning never evicts an enrolled print or exceeds the cap (Task 1).
- `voiceprint.json` with 2 prints, no `learned` field, corrupt, or missing: loads, verifies, never throws; a model error never locks the owner out (Task 1).
- Hotkey conversation followed by a stranger's utterance: that turn is downgraded; an owner utterance after a guest wake does not upgrade it (Task 3).
- A pending confirm answered by a non-owner or lenient voice: refused, owner's typed yes still works (Task 3).

---

### Task 1: Speaker engine (scoring, verdict, learning, additive enrolment)

**Files:**
- Modify: `src/core/voice/speaker/speaker.js`
- Test: `test/speaker-verdict.test.js` (new; synthetic embeddings through a fake `embed`, see how `test/speaker.test.js` builds a speaker)

**Interfaces:**
- Produces: `verify(pcm, rate, { lenient, strict, learn }) -> Promise<{ ok: boolean, score: number|null, verdict: 'owner'|'unsure'|'guest'|null, reason?, threshold }>`. `ok` stays "score >= owner bar" (fail-open and strict rules as today). `verdict` is `null` for audio under 0.5 s. Reads `speakerThreshold`, `speakerGuestBelow`, `speakerLearn`, `speakerLearnAbove` from `getConfig()` with the defaults above.
- Produces: `enroll(clips, { append = false })` (append keeps existing prints, adds the new ones, applies the cap by dropping oldest learned first, then oldest enrolled); `counts() -> { enrolled, learned }`; `recent() -> [{ t, score, verdict }]` (last 20, scores only); `count()` unchanged (total).
- File format: `{ prints, learned?: boolean[], at }`; missing `learned` means all enrolled; atomic write as today.

- [ ] **Step 1:** Write failing tests in `test/speaker-verdict.test.js`: top-3 mean beats the centroid on a profile with two clusters (a quiet cluster and a loud one); verdict boundaries at exactly 0.45 and 0.30, and lenient shifts both by 0.1 with a lenient owner reported `unsure`; learning at >= 0.60 adds a learned print; no learning at 0.59, when lenient, when `speakerLearn` is false, for audio under 1.5 s, or for an `unsure`/`guest` verdict; learning at the cap replaces the closest learned print and never an enrolled one; with a profile full of enrolled prints nothing is learned; `enroll(clips, { append: true })` keeps old prints; a legacy file without `learned` loads; a corrupt file means not enrolled; strict returns `ok:false` for anything but `owner`; `recent()` holds at most 20 entries.
- [ ] **Step 2:** Run `node --test test/speaker-verdict.test.js`; expect FAIL.
- [ ] **Step 3:** Implement in `speaker.js` per the Interfaces block (keep the centroid for the enrolment agreement check only; score each utterance against individual prints).
- [ ] **Step 4:** Run `node --test test/speaker-verdict.test.js test/speaker.test.js` then `npm test`; expect PASS.
- [ ] **Step 5:** Commit `feat(speaker): top-3 scoring, three-way verdict, bounded self-update`.

### Task 2: Config, settings and self-check

**Files:**
- Modify: `src/core/config.js` (defaults and `merge()` validation next to `speakerGate`/`speakerThreshold`), `src/core/settings.js` (patch whitelist next to `speakerGate`), `src/ui/settings.html`, `src/ui/settings.js`, `src/main/checks.js` (the voice line at ~72), `src/main/main.js` (the `recognises the owner's voice` line at ~260)
- Test: `test/config.test.js`, `test/settings.test.js`

**Interfaces:**
- Produces config keys: `speakerMode: 'guest'|'block'` (default `'guest'`; anything else falls back and is reported like other bad keys), `speakerGuestBelow: number` (0.1 to 0.5 and below `speakerThreshold`, default 0.30), `speakerLearn: boolean` (default true), `speakerLearnAbove: number` (0.5 to 0.95, default 0.60).
- Settings UI: a `speakerMode` select beside the existing `speakerGate` checkbox and a `speakerLearn` checkbox. Thresholds are `config.json` only.

- [ ] **Step 1:** Tests: defaults; invalid values fall back and are reported; `applyPatch` accepts valid and refuses invalid values for the four keys; `speakerGuestBelow` >= `speakerThreshold` is refused; the self-check and capabilities lines mention the mode and the last scores (use `ctx.speaker.recent()` guarded for fakes without it).
- [ ] **Step 2:** Run the two test files; expect FAIL.
- [ ] **Step 3:** Implement the keys, whitelist, UI controls and the two status lines.
- [ ] **Step 4:** Run both files and `npm test`; expect PASS.
- [ ] **Step 5:** Commit `feat(config): speaker mode and learning settings`.

### Task 3: Controller verdicts and conversation state

**Files:**
- Modify: `src/core/voice/controller.js` (`speakerOk` ~163, `yesOk` ~174, wake path ~252, interrupt path ~280, `runText`/`orchestrator.send` ~386)
- Test: `test/voice-controller.test.js`

**Interfaces:**
- Consumes: Task 1 `verify(...)` with `verdict`; Task 2 config keys.
- Produces: `orchestrator.send(sessionId, text, { source: 'voice', speaker })` where `speaker` is `'owner'|'unsure'|'guest'` (the effective verdict). `speaker` bus event: `{ ok, score, verdict }`.
- Rules: the wake utterance sets the conversation verdict (a hotkey wake sets `owner`); each later utterance is verified with `learn: true` (not for lenient/interrupt audio); the effective verdict is the most restrictive (`owner` > `unsure` > `guest`) of the conversation verdict and the current utterance's, a `null` verdict (too short) or an error keeps the conversation verdict, and the conversation verdict only ever moves down within a conversation. A new conversation resets it. `speakerGate:false` or no profile gives `owner` always. In `block` mode a `guest` verdict on a wake or utterance is ignored as today and `unsure` passes. `yesOk` (strict) accepts a spoken yes only for a non-lenient `owner`; otherwise it logs "Ignored a spoken yes from a voice that is not confirmed as yours" and ignores it.

- [ ] **Step 1:** Tests with a fake `speaker` returning scripted verdicts: guest wake in `guest` mode reaches `send` with `speaker:'guest'` (not ignored); in `block` mode it is ignored; `unsure` in `block` mode reaches `send` as `unsure`; hotkey conversation then a guest follow-up sends `guest` for that turn; owner follow-up after a guest wake still sends `guest`; null verdict keeps the previous; a spoken yes from `unsure` or `guest` or a lenient check does not confirm; `speakerGate:false` always `owner`.
- [ ] **Step 2:** Run `node --test test/voice-controller.test.js`; expect FAIL.
- [ ] **Step 3:** Implement the verdict function and conversation state in `controller.js`, replacing the boolean `speakerOk` call sites; pass the effective verdict into `send`.
- [ ] **Step 4:** Run the file and `npm test`; expect PASS.
- [ ] **Step 5:** Commit `feat(voice): per-conversation speaker verdict`.

### Task 4: Orchestrator guest and unsure lockout

**Files:**
- Modify: `src/core/orchestrator.js` (`send` signature ~163, `turn` creation ~318, `fastPath`/instant calls before the model ~202, `memoryBlock` calls ~178 and ~298, `buildSys` ~291), `src/core/brain/prompt.js` (`systemPrompt` and `briefPrompt` accept `guest`), `src/core/tools/registry.js` (refusal text when the taint comes from the speaker)
- Test: `test/orchestrator.test.js` or a new `test/orchestrator-speaker.test.js`; `test/skills-trust.test.js` pattern for tool refusals

**Interfaces:**
- Consumes: `send(sessionId, text, { source, speaker })`, `speaker` default `'owner'`.
- Produces: `turn.speaker`, `turn.tainted = true` for `unsure` and `guest`; for `guest` additionally the prompt context omits `user` and `memory` (the owner's name, "about", memory block, music taste) and gets one added line: the speaker is not the owner, must not share or guess personal information, may answer general questions. For any non-owner turn: `memoryBlock.onUserMessage` and `forTurn` are not called, `fastPath` and instant answers that act or write are skipped (builder: read `fastPath` and `brain/instant*.js`, keep only pure-read answers such as time/date; every skill or tool with `risk:'confirm'`, `needsClean`, or a write effect such as "call me", "remember", settings, volume or media control goes through the model path so the taint rules apply). Refusal text from the registry for a speaker-tainted turn: unsure `Error: I can't be sure it's you, so I won't do that by voice. Confirm with the keyboard or the hotkey.`, guest `Error: I only do that for my owner.`

- [ ] **Step 1:** Tests with the fake provider and tools: guest turn with a confirm tool call is refused with the guest text; unsure turn refused with the unsure text; memory write tool refused for both; guest prompt contains none of the user name, about text or memory block and does contain the guest line; unsure prompt keeps them; `memoryBlock` fakes record zero calls for non-owner turns; "call me Bob" and "remember that X" from a guest change nothing (config.user untouched, no cortex write); an owner turn is unchanged (existing tests stay green); a pure-read instant answer ("what time is it") still works for a guest.
- [ ] **Step 2:** Run the new tests; expect FAIL.
- [ ] **Step 3:** Implement per Interfaces. List every pre-model shortcut you gated in the commit body.
- [ ] **Step 4:** Run the tests and `npm test`; expect PASS.
- [ ] **Step 5:** Commit `feat(orchestrator): guest and unsure speaker lockout`.

### Task 5: Additive enrolment, rollout and docs

**Files:**
- Modify: `src/core/voice/speaker/enroll.js`, `src/main/main.js` (`ctx.enrollVoice` ~553 and the bridge/settings handler that calls it), `src/ui/settings.js` and `settings.html` (the `voiceEnroll` button, ~203), `docs/source-of-truth.md`, `README.md` (one line on guest mode)
- Test: `test/speaker-enroll.test.js` (new; fake speaker and frames)

**Interfaces:**
- Consumes: Task 1 `enroll(clips, { append })`.
- Produces: `enrollVoice(ctx, { seconds = 12, append = true })`: appends by default; the settings button reads "Add to my voice" when already enrolled, with a separate "Start over" that passes `append:false` (old replace behaviour). The enrolment prompt asks for different styles over the recording (normal, quiet, tired and fast); exact wording is yours. The result reports `{ ok, count, learned }`.

- [ ] **Step 1:** Tests: `enrollVoice` with `append` keeps old prints and adds new; `append:false` replaces; the agreement check still rejects mixed clips; the result includes the counts.
- [ ] **Step 2:** Run `node --test test/speaker-enroll.test.js`; expect FAIL.
- [ ] **Step 3:** Implement the enrolment change and the two buttons; document `speakerMode`, learning and the one-time re-enrolment (the current profile has only 2 prints) in `docs/source-of-truth.md` and `README.md`.
- [ ] **Step 4:** Run the file and `npm test`; expect PASS.
- [ ] **Step 5:** Commit `feat(speaker): additive enrolment and docs`.

---

Self-review: every spec section maps to a task (verdict/scoring/learning/enrolment: 1; settings and diagnostics: 2; conversation scope and block/guest/strict yes: 3; guest prompt, taint, locked paths: 4; additive enrolment and rollout: 5). Out of scope per the spec: per-person memory, the file/page verb, the export, a second enrolled person, cortex changes.
