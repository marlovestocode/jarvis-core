# Cortex Wave 1 (memory and chats) — manual checklist

Things the automated tests and the bench cannot prove. **None of these is verified yet**; tick one only after doing it on the real PC.
Never run `eval/run.js` or anything that loads a model on the GPU while JARVIS is running (the GPU holds about 5.4 of 8 GB).

## First start after the update

- [ ] Start JARVIS once. `%APPDATA%\jarvis-core\memory.json` is gone, `memory.json.imported.bak` is there, and `jarvis.log` has
      `memory: imported N fact(s) from memory.json (M skipped)` with N = the number of facts you had.
- [ ] Ask "what do you remember about me?" — the same facts as before the update.
- [ ] The boot line `boot memory: ok ...` shows the fact count and the recall mode (keyword or meaning + keyword).
- [ ] `self_diagnostics` (or "run diagnostics") lists a `cortex` line: ok with the embedding model, off without it — never a problem on a healthy PC.
- [ ] Restart JARVIS: no second import (`jarvis.log` has no new "imported" line), facts unchanged.
- [ ] The `ExperimentalWarning: SQLite is an experimental feature` line appears once per start in the console; decide whether to hide it.

## Settings → Memory, by hand

- [ ] The MEMORY section shows: the two switches, the embedding model row, To review, Saved facts (count / 300), Connections, Chat summaries, Export / Import / Delete summaries / Forget everything.
- [ ] Saved facts: search, the All / Always known / When relevant filter, EDIT (Enter saves, Esc cancels), ALWAYS / WHEN RELEVANT, LINKS, DELETE.
- [ ] Each fact has its source line: "you said it · Nov 11", "imported · ...", "from chat <title>", or "from a deleted chat" after you delete that chat.
- [ ] To review: APPROVE, EDIT (approves with your text), REJECT; APPROVE ALL / REJECT ALL when there are two or more. A rejected fact is not proposed again from the same chat.
- [ ] LINKS on a fact about a pet or person shows its entity, and the entity's other facts and chats.
- [ ] Turn "Learn from finished chats" off: no new review items after a chat. Turn "Use past chats in answers" off: `recall_chats` says past-chat memory is off, and no "Relevant from memory" chat lines.
- [ ] Export writes a JSON file where you choose it; Import of that file puts its facts into To review (not straight into memory).
- [ ] Forget everything asks first, then the section is empty (facts, names, summaries).
- [ ] Payload checks: none to do by hand (covered by `test/memory-ipc.test.js`).

## Embedding model (Install button)

- [ ] On a PC without `nomic-embed-text`: the row says "Not installed: recall matches words only" and shows INSTALL.
- [ ] INSTALL shows a native dialog "Download nomic-embed-text (about 270 MB) from Ollama?". Cancel → nothing downloaded (`ollama list` unchanged).
- [ ] Download → after it finishes the row says Installed, `jarvis.log` has `cortex: embedding with ollama:nomic-embed-text@768`, and the "waiting to be indexed" count falls to 0 over the next idle minutes.
- [ ] (Your PC already has the model: the boot line should say "meaning + keyword recall" with no click.)

## Capture (needs a real chat, GPU free of other work)

- [ ] Have a chat of 4+ messages where you state two facts about yourself ("my dog Rex has a vet visit in March", "I live in Abilene"). Switch to a new chat, wait 30 s idle.
      One quiet notification "N new things to review in Memory"; the facts are in To review with "from chat <title>"; a summary is under Chat summaries.
- [ ] A chat where the assistant or a web page says something about you ("you own a yacht") does not propose it.
- [ ] Start typing a question while a capture job runs: the turn answers normally (the job stops and is retried later; `jarvis.log` shows no error).
- [ ] Leave JARVIS idle 10 minutes after a chat: that chat is summarized without switching.
- [ ] Startup sweep: with a few old chats never summarized, a restart summarizes at most 5 of them, newest first, while idle.

## Recall in the turn

- [ ] Ask "how is Rex doing?" after approving the vet fact: the answer uses the vet visit (it came through the Rex entity).
- [ ] Ask "what did we talk about last week about my dog?": the model calls `recall_chats` and answers from it, or says it found nothing.
- [ ] "What do you remember about Rex?" answers at once (fast path, no model call) with the facts and chats.
- [ ] Say "no, that's wrong" right after an answer that used memory: no error; the same question later ranks those items lower.
- [ ] Prompt cache: two text turns in a row with the same profile — `ollama` logs / the turn timing show the cached prompt prefix reused (the system prompt and older messages are byte-identical).

## Voice

- [ ] Voice turn latency with the embedder on CPU while the chat model is loaded: compare `voice-trace.jsonl` time-to-first-token for 10 turns before and after the update (the only turn-path embedding is the 120 ms-capped query vector). Report the medians.
- [ ] "Jarvis, forget everything" clears facts and the review queue but keeps chat summaries.

## Eval (only with JARVIS stopped and the GPU free)

- [ ] `node eval/run.js` — the new tool-choice questions `t-recall-chats`, `t-recall-chats2`, `t-memory-about` pick the right tool. Report the pass rate next to the last run's.
