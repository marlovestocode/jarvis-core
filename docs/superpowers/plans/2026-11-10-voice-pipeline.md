# Voice pipeline upgrade: implementation plan

Executor: Claude Opus 5.5. Follow phases in order. Every phase ends at a **GATE**: stop, report evidence to the user, and wait for a go-ahead before starting the next phase.

## Goal

Make voice input reliable and low-latency: fewer missed or false wakes, no clipped or runaway captures, better transcripts, with the existing Whisper + Piper stack kept. Add two tiny models (Silero VAD, openWakeWord) in place of hand-rolled logic.

## Current state (verified in code)

- Mic: hidden window, `getUserMedia` with `echoCancellation/noiseSuppression/autoGainControl: true` (`src/ui/mic.js:19`), AudioWorklet → 20 ms Int16 frames, 16 kHz → `ctx.voice.feed` (`src/main/main.js:233`). **AEC is already on; do not add it.**
- VAD: `src/core/voice/vad.js`, energy-only, noise floor from first 300 ms, threshold `floor × 3`. Three instances in `controller.js` (`vad`, `idleVad`, `speakVad`). `SPEAKING_GAIN = 3` is the echo hack.
- Wake: engine `kind: 'listen'` in `main.js:173`; `controller.idleFeed` transcribes every idle utterance (≤ 8 s) with Whisper and tests `WAKE_PREFIX`. Windows SAPI wake exists as a fallback.
- STT: `whisper.cpp` server, `ggml-base.en.bin`, CPU, `-ac 768`, vocabulary `prompt` **already set** in `main.js:164`.
- TTS: Piper `en_GB-alan-medium`, per-sentence streaming (`piper.js`). Keep.
- Engine fallback: `engine(kind)` in `main.js:178` (configured → windows → none).
- Tests: `npm test` = `node --test "test/**/*.test.js"`. Existing: `voice-controller.test.js`, `piper.test.js`, `windows-tts.test.js`, `config.test.js`, `settings.test.js`. E2E: `src/main/selftest.js`, `scripts/selftest-speaking.js`.

## Global rules

1. **Precondition:** the working tree currently has uncommitted changes from another feature (branch `feat/media-control`, including `main.js`, `speech-text.js`, `windows-speech.js`). Do not stage, revert or reformat them. Ask the user to commit or stash them, then create branch `feat/voice-pipeline` from there. If the user says to proceed dirty, edit only the lines each phase names and never `git add -A`.
2. TDD: failing test first, then code, per unit. Run the full `npm test` at the end of every phase; zero regressions against the Phase 0 baseline count.
3. **Never download anything without asking the user first** (state filename, source URL, size). Record the SHA-256 of each downloaded model in `engines/MODELS.md`. No model binaries committed to git (check `.gitignore` covers `engines/`).
4. Every new engine must **fall back silently-but-logged** to the previous behavior if its model or runtime is missing or throws (use the `logOnce` pattern). Voice must never end up dead because a new component failed.
5. Every behavior switch sits behind a config flag with the old behavior still selectable. Flags live in `src/core/config.js` (update `test/config.test.js` and `test/settings.test.js` accordingly).
6. Do not change the public controller API (`listen, feed, cancel, applyWake, speaking, active, mode`) or the bus events (`state`, `level`, `wake`, `log`, `token`).
7. Keep files small and single-purpose; match the existing style (CommonJS, 2-space, terse comments explaining why).
8. Commit only if the user asks. If they do: one commit per phase, with the attribution line from the session reminder.

---

## Phase 0: Baseline, tracing, test corpus (no behavior change)

**0.1 Baseline.** Run `npm test`; record pass/fail counts in the report. Run the selftests that work headless and note results.

**0.2 Trace instrumentation.** New `src/core/voice/trace.js`: `createTrace({ now = performance.now })` → `mark(name)`, `reset()`, `summary()` returning ms deltas. Marks, emitted from `controller.js` only (additive, no logic change): `speech_start`, `speech_end` (VAD end), `stt_done`, `first_token`, `first_audio` (first `beginSpeaking`/`speak`), `turn_end`, `wake_heard`. On `turn_end` emit `bus.emit('log', { level: 'debug', text: 'voice-timing ' + JSON.stringify(summary) })` and append a line to `<userData>/voice-trace.jsonl` through an injected `writeTrace` (no fs in the controller; wire in `main.js`). Tests: fake clock, assert marks and deltas.

