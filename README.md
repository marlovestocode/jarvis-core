# JARVIS Core

A personal, offline AI assistant for one Windows PC. You talk to it by voice ("Jarvis, …") or in a chat window; it answers with a local language model and acts through its own tools: music, timers, files, windows, hardware stats, Wikipedia, weather, news, the web, and more. Nothing about you leaves the PC: the model runs in [Ollama](https://ollama.com) on your GPU, speech runs in local engines, and the few online lookups (weather, news, Wikipedia, web search) send only the question, never personal data.

It is an Electron app with a Node core. The desktop look that goes with it (3D wallpaper, palette, sounds) lives in a separate repo, [jarvis-desktop](https://github.com/marlovestocode/jarvis-desktop).

---

## Contents

- [What it can do](#what-it-can-do)
- [How a turn works](#how-a-turn-works)
- [Requirements](#requirements)
- [Setup](#setup)
- [Running and using it](#running-and-using-it)
- [Configuration](#configuration)
- [Where your data lives](#where-your-data-lives)
- [Project layout](#project-layout)
- [Safety and privacy rules](#safety-and-privacy-rules)
- [Testing and benchmarks](#testing-and-benchmarks)
- [Branches and work in progress](#branches-and-work-in-progress)
- [Further reading](#further-reading)

---

## What it can do

JARVIS's tools are grouped into **skill groups**. Each turn, a small router picks the groups the request needs (usually one or two), so the model only sees the tool definitions it can use. That keeps the prompt short and the tool choice accurate on a small model. A group that is not loaded is still listed to the model, and `more_skills` loads it on demand.

| Group | What it covers |
|---|---|
| `core` | Time, date and JARVIS's own status |
| `media` | Play, pause, skip and volume for whatever is playing on Windows |
| `ytmusic` | YouTube Music: play any song, album, artist or playlist, queue, like, your playlists (add/remove with undo), listening stats, "secret" surprise picks |
| `timers` | Timers, alarms and reminders, spoken when they fire (also after a restart) |
| `knowledge` | Wikipedia (offline library via Kiwix, or online), weather and alerts, news headlines, sports scores |
| `web` | Web search and reading the pages it finds, with an audit log of what was fetched |
| `system` | Live CPU/GPU/RAM/VRAM, temperatures, network and disk |
| `pc` | Open apps, manage windows, lock, sleep, shut down (asks first) |
| `windows` | Window layout, monitors, virtual desktops, hung apps |
| `audio-display` | Output device, brightness, displays, night light |
| `connectivity` | Wi-Fi, Bluetooth, battery, power plan, focus assist |
| `clipboard-capture` | Read/write the clipboard, clipboard history, screenshots |
| `files` | Find, read and inspect files (text, PDF, Word); rename, sort, copy, zip, new folders, all with undo |
| `browser` | Chrome tabs, page text, downloads, history, bookmarks (through the extension; off by default) |
| `math` | Exact arithmetic, units, dates, science constants |
| `memory` | "Remember that…", "forget…", "what do you remember about me" |
| `self` | Self-diagnostics (23 live checks), list of skills, version and settings, recent errors |

Some requests never reach the model at all: confirmations ("yes, do it"), memory commands and common media commands go through a **fast path** that answers in milliseconds.

Voice features: wake word ("Jarvis"), push-to-talk hotkey, voice activity detection, GPU speech-to-text, a JARVIS-style text-to-speech voice, interrupting him while he speaks, and an optional **speaker gate** so that only your enrolled voice can wake him.

## How a turn works

```
 you (voice or chat)
   │  voice: wake word → VAD → Whisper (GPU) → text
   ▼
 orchestrator ──► fast path (confirm / memory / media skills, no model)
   │
   ▼
 router: quick chat (no tools) or tools?  ──► skill-group selection (top 2 groups)
   ▼
 Ollama (local model, streaming) ◄──► tool runner (only the selected groups' tools)
   │                                      │ results from pages/files/clipboard mark the turn "tainted"
   ▼                                      ▼
 claim guard: "I did X" only if a tool really did it this turn
   ▼
 reply → chat window and Piper TTS; events → wallpaper bridge (jarvis-desktop)
```

- **Entry point:** `src/main/main.js` builds one `ctx` object and wires every part to it.
- **Turn flow:** `src/core/orchestrator.js`.
- **Prompt rules:** `src/core/brain/prompt.js`, explained with the real failures behind each rule in [docs/jarvis-prompt-rules.md](docs/jarvis-prompt-rules.md).

## Requirements

- **Windows 10/11** (PC control, speech host and media host are PowerShell/.NET helpers).
- **Node.js 22.13 or newer** for the tests (`npm test`); the app itself runs on Electron 45's bundled Node.
- **Ollama** running locally at `http://127.0.0.1:11434`. JARVIS refuses non-local Ollama hosts.
- **A GPU with about 8 GB of VRAM** for the default setup (Qwen3 8B + GPU Whisper). Smaller models work on less; see [Models](#models).
- **Chrome** only if you want YouTube Music control or the browser skills (one unpacked extension, in `extension/`).
- Optional: [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) and the sysmon widget for CPU temperatures and live hardware stats (set up by jarvis-desktop).

## Setup

### 1. Get the code and dependencies

```bash
git clone https://github.com/marlovestocode/jarvis-core.git
cd jarvis-core
npm install
```

`npm install` brings in Electron and `onnxruntime-node` (for the wake word, VAD and speaker models). There are no other runtime dependencies.

### 2. Models

The main model is Qwen3 8B with JARVIS's settings (8,192-token window, low temperature). Build it once:

```bash
ollama pull qwen3:8b
ollama create jarvis-worker8 -f scripts/Modelfile.jarvis-worker8
```

Then set the model in **Settings → Model** (or `ollama.model` in `config.json`). For a quicker first token on short chit-chat you can also set a smaller **fast model** (for example `qwen3:4b`); the router sends quick turns there. Setting the environment variable `OLLAMA_KV_CACHE_TYPE=q8_0` for Ollama saves VRAM.

### 3. Speech and offline engines (not in git)

Binaries and model files live in `engines/`, which is git-ignored. Put these in place:

| Path in `engines/` | What | Where from |
|---|---|---|
| `whisper/bin/Release/` | whisper.cpp Windows build (CUDA 11.8 for GPU; add `cublas64_11.dll` and `cublasLt64_11.dll` beside it or it silently runs on CPU) | [whisper.cpp releases](https://github.com/ggerganov/whisper.cpp/releases) |
| `whisper/ggml-small.en-q5_1.bin` (GPU), `whisper/ggml-base.en.bin` (CPU) | Whisper models | [ggerganov/whisper.cpp on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp) |
| `piper/bin/piper/` | Piper TTS for Windows | [Piper releases](https://github.com/rhasspy/piper/releases) |
| `piper/en_GB-alan-medium.onnx` (+ `.json`) | Default British voice | [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) |
| `piper/jarvis-high.onnx` / `jarvis-medium.onnx` (+ `.json`) | Optional JARVIS-style voice, used automatically when present (high, then medium, then alan) | [jgkawell/jarvis](https://huggingface.co/jgkawell/jarvis) (only the `.onnx`/`.json`, not the `.ckpt` files) |
| `vad/silero_vad.onnx` | Voice activity detection (v5.1.2) | [snakers4/silero-vad](https://github.com/snakers4/silero-vad) |
| `wake/melspectrogram.onnx`, `wake/embedding_model.onnx`, `wake/hey_jarvis_v0.1.onnx` | Wake word (openWakeWord v0.5.1; the "hey jarvis" model is non-commercial) | [openWakeWord releases](https://github.com/dscripka/openWakeWord/releases) |
| `speaker/wespeaker_en_voxceleb_resnet34_LM.onnx` | Speaker ID for the voice gate | [sherpa-onnx speaker models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models) |
| `kiwix/` | Offline Wikipedia server | run `scripts/install-library.ps1` (downloads kiwix-tools and the Wikipedia ZIM into `C:\JarvisData\library`) |

Every engine is optional: when one is missing JARVIS falls back (Windows speech for STT/TTS/wake, energy VAD, online Wikipedia) and `self_diagnostics` says what is off.

### 4. Chrome extension (optional)

For YouTube Music and the browser skills, load `extension/` as an unpacked extension and pair it with the link key from the tray menu. Step-by-step: [extension/README.md](extension/README.md).

## Running and using it

```bash
npm start
```

JARVIS starts in the tray. By default it also registers itself to start at login (`startAtLogin`).

| Do this | To |
|---|---|
| `Ctrl+Space` | open the chat window |
| `Ctrl+Shift+Space` | talk (push-to-talk) |
| say "Jarvis" | talk hands-free (turn on the wake word in Settings → Voice) |
| say "Jarvis" while he speaks | interrupt him |
| tray → Settings | model, your name and home city, voice, knowledge sources, hotkeys, startup |
| tray → Copy extension link key | pair the Chrome extension |
| tray → Web activity log | see every page and search the web tools made |

Things to try: "what's my GPU temperature", "play something by Daft Punk", "set a timer for 10 minutes", "what's the weather tomorrow", "who was Ada Lovelace", "find my biggest files in Downloads", "remember that I prefer Celsius", "run diagnostics".

### Self-test mode

To run the real app against a throwaway data folder and get a JSON report (used by the audits):

```cmd
set JARVIS_DATA_DIR=%TEMP%\jarvis-test
set JARVIS_SELFTEST_MODE=self
set JARVIS_SELFTEST=%TEMP%\jarvis-report
npm start
```

## Configuration

Settings are in `%APPDATA%\jarvis-core\config.json` and are easiest to change in the Settings window. Every key is validated on load (`src/core/config.js`, `merge()`), and unknown keys are reported by `self_config`. The main ones:

| Key | Default | Meaning |
|---|---|---|
| `ollama.model` / `ollama.fastModel` | `jarvis-worker:latest` / `''` | main model and the quick-chat model |
| `ollama.auto` | `true` | route each turn (quick chat vs tools) and decide on thinking per question |
| `ollama.keepAlive` | `30m` | how long Ollama keeps the model in VRAM |
| `engines` | whisper / piper / whisper | STT, TTS and wake engines (Windows speech is the fallback) |
| `wakeEnabled`, `wakeInterrupt` | `false`, `now` | wake word on/off; "Jarvis" while speaking cuts speech now or after the sentence |
| `sttGpu`, `sttModel` | `true`, `ggml-small.en-q5_1.bin` | Whisper on the GPU and its model |
| `speakerGate`, `speakerThreshold` | `true`, `0.45` | once you enroll your voice, only it wakes JARVIS |
| `hotkeys` | `Control+Space`, `Control+Shift+Space` | chat and talk |
| `online` | all `true` | master switch and per-source switches for weather, news, sports, Wikipedia, web |
| `location` | a default city | home city, coordinates and units for weather and sunrise |
| `news.feeds`, `sports.follow` | a few feeds, none | headline sources and followed teams |
| `music` | — | spoken playlist aliases, cache times, play logging (`logPlays`) |
| `browser.enabled` | `false` | Chrome browser skills |
| `proactive` | on, quiet 22:00–07:00 | spoken reminders and notices, with quiet hours and a chime |

## Where your data lives

Everything is in `%APPDATA%\jarvis-core` (or `JARVIS_DATA_DIR`). Nothing is uploaded anywhere.

| File | Contents |
|---|---|
| `config.json` | your settings |
| `history/<id>.json` | chat transcripts (newest 200 kept) |
| `memory.json` | facts you asked JARVIS to remember |
| `timers.json` | pending timers, alarms and reminders |
| `music-plays.jsonl` | your listening log (turn off with `music.logPlays`) |
| `actions.log`, `ytm-undo.json` | PC file actions and playlist edits, for undo |
| `voiceprint.json` | your enrolled voice (speaker gate) |
| `link.key` | the secret the Chrome extension pairs with |
| `web-activity.jsonl` | every web search and page fetch (human audit file) |
| `cache/` | short-lived weather, news, scores and HTTP bodies |
| `jarvis.log` | app log (rotates at 512 KB) |

## Project layout

```
src/
  main/            Electron main process: main.js (wiring), ipc.js, tray, hotkeys, windows, startup, self-checks
  ui/              chat, settings and mic windows (plain HTML/CSS/JS, no framework)
  core/
    orchestrator.js   the turn loop: fast path → router → model ⇄ tools → guard → reply
    brain/            prompt, router, claim guard, math/units/dates helpers
    providers/        Ollama provider (local only), null provider
    skills/<group>/   one folder per skill group; ORDER in skills/index.js
    tools/            tool bodies the groups expose (each with risk, untrusted and needsClean flags)
    voice/            controller, Whisper, Piper, Silero VAD, wake word, speaker ID, Windows speech fallback
    knowledge/        Kiwix, online Wikipedia, weather, news, sports, passage ranking
    web/              web search (DuckDuckGo HTML), page reader, audit log
    net/              fetch policy: allowlist, public-IP checks, cache
    media/            Windows media control, YouTube Music link, playlists
    music/            listening log and stats
    pc/               PC control host (PowerShell), confirm-and-undo, action log
    timers/           parser, store, scheduler
    proactive/        spoken notices and quiet hours
    memory/           remember/forget store and fast path
    self/             diagnostics
    bridge.js         event stream for the wallpaper (127.0.0.1:47801)
    memwatch.js       memory budget watcher
extension/         Chrome extension (YouTube Music + browser commands)
scripts/           Modelfile, offline library installer, benchmarks, self-test helpers
eval/              live-model evaluation (questions and runner)
docs/              specs, plans, audits and the prompt rules
test/              Node test runner suites
```

Local ports, all bound to `127.0.0.1`: Ollama `11434`, wallpaper bridge `47801–47806`, extension link `47830–47832`, sysmon bridge `47800` (read), LibreHardwareMonitor `8085` (read).

## Safety and privacy rules

These are enforced in code, not only in the prompt:

- **Local only.** The Ollama host must be local. Online sources go through one fetch policy with an allowlist, a master switch, and "never anything personal in a query".
- **No invented actions.** A reply that claims an action ("I've opened…") with no successful tool behind it in that turn is corrected ("Correction: I didn't actually do that.") and the saved message is fixed.
- **Outside text is data, not instructions.** Tools that return text from pages, files or the clipboard are `untrusted`. Such a turn is *tainted*: it cannot start a `risk: 'confirm'` tool, cannot write to memory, and cannot write the clipboard.
- **Risky actions ask first.** Shutdown, file moves and similar tools need your own spoken or typed "yes"; file and playlist changes are journaled and can be undone.
- **No secrets stored.** Memory refuses anything that looks like a password, key or card number.
- **Budgets.** Every long-lived part reports its memory use; the memory watcher trims caches under pressure, and `self_diagnostics` shows the numbers.

## Testing and benchmarks

```bash
npm test                                     # about 1,000 tests, ~10 s, no GPU or network needed
node --expose-gc scripts/mem-bench.js        # memory use of the long-lived parts
node scripts/selftest-latency.js             # voice latency self-test
node eval/run.js                             # live-model eval (loads the model on the GPU: do not run while JARVIS is running)
```

Tests use fakes for Ollama, the network, the PC host and ONNX models (`test/helpers/`), so they run anywhere.

## Branches and work in progress

| Branch | State |
|---|---|
| `main` | an earlier stable point |
| `fix/router-tool-reliability` | the newest finished work: web search, voice polish, secret music picks, router and tool-loop hardening |
| `feat/cortex` | **in progress:** the *cortex*, one local SQLite "brain" (nodes, weighted edges, provenance, embeddings, spreading-activation recall) that becomes the source of truth for memory, music, actions, knowledge and timers. Core engine done and benchmarked; memory on the cortex is next |
| `feat/*`, `perf/*` | the feature branches each stage was built on |

The cortex design is in `docs/specs/2026-11-11-cortex-*.md` and the plans in `docs/superpowers/plans/`.

## Further reading

- [docs/jarvis-prompt-rules.md](docs/jarvis-prompt-rules.md): every prompt rule and the real failure it fixes
- [docs/audit-2026-11-10.md](docs/audit-2026-11-10.md): how JARVIS is wired, what was checked, open findings
- [docs/specs/](docs/specs/) and [docs/superpowers/plans/](docs/superpowers/plans/): design specs and implementation plans for each stage
- [extension/README.md](extension/README.md): installing and pairing the Chrome extension
