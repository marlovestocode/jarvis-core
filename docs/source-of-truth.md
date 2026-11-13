# Who owns what (source of truth)

One owner per piece of data. Everyone else reads it through the owner or keeps a copy that is cleared or rebuilt from it.
Written from the code as of 2026-11-12; a line marked **not enforced** is a rule I could not find a test or a guard for.

| Data | Owner (the only writer) | Copies and readers | Rule when they differ |
|---|---|---|---|
| Settings | `<data>/config.json` via `src/core/config.js` (`ctx.config`, changed only by `ctx.saveConfig` / `settings.applyPatch`) | Settings window and chat UI get a copy from `describe()`; the prompt, tools and voice read `ctx.config` each turn | The file wins; a bad value falls back to the default and is listed by `self_config` |
| Hotkeys, speaking dialect (`config.speech`), units, home city | `config.json` | The prompt is built from them every turn; speech text uses `dialect.resolve(config.speech)` | There is no second copy |
| User's name and "about" | `config.user` (settings window, or "call me …" through the memory fast path) | Prompt `userBlock` | Config wins. **Not enforced:** a saved fact that also contains a name is a second copy; I did not trace whether the extractor can write one |
| Long-term memory: facts, entities, chat summaries, review queue | `<data>/cortex.db` through the cortex verbs only (`src/core/cortex`) | Prompt block built per turn; wallpaper gets ids only | `memory.json` was imported once and renamed; it is never read again |
| Chat transcripts | `<data>/sessions/*.json` (`src/core/session.js`) | UI, memory capture | A deleted chat also removes its summary (`onRemove`) |
| What tools exist, their schemas, hints, risk and "untrusted" flag | The tool definition itself (`src/core/tools`, `src/core/skills/<id>`) | Prompt hints, the capabilities line, the "only ASK first" list (now built from `risk: 'confirm'`), `skills_list` | `test/tool-registry-consistency.test.js` fails when a copy drifts. The `untrusted` flag lives only on the tool; `isUntrustedTool` in `brain/guard.js` reads it (test: `test/untrusted-flags.test.js`) |
| Skill group triggers | The group file (`skills/<id>/index.js`) | `select.js` reads them; `test/fixtures/skill-requests*.json` and `scripts/skill-accuracy.js` measure them | Fix the trigger, not the test table |
| Local service addresses (Ollama, sysmon) and the "this PC only" rule | `src/core/net/services.js` | `providers/ollama.js`, `cortex/embedder.js`, `memory/system.js`, `main.js`, `checks.js`, `skills/system` | One definition (was five) |
| Extension link key | `<data>/link.key` (`media/link-key.js`, made once) | The user pastes it into the extension; it keeps its copy in `chrome.storage.local` | Backend wins: a different key means the handshake fails and the popup says so |
| Link ports and the extension ID | `media/ytmusic-link.js` (`PORTS`) and `media/ytmusic-id.js` (matches the `key` in `extension/manifest.json`) | `extension/background.js` repeats the ports | `test/ext-wiring.test.js` fails if the lists differ |
| Listening history | `<data>/music-plays.jsonl` (`music/log.js`) | The extension's `pending` list is a queue in transit: sent, then cleared | Plays are deduplicated by id on the backend, so a re-send is harmless |
| Extension preferences (keep-playing switch) | `chrome.storage.local` in the browser (`popup.js`) | `keepalive.js` | The backend does not store it; it only hears what was confirmed |
| Extension activity list | `chrome.storage.session` ring of 100 (`background.js`) | Popup | Cleared with the browser session; JARVIS keeps its own log line for each prompt (`youtube prompt: …`) |
| Metrics | `<data>/metrics/YYYY-MM-DD.jsonl` (`core/metrics/store.js`, 90 days) | Dashboard, `analytics_summary` | Raw events win; summaries are recomputed on every request |
| Live process memory | `memwatch` (in memory only) | Sampled into metrics once a minute | n/a |
| Timers | `<data>/timers.json` (`timers/store.js`) | The scheduler arms from it at start | File wins |
| Offline library folder | `config.library.dir` (default `C:\JarvisData\library`, absolute path, set in Settings) | Kiwix reads it through `ctx.getConfig()`; installer takes `-Dir` | The file wins; a relative value falls back to the default and is listed by `self_config` |
