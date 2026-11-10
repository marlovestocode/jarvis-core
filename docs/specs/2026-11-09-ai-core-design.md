# JARVIS AI Core — Design Spec

Date: 2026-11-09 · Status: draft for review

## 1. Goal

Give the JARVIS desktop a working AI core: a chat window and a voice loop that
feel modern, fast and easy, plus a wallpaper orb that visibly reacts to what the
model is doing.

**No model is chosen.** Everything talks to a `ModelProvider` interface. The
only provider shipped is `NullProvider`, which replies that no model is set.
Picking a model later means adding one adapter file and selecting it in
settings.

### Decisions made

| Topic | Decision |
|---|---|
| Where it runs | New Electron app `Projects/Apps/jarvis-core` (separate from sysmon-widget) |
| Voice start | Hotkey always works; wake word "Jarvis" can be toggled on |
| Privacy | Local only. Nothing leaves the PC. Cloud providers are out of scope |
| Model | None. Interface + `NullProvider` only |

### Why a separate app

Wallpaper Engine web wallpapers receive mouse input only: no keyboard focus and
no microphone. The chat box and voice need their own window and process.

### Out of scope

- Choosing or bundling any language model, STT model or TTS model.
- Cloud providers of any kind.
- Long-term memory beyond saved chat history.
- Installer / auto-start (reuse jarvis-desktop's startup scripts later).

## 2. Architecture

One Electron app. The brain (`src/core/`) is plain Node with no Electron
imports, so it is tested with `node --test`.

```
jarvis-core/
  src/core/                 brain, no Electron
    bus.js                  typed event emitter (see §5)
    session.js              chat history: load/save/list/title
    orchestrator.js         turn flow: input → provider → tools → reply → speak
    config.js               settings load/save with defaults + validation
    bridge.js               HTTP/SSE on 127.0.0.1:47801 for the wallpaper (plain Node, testable)
    providers/
      provider.js           ModelProvider interface + registry
      null-provider.js      shipped default: "No model set"
    voice/
      engines.js            SttEngine, TtsEngine, WakeEngine interfaces + registry
      vad.js                energy-based voice activity detection (no model)
      windows-speech.js     starter engines via Windows built-in speech (PowerShell host)
    tools/
      registry.js           tool definitions + runner
      time.js               current time/date
      sysmon.js             reads sysmon bridge 127.0.0.1:47800
      media.js              POST sysmon /media/<key>
  src/main/                 Electron shell
    main.js                 app lifecycle, single instance
    tray.js                 tray icon + menu
    hotkeys.js              global shortcuts
    windows.js              chat overlay + settings window
    ipc.js                  core ↔ renderer bridge (contextIsolation, preload)
  src/ui/                   renderer (chat + settings), vanilla JS + CSS
    chat.html / chat.js / chat.css
    settings.html / settings.js
    orb-mini.js             small orb in the chat header (same event stream)
  test/                     node --test, FakeProvider lives here only
  docs/specs/
```

Wallpaper changes live in `jarvis-desktop/wallpaper/` (orb lattice + event
client), deployed with the existing `apply/deploy-wallpaper.ps1`.

## 3. Interfaces

### ModelProvider

```js
// Every provider implements this. Nothing else in the app knows which model runs.
{
  id: 'null',
  label: 'No model',
  capabilities: { tools: false, logprobs: false, reasoning: false },
  async status() → { ready: boolean, detail: string, contextMax?: number },
  // Async iterator of chunks. Must stop promptly when signal aborts.
  async *chat({ messages, tools, signal }) → yields
    { type: 'token', text, prob?, alts?: [{ text, prob }] }
    { type: 'reasoning', text }
    { type: 'tool_call', id, name, args }
    { type: 'done', usage?: { promptTokens, completionTokens } }
}
```

`NullProvider` yields one fixed message as tokens, then `done`, and reports
`status().ready = false`.

### Voice engines

```js
SttEngine  { id, label, async status(), async transcribe(pcm16, sampleRate, signal) → text }
TtsEngine  { id, label, async status(), speak(text, { rate, signal }) → { levels: AsyncIterable<number>, done: Promise } }
WakeEngine { id, label, async status(), start(onWake), stop() }
```

Starter engines (Windows built-in speech, not AI models, replaceable):
- TTS: `System.Speech.Synthesis` via a long-lived PowerShell host process.
- Wake: `System.Speech.Recognition` with a one-word grammar "Jarvis".
- STT: `System.Speech.Recognition` dictation. Low accuracy; placeholder until a
  real engine is chosen.

The PowerShell host is one process speaking line-delimited JSON over stdio, so
engines start once, not per utterance.

### Tools

```js
{ name, description, params: JSONSchema, async run(args, ctx) → string }
```

Shipped: `get_time`, `get_system_stats` (sysmon), `media_control`
(play/pause/next/prev/volume). Tools are only offered to providers whose
`capabilities.tools` is true.

## 4. Flows

### Chat turn

1. User sends text (window, or STT result).
2. Orchestrator appends to session, emits `state: thinking`.
3. Streams provider chunks; each `token` → UI + bus.
4. `tool_call` → emit `tool {phase:start}`, run tool, emit `tool {phase:end, ok}`,
   append result, continue the provider loop (max 5 tool rounds per turn).
5. `done` → save session, emit `context`, then `state: speaking` if the turn
   came from voice, else `idle`.

Stop button / `Esc` aborts via `AbortController`. Partial reply is kept and
marked `stopped`.

### Voice turn

```
wake "Jarvis"  or  Ctrl+Shift+Space
  → state listening; mic levels → bus
  → VAD: 0.8 s silence ends capture (max 30 s)
  → STT → text shown in chat → chat turn (above)
  → TTS speaks reply; levels → bus
  → user speech or Esc during speaking = barge-in: stop TTS, start listening
```

Tap to talk (Electron global shortcuts give no key-up event). Mic capture runs
in a hidden renderer via `getUserMedia`, PCM sent to main over IPC.

## 5. Event bus and wallpaper stream

`GET http://127.0.0.1:47801/ai/stream` (SSE). Same host/Origin rules as the
sysmon bridge (`okHost`, `okOrigin`). `GET /ai/hello` returns
`{ app: 'jarvis-core', version }` for port discovery. `POST /ai/open` opens the
chat window; `POST /ai/open?mode=voice` also starts listening (both used by the
orb click on the wallpaper).

| Event | Payload |
|---|---|
| `state` | `{ state: 'idle' \| 'listening' \| 'thinking' \| 'speaking' \| 'error', detail? }` |
| `token` | `{ text, prob?, alts? }` |
| `reasoning` | `{ chars }` (length only, not content) |
| `tool` | `{ id, name, phase: 'start' \| 'end', ok? }` |
| `context` | `{ used, max }` |
| `level` | `{ source: 'mic' \| 'tts', rms }` at ≤ 30 Hz |
| `wake` | `{}` |
| `provider` | `{ id, label, ready }` |

Token text is sent so the orb can size sparks; it is local-only traffic.

## 6. Chat window

- `Ctrl+Space` toggles a frameless glass panel, centered low; `Esc` hides it.
  Uses JARVIS palette tokens (copied from `jarvis-desktop/palette`).
- Streaming replies, markdown, code blocks with copy button.
- Left rail: saved chats, auto-titled from the first message, search box.
- Header: mini orb + chip with provider state (`NO MODEL SET` today) that opens
  settings.
- Input: multiline, Enter sends, Shift+Enter newline, mic button with live
  waveform, stop button while streaming.
- Slash commands: `/new`, `/clear`, `/voice`, `/settings`.
- Settings window: provider, STT/TTS/wake engine, mic device, voice rate,
  wake on/off, hotkeys.

## 7. Orb: neural lattice

Lives in the wallpaper's three.js scene around the existing core, plus a
smaller copy in the chat header. It draws only real events from §5; no
invented activity.

| Signal | Visual |
|---|---|
| idle | lattice breathes slowly, faint drifting sparks |
| `token` | a spark fires from core outward along a lattice path; rate drives brightness |
| `token.prob` / `alts` (if provided) | low prob = path splits; alts drawn as faint ghost branches |
| `reasoning` | inner core swirl, sparks loop back inward |
| `tool` start/end | lattice grows a limb to a labeled node (SYSMON, MEDIA, TIME), pulses, retracts; red if `ok:false` |
| `context` | outer shell fills with use; amber above 80 % |
| `listening` + mic `level` | lattice ripples with voice, leans toward screen bottom |
| `speaking` + tts `level` | core pulses with speech |
| `wake` | short flare, rings turn to face viewer |
| `error` | red flicker, then settle |
| cursor | core "eye" tracks pointer (existing parallax input) |

Click on the orb: existing detail card plus a "Talk" / "Open chat" action
calling `POST /ai/open?mode=voice` / `POST /ai/open`. The existing sysmon AI-runtime labels stay.

Budget: lattice ≤ 400 nodes, ≤ 64 live sparks, must hold the wallpaper's
configured FPS (default 24) on the current GPU.

## 8. Errors

| Case | Behavior |
|---|---|
| No model | NullProvider reply + "Open settings" button; chip `NO MODEL` |
| Provider error / 60 s with no chunk | end turn, keep partial, show Retry, `state:error` |
| Mic missing or denied | mic button disabled with reason; chat unaffected |
| Speech engine fails | fall back to text; log once |
| Wallpaper not running | no SSE listener; app unaffected |
| Corrupt history file | move to `history/broken/`, start fresh |
| Tool throws | tool event `ok:false`; error text returned to provider; turn continues |
| Port 47801 busy | try 47802–47806; the wallpaper probes the same range (`GET /ai/hello`) since it cannot read files |

Data lives in `%APPDATA%/jarvis-core/` (`config.json`, `history/*.json`).

## 9. Testing

- `node --test test/` covers `src/core/` with no Electron:
  orchestrator (turn, abort, timeout, tool loop cap), session (save/load,
  corrupt file), config defaults, bus → SSE serialization, VAD on fixture PCM.
- `FakeProvider` (tests only) streams scripted tokens, alts and a tool call.
- Wallpaper: `?demo=ai-live` plays a scripted event sequence; checked by
  browser screenshot at 1920×1080.
- Manual on the PC: hotkeys, wake word, barge-in, tray, orb reaction.

## 10. Build order

1. Core: bus, config, session, provider interface, NullProvider, orchestrator, tests.
2. Electron shell: tray, hotkeys, chat window, IPC.
3. Bridge + wallpaper event client + neural lattice.
4. Voice: mic capture, VAD, PowerShell speech host, voice turn, barge-in.
5. Tools: time, sysmon stats, media.
6. Settings window.
