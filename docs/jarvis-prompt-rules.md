# JARVIS prompt rules and checks (from the saved chats, 2026-11-10)

Source: 7 saved sessions, 235 user messages, `jarvis.log`, `voice-trace.jsonl`. Each rule below answers a real failure.
The rules live in `src/core/brain/prompt.js` (`RULES`, `BRIEF_RULES`, `userBlock`, capabilities line); the code checks are named per row.

## The prompt (what the model is told, every turn)

**Who it talks to** (`userBlock`): name, owner of this PC, home city and units, followed teams, voice enrolled, the user's own "about" text, saved memory.
Never invents more; says "you haven't told me" for the rest.

**Capabilities right now** (live, built in `main.js capsLine`): wake word on/off, owner voice enrolled/gate, YouTube Music extension connected or not, listening log, STT engine, saved memory, and one line listing **every skill group** with its label (`skills.capsLine`: media, ytmusic, timers, knowledge, system, pc, math, memory, windows, audio-display, connectivity, clipboard-capture, files, browser with its state off / not connected / connected).

**Tools per turn.** The model is only given the tools of the groups the request needs (`selectGroups`: trigger scoring, top 2 groups, +1 for a group used the turn before; no match = core + knowledge; quick chat = no tools). `more_skills({ group })` loads another group for the rest of the turn, and calling a tool of an unloaded group loads it automatically; both share a cap of 2 extra groups per turn and never skip `risk: 'confirm'` or the tainted-turn refusal. Rule 5 still holds: a group that is not loaded is still listed in Capabilities, so it is never "not available".

**Rules**
1. **Actions.** You act only through tools. Say you opened, played, paused, set, added, turned on or changed something only after a tool result in this turn confirms it. No control of lights, appliances, brightness, displays or other apps beyond your tools. If a tool failed or is missing, say exactly that.
2. **Hearing.** Speech is transcribed and can be wrong. A fragment, nonsense, or something that fits nothing the user ever asked: do not invent a meaning, story or task. Say you did not catch it and ask them to repeat. Never act on a doubtful transcript. Prefer the user's own playlists, artists, teams and home area for doubtful words.
3. **Titles are not requests.** Artist, band, song and playlist names can look violent or offensive ($uicideboy$, SUICIDE TIMING). Play them normally; never refuse, warn or lecture because of a title. Raise safety only when the user says they intend to hurt themselves or someone.
4. **Facts.** For any specific fact (people, places, events, shows, characters, counts, lists, dates) call `lookup_knowledge` first and answer only from it. Nothing found: say so; do not fill from memory. With no lookup tool: say you cannot verify it.
5. **Abilities.** Before saying you cannot or do not have something, check the Capabilities line and your tools. Never deny a listed capability. "Not connected" is said once, and the tool is called again next time because it may be fixed.
6. **Identity.** You are J.A.R.V.I.S.; the user is someone else. Never call the user J.A.R.V.I.S.

Quick chat (no tools) gets a compressed version: never say you did anything, titles are not requests, fragments get "did not catch it", never deny a listed capability.

## Failure to fix map

| Failure in the chats | Fix | Where |
|---|---|---|
| "I've dimmed the lights", "Opening Discord", "Chrome volume is now at 90%" with no tool | Prompt rule 1 **and** a claim guard: a reply that claims an action with no successful tool that turn gets "Correction: I didn't actually do that." and the saved message is fixed | `brain/guard.js`, `orchestrator.js` |
| Noise became sentences ("Time to be clearly never more", "Logos is sending twice the amount of product") | Whisper `avg_logprob` gate (mean below -1.0 is dropped and logged); prompt rule 2 | `voice/whisper.js` |
| "suicide timing" heard as "Play My Part by Timing" | Your playlist names, team names and your name are added to the Whisper vocabulary prompt on every phrase | `stt-prompt.js withTerms`, `ytplaylists.titles()`, `main.js` |
| Self-harm refusal on $uicideboy$, "illegal activities" on "call black" | Prompt rule 3 | `prompt.js` |
| Invented answers for "tell me about...", "how many...", "did...", "which..." | Router now sends these to the tool tier; prompt rule 4 | `brain/router.js` |
| "I have no wake word", "I can't do math", "can't adjust volume", "can't recognise your voice" | Live capabilities line and rule 5 | `main.js capsLine`, `prompt.js` |
| "Extension not connected" after it connected | Capabilities line shows live link state; rule 5 says re-call the tool | `prompt.js` |
| Calls to `ytm_music`, `get_stock_data` that do not exist | Known wrong names map to the real tool (each tool owns its `aliases`); unknown names return the list of tools that exist | `skills/*/index.js`, `tools/registry.js` |
| 40+ tool definitions on every deep turn (slow prompt, wrong tool picked) | Skill groups: only the groups the request needs are offered; `more_skills` and auto-load recover a wrong pick; the capabilities line lists all groups (rule 5) | `skills/select.js`, `tools/registry.js turn()`, `orchestrator.js` |
| Text read from a page, file or the clipboard steering a risky action | Tools that return outside text are `untrusted`: the turn is tainted, so no `confirm` tool can start (also through auto-load); clipboard writes are refused in a tainted turn; page, file and clipboard text is returned quoted | `tools/registry.js`, `brain/guard.js`, `tools/browser.js`, `tools/files.js`, `skills/clipboard-capture` |
| Replies calling the user "J.A.R.V.I.S." | Rule 6 and the name block | `prompt.js` |

## Already fixed in newer code (the old chats pre-date it)

- Weather asked with no tool ("no real-time access"): `LIVE` routing and weather tools exist now.
- Play/pause confusion: `media/service.js` reads state first, so pause when paused answers "Already paused", and volume results say "Verified".

## Not done yet

- **Latency.** Time to first token has a median of 3.0 s and p95 of 10.3 s; whole turns median 10.4 s, p95 21.2 s. A filler sound after about 3 s is not built.
- **False wakes.** 190 wake events against about 93 voice turns. The speaker gate cuts this once you enroll; no other check yet.
- **"Didn't catch that" aloud.** A dropped low-confidence transcript is logged and silent; JARVIS does not say it.
- **Music result vs query.** No similarity check that asks before playing a loose match.
- **Threshold tuning.** The -1.0 log-probability gate was set from synthetic clips; review `jarvis.log` for "stt dropped" lines after a few days.
