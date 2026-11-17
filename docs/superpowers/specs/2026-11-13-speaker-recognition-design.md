# Speaker recognition and guest mode: design

Date 2026-11-13. Replaces roadmap item T10 ("per-speaker memory") of `docs/superpowers/plans/2026-11-12-gap-closure.md`, narrowed by the owner to: JARVIS must tell whether the voice is the owner's or someone else's, and must stop mistaking the owner for a stranger.

## Why

The owner does not need per-person memory. They want JARVIS to know "it is me" versus "someone else", and to recognise them reliably. Today it does neither well:

- `src/core/voice/speaker/speaker.js` is a block-only gate: one enrolment (a single 12 s recording, `voiceprint.json`, 2026-11-10), collapsed into one centroid, compared with a fixed cosine bar of 0.45 (`speakerThreshold`, lowered by 0.1 when JARVIS's own voice is mixed in).
- The owner's `jarvis.log` since 2026-11-10 holds 173 "Ignored ... not yours" lines. 149 scored 0.30 to 0.45 and only 24 scored below 0.30. A different person normally scores about 0.1 to 0.3. Most rejections look like the owner just under the bar (voice varies by tiredness, volume, speed).
- Another voice is ignored silently, never answered.

## Goals

1. **Reliable owner recognition.** Far fewer false "not yours" on the owner's real voice, without making strangers pass.
2. **Guest mode.** When the voice is clearly not the owner's, JARVIS still answers, with the owner's private data and powers locked.
3. **Safe on doubt.** A borderline score is never treated as a stranger; it is "unsure" and is treated as the owner for reading, but not for acting.

## Non-goals

Per-person memory, owner field on cortex nodes, more than one enrolled person, the "remember this file/page" verb, the cortex export, cloud anything. No change to cortex, no migration.

## Anti-goals (failure even if it "works")

- The owner locked out of their own memory by a wrong guest verdict.
- A stranger confirming an action (spoken "yes"), writing memory, or reading personal memory.
- The profile drifting toward someone else because a stranger's confident-looking audio was added to it.
- Voice audio or voiceprints leaving the PC, or being logged beyond a score.

## Constraints

- Local only. Voiceprints stay in the data folder; only scores are logged.
- Tainted-turn rules stay: tainted turns cannot start `risk:'confirm'` tools or write memory. Guest turns use the same lockout.
- `npm test` stays green; tests first.
- Typed chat and the hotkey are always the owner (the hotkey is never gated today).
- A broken or missing speaker model never locks the owner out (verify fails open), as today. A spoken yes stays strict (fails closed), as today.

## Approaches considered

1. **Scoring and policy changes only** (a lower fixed threshold, guest mode on top): cheapest, but one average voice and a fixed bar keep misjudging a voice that varies. Rejected as the sole fix.
2. **Better scoring, a self-updating profile, additive enrolment, and a three-way verdict (chosen by the owner).** Fixes the cause (one style, one average, fixed bar) and makes guest mode safe.
3. **Retrain or swap the embedding model.** Large, needs data, and the WeSpeaker model is already good; the weakness is how the profile is built and used, not the model. Rejected.

## Design

### Verdict

`verify()` returns, besides `{ ok, score }`, a `verdict`: `owner`, `unsure` or `guest`.

- `owner`: score >= the owner bar (`speakerThreshold`, default 0.45, minus 0.1 when lenient).
- `unsure`: score from `speakerGuestBelow` (default 0.30, minus 0.1 when lenient) up to the owner bar.
- `guest`: score below `speakerGuestBelow`.
- No profile, model missing, error: `owner` with reason (fails open). Too-short audio (< 0.5 s): no verdict, the caller keeps the current one.

### Scoring (goal 1)

Score an utterance against the owner's saved prints, not only the average: take the mean of the top 3 cosine similarities against individual prints (or all of them if fewer). Keep the centroid for the self-update confidence test and for the enrolment sanity check. The builder tunes "top 3" against the owner's real prints and the logged score range (149 of 173 rejections at 0.30 to 0.45); the intent is that the owner's normal speech clears the bar while another voice still scores below it.

### Self-updating profile (goal 1)

When a verification scores at least `speakerLearnAbove` (default 0.60) and the utterance is a wake or a normal-length utterance (>= 1.5 s), add its print to the profile. Bounded: at most 30 prints; when full, replace the print closest to the new one (keeps variety, drops redundancy). Never learn from a `lenient` check (JARVIS's voice mixed in), from a guest or unsure verdict, or when `speakerLearn` is false. Saved atomically as today (`voiceprint.json`). Learned prints are marked in the file so they can be listed or cleared separately from enrolled ones; clearing the profile clears both. This is the drift control: only high-confidence owner audio is ever learned.

### Additive enrolment (goal 1)

Running enrolment again appends its prints (still capped at 30; oldest learned prints go first, enrolled prints last) instead of replacing them. The enrolment prompt asks for different styles over the recording ("normal, then quieter, then tired and fast"); the exact wording is the builder's. The existing "clips must agree" sanity check stays. A separate "start over" action keeps the old replace behaviour.

### Guest mode (goal 2)

New setting `speakerMode`: `guest` (default once a voice is enrolled) or `block` (today's behaviour: other voices are ignored). `speakerGate` is kept as a compatibility alias: `speakerGate: false` means no gating at all (everything is the owner); migration maps `true` to `speakerMode`.

In `guest` mode a non-owner wake or request is handled, not ignored:

- The turn carries `speaker: 'guest'` into `orchestrator.send(sessionId, text, { source: 'voice', speaker })`.
- `speaker: 'guest'` sets `turn.tainted = true` (confirm-tools refused, memory writes refused, clipboard write refused).
- The prompt for a guest turn omits the owner's personal context: user name and "about", the memory block, recalled facts and the music-taste context. Guests still get time, web, weather, news, general answers.
- A spoken yes from a non-owner never confirms anything (already strict).
- The turn is logged as a guest turn (score only, no audio, no text beyond what turns already log), and the `speaker` bus event carries the verdict (the public stream allowlist stays unchanged: no new free text; the verdict value is allowed as an enum).

### Unsure (goal 3)

`unsure` behaves as `owner` for reading (the owner's memory is in the prompt, so a tired owner is not locked out), but as a guest for acting: confirm-tools and memory writes are refused unless confirmed another way (typed yes or the hotkey; a spoken yes from an unsure voice fails as strict does today). JARVIS says nothing special about it except one short spoken line the first time in a conversation when an action is refused for this reason ("I'm not sure it's you; confirm with the keyboard"). The exact line is the builder's.

### Conversation scope

The wake utterance sets the conversation's verdict. Later utterances in the same conversation are re-verified; a `guest` result switches the turn to guest, an `unsure` or too-short or errored result keeps the previous verdict. A new conversation starts fresh. Hotkey and typed turns are `owner`.

### Controller and orchestrator changes

- `controller.js`: `speakerOk()` becomes a verdict function; in `guest` mode it no longer returns false for non-owner audio, it passes the verdict on; in `block` mode a `guest` verdict still ignores the audio as today (an `unsure` verdict passes as owner in `block` mode so the owner is not blocked on a doubtful score).
- `orchestrator.send()` accepts `{ speaker }` ('owner' | 'unsure' | 'guest'); guest taints and omits personal context; unsure taints for tools and writes only (not for prompt context).
- Settings: `speakerMode`, `speakerGuestBelow`, `speakerLearn`, `speakerLearnAbove` in `config.js` defaults, validation, and the settings whitelist (follow the `library.dir` / `livestate.windowTitle` pattern). Settings UI: a mode select and a learn checkbox; thresholds stay in `config.json`.
- A small "Voice" diagnostic: the last 20 scores with their verdicts, in the existing self-check or dashboard path, so the owner can see their own score range (the builder picks the place; scores only, no audio).

## Review focus

- Guest and unsure turns can never start a confirm-tool, write memory or write the clipboard, via voice, typed, task-runner or background paths.
- Guest prompts contain none of: user name, "about", memory block, recalled facts.
- The self-update never learns from guest/unsure/lenient audio and cannot grow past the cap; a stranger saying "Jarvis" repeatedly with a score of 0.3 to 0.5 never enters the profile.
- Fail-open: missing model, error, no profile give `owner`; strict yes still fails closed.
- Clearing the profile resets learned prints; `voiceprint.json` stays one file, atomic.
- `block` mode behaves as today for clearly non-owner voices.

## Left to the builder

Exact top-k and the final default thresholds (tune against the owner's `voiceprint.json` and the logged scores), the enrolment prompt wording, the guest-refusal spoken line, where the score diagnostic lives, the file format for marking learned prints, and the test fixtures (synthetic embeddings are enough; no audio needed).

## Calls I made (not the owner's)

- `speakerMode` default is `guest` once a voice is enrolled; the owner was asked to choose and said yes to approve the design without naming a default.
- `unsure` zone between 0.30 and 0.45; learn threshold 0.60; profile cap 30; top-3 scoring.
- Other people near the PC: the owner did not answer, so the defaults stay on the tighter side (no threshold lowering is proposed).

## Settled after the builder check

Facts found: the owner's `voiceprint.json` (2026-11-10) holds only **2 prints**, so top-3 scoring equals the average until more are added. The first learned and re-enrolled prints are what make goal 1 work; a one-time re-enrolment by the owner is part of the rollout. The file already stores individual prints (`{ prints: [...], at }`); keep it backward compatible and mark learned prints with an optional parallel list (`learned: [indices]` or per-print flag, builder's choice). With fewer than 3 prints, score against all of them.

Builder's calls (marked as mine, not the owner's):

- **Lenient audio** (JARVIS's own voice mixed in) can give `owner` for reading, but never acting rights: a lenient `owner` or `unsure` counts as `unsure` for acting. The verdict carries a separate `canAct` flag, and a test covers it.
- **Conversation verdict.** For acting, the effective verdict is the most restrictive of the wake verdict and the current utterance's verdict (a later `unsure` or `guest` follow-up downgrades acting for that turn; a later `owner` does not upgrade a guest wake). For reading personal context, `owner` or `unsure` keep it and only `guest` removes it. Too-short or errored audio keeps the previous verdict. A new conversation starts fresh.
- **Locked paths.** A turn whose effective verdict cannot act is tainted. The builder lists every `turn.tainted` / confirm / memory-write / clipboard-write path (grep `tainted`, `confirm.propose`, `risk: 'confirm'`) in the plan and adds a test per path. A task started by such a turn carries the taint (the task runner already taints). A pending confirm survives its existing 60 s window; a spoken yes from a non-owner or unsure voice is refused; the owner can still answer by typed yes or the hotkey.
- **Unsure in `block` mode:** not ignored, and still no acting rights (the same lockout as in `guest` mode).
- **Self-update** replaces only learned prints, never enrolled ones; with the cap full of enrolled prints, it learns nothing. Cap 30 total; at most 20 learned slots.
- **Guest prompt:** one added line telling the model the speaker is not the owner and that it must not share or guess personal information; it still answers general questions.

## Owner decisions

- 2026-11-13: `speakerMode` starts as `guest` on upgrade. An existing `speakerGate: true` migrates to `guest`, not `block`; `speakerGate: false` stays "no gating". The owner approved the design on this basis.