**0.3 Corpus.** `eval/voice/phrases.json`: ≥ 40 phrases: 15 real commands (media, time, system, search), 10 long utterances (15–25 words), 5 with mid-sentence pauses, 10 **non-wake** speech lines (including near-misses: "Travis", "service", "Jarvis's", "jar of beans"). `scripts/make-voice-corpus.js` renders them to 16 kHz mono WAV in `eval/voice/out/` (gitignored) using Piper (`engines/piper`), then mixes each at SNR 20/10/5 dB with generated noise: white, pink, and "fan" (low-passed noise, 120 Hz hum). Also support `eval/voice/recorded/*.wav` (the user's own voice, optional) with matching `*.txt` transcripts. Piper audio is not the user's voice; say so in every metrics report.

**0.4 Baseline metrics.** `scripts/voice-bench.js` loads the corpus and reports, for the **current** stack: VAD recall/early-cut/false-start (via `createVad`), wake hit/false-accept (via Whisper + `WAKE_PREFIX`), WER and latency per STT. Save as `eval/voice/baseline.json`. Later phases compare against this file.

**GATE 0:** report baseline numbers and typical `end→first_audio` latency from a manual run of the app. Do not proceed if the baseline cannot be produced.

---

## Phase 1: Silero VAD

**1.1 Runtime.** Add `onnxruntime-node` to `dependencies`, exact-pinned to a stable release at least 2 weeks old (verify it loads under Electron 45 in the main process via `electron .` smoke, not only plain node). Ask before `npm install`.

**1.2 Model.** Ask the user to approve downloading `silero_vad.onnx` (v5, ~2 MB) from the official `snakers4/silero-vad` repo into `engines/vad/`. Record SHA-256.

**1.3 Wrapper** `src/core/voice/silero.js`:
- `loadSilero({ modelPath, ort })` → shared `InferenceSession`. Read `session.inputNames/outputNames` at load and adapt (v5: `input` `[1, 64+512]` float32 incl. 64-sample context, `state` `[2,1,128]`, `sr` int64 16000; outputs `output` probability, `stateN`). Verify against the actual model file; do not trust this signature blindly.
- `createSileroStream()` → per-consumer state (own `state` tensor and context), `push(int16, rate)` re-frames the 320-sample mic frames into 512-sample frames (carry remainder), runs inference serially, produces probabilities.
- Reject `rate !== 16000` by resampling or throwing, whichever the existing mic path guarantees (it is 16 kHz).

**1.4 Model-backed VAD** `src/core/voice/vad-model.js` exporting `createModelVad(opts)` with the **same interface** as `createVad` (`push, reset, setGain, heard, rms`). `ort` is async but `push` must stay sync: probabilities resolve in a serial queue, a state machine consumes them, and any resulting `'start' | 'end' | 'max'` is **latched and returned by the next `push()`** (≤ ~50 ms lag; document it). State machine: start when prob > 0.5 for ≥ 3 frames (96 ms); end when prob < 0.35 continuously for `silenceMs`; `max` as before; keep `rms` from the energy calc for the UI level meter. `setGain(g)`: `g > 1` (speaking mode) → start threshold 0.8 and ≥ 5 frames, replacing the ×3 energy hack. Preserve `reset()` semantics (clears stream state).

**1.5 Controller wiring.** `createVoiceController` accepts `vadFactory` (default: `createVad`); `main.js` passes a factory that returns `createModelVad` when `config.vad === 'silero'` and the model loaded, else `createVad`. Add `config.vad: 'silero' | 'energy'` (default `'energy'` until Gate 1 passes). One loaded session, separate stream state per VAD instance (`vad`, `idleVad`, `speakVad`). On load failure: `logOnce('Silero VAD', err)` and use energy.

**1.6 Tests.** Unit tests with a fake session (scripted probabilities): start/end/latching/hysteresis/max/reset/setGain. Controller test: inject a fake `vadFactory` and confirm the capture lifecycle is unchanged. Corpus test in `voice-bench.js` for both VADs.

**GATE 1 (adopt only if all hold on the corpus):** speech recall ≥ 98%; zero premature cuts on the 400 ms mid-sentence pauses; ≤ 1 false start in 60 s of noise-only for every noise type; strictly better than the baseline on the 5 dB set. Then flip the default to `'silero'` and keep `'energy'` selectable. Report numbers vs `baseline.json`. If it fails, do not flip the default; report why.

---

## Phase 2: openWakeWord

**2a. Spike (throwaway script, no app changes).** Ask permission to download `melspectrogram.onnx`, `embedding_model.onnx` and `hey_jarvis_v0.1.onnx` (official `dscripka/openWakeWord` release assets) into `engines/wake/`. `scripts/oww-spike.js` reimplements the pipeline against those exact files, checking input/output names and shapes against the upstream Python source: 1280-sample (80 ms) chunks → mel features (apply the same scaling the Python code does) → embedding model over a sliding 76-frame window, stride 8 → wake model over the last 16 embeddings → score per 80 ms. Run on the corpus wake and non-wake clips.

**GATE 2a:** ≥ 90% detection on "Jarvis" clips (including "hey Jarvis" and run-on commands) at a threshold that gives 0 false accepts across all non-wake speech plus 10 min of noise. If this fails, **stop Phase 2**, report, keep the Whisper wake word, and go to Phase 3. If it passes, pick the default threshold from the data (not 0.5 by assumption).

**2b. Engine** `src/core/voice/openwakeword.js`: `createOpenWakeWord({ ort, dir, threshold, cooldownMs = 2000 })` → `{ id: 'oww', kind: 'stream', label, available, status, start(onWake), stop(), feed(pcm, rate) }`. `feed` accumulates 1280-sample chunks, runs the pipeline serially, fires `onWake({ score })` when the score ≥ threshold for 2 consecutive chunks, then enforces the cooldown. Own state, resettable.

**2c. Controller.** In `feed()`, when `mode === 'idle'` and `wakeOn?.feed` exists, call `wakeOn.feed(pcm, sampleRate)` **and** keep pushing the pre-roll ring as in the existing non-`listen` engine path (the `engine.start(cb)` branch in `applyWake` already does `listen()` + replays `ring`; reuse it). Do not run Whisper in idle for this engine kind. `STOP_WORDS` and speaking-mode barge-in stay on the Whisper path unchanged.

**2d. Wiring and fallback chain.** Register the engine in `main.js`. Replace the single fallback in `engine('wake')` with an ordered chain `oww → whisper → windows`, taking the first available. Config: `engines.wake` default `'oww'` (only after Gate 2b), `wakeThreshold` (clamped 0.1–0.95). Update the settings UI/list if engines are enumerated (`src/ui/settings.js`, `settings.html`, tests).

**2e. Tests.** Fake `ort` sessions with scripted scores for threshold, 2-consecutive rule, cooldown, chunk re-framing; controller test that a wake fires `wake` then `listen` with the pre-roll replayed; fallback-chain test.

**GATE 2b:** run the app; 20 manual wake attempts at normal distance and 20 while music plays through speakers, plus 5 min of unrelated talk. Report hits and false wakes. Adopt `'oww'` as default only if hits ≥ 18/20 in both conditions with ≤ 1 false wake in 5 min.

**Optional 2f (only if the user wants it):** while speaking, use the oww max score within the utterance to skip Whisper for utterances that never scored ≥ 0.3. Must not worsen "Jarvis, stop" latency: verify with `scripts/selftest-speaking.js`.

---

## Phase 3: STT quality

**3.1 Make the model a config value**: `config.sttModel` (file name under `engines/whisper/`, default the current `ggml-base.en.bin`) used in `main.js:163`. Test the path resolution and the fallback to the default if the file is missing.

**3.2 Vocabulary.** The `prompt` already exists. Extend it with the real command vocabulary taken from `src/core/tools/*` tool names and common phrases, and keep it ≤ ~200 tokens. Bench with and without; confirm no hallucinated prompt echo on silence/noise clips (the existing `cleanTranscript` must still blank them).

**3.3 Candidates.** Ask permission to download, one at a time, from official `ggerganov/whisper.cpp` or Hugging Face model repos: `ggml-small.en-q5_1.bin`, and `ggml-distil-small.en.bin` if available as a ggml file. Run `voice-bench.js --stt <model>` for WER (clean + each noise level + recorded user clips) and latency (p50/p95 for 3 s, 8 s and 15 s clips on this CPU). Check `whisper-server --help` for useful flags (e.g. no-speech threshold, suppress non-speech tokens) and bench any that apply; only keep flags the bench shows help.

**GATE 3 (adopt a model only if):** ≥ 20% relative WER reduction on the noisy 10 dB set and p95 latency for an 8 s clip ≤ 0.8 s. Otherwise keep base.en and report the table. Never raise VRAM use: this stays on CPU.

---

## Phase 4: Endpointing and latency

**4.1 Adaptive end-of-speech.** With Silero active, default `silenceMs` 450 ms (config `endSilenceMs`, replacing the hard-coded 700 in `main.js:187`).

**4.2 Continuation guard** in `controller.finishCapture`: if the transcript has no terminal `.?!` **and** its last word is in a dangling set (`and, but, or, so, because, then, the, a, an, to, of, with, for, like, um, uh, my, your, that, if`), and the utterance is < 20 s, and fewer than 2 extensions were used, reopen `listening` for up to 1.5 s (keep `chunks`), merge any new speech, and re-transcribe the whole audio. If no new speech arrives, go with the original transcript without re-transcribing. Config flag `continuationGuard` (default true after Gate 4). Tests in `voice-controller.test.js` with fake STT/VAD: dangling → extension; complete sentence → no extension; max 2 extensions; user silence → original text used once.

**4.3 Measure** with the Phase 0 trace over ≥ 30 live turns (or the selftest path).

**GATE 4:** p50 `speech_end → first_audio` improved ≥ 20% vs Phase 0 or ≤ 1.5 s, with no increase in clipped sentences (corpus pause set still passes). Else revert the defaults and report.

---

## Phase 5: TTS audit (fix only what the trace proves)

- Surface silent fallback: when `engine('tts')` returns the Windows voice despite `engines.tts === 'piper'`, `logOnce` a warning naming the reason (not installed vs failed). Test it.
- From the trace, measure the inter-sentence gap (`play` end → next `play` start). If p50 > 250 ms, investigate prefetch order in `piper.js` `createStream` (synthesis already runs ahead; look at `play` startup cost in `ctx.mic.play`) and fix the cause. If it is ≤ 250 ms, change nothing.
- Do not swap the TTS model in this plan.

**GATE 5:** report the gap numbers and the fallback behavior.

---

## Phase 6: Hardening and handoff

- Run the full `npm test`, `src/main/selftest.js` and `scripts/selftest-speaking.js`; fix or explain each failure.
- Kill-switch checks: remove each model file in turn (silero, oww, whisper small) and confirm the app still speaks and listens via the fallbacks with a single logged warning each.
- Settings UI exposes: VAD (silero/energy), wake engine, wake threshold, STT model, continuation guard. Tests updated.
- `engines/MODELS.md`: file, source URL, SHA-256, size, license (Silero: MIT; openWakeWord models: check license, the pretrained ones are non-commercial CC BY-NC-SA 4.0, which is fine for personal use, so note it).
- Short `docs/voice-pipeline.md`: architecture diagram, config flags, how to run the bench, how to roll back each phase.
- Final report: table of baseline vs final metrics per phase, anything not verified, and any flags left defaulted to the old behavior.

## Out of scope

Replacing Piper, GPU Whisper, cloud STT/TTS, speaker identification, rewriting the mic capture path, changing the orchestrator.
