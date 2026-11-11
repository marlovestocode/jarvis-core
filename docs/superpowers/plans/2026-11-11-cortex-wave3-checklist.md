# Cortex Wave 3 (looked-up knowledge, timers and reminders) — manual checklist

Things the automated tests and the bench cannot prove. **None of these is verified yet**; tick one only after doing it on the real PC.
Never run `eval/run.js` or anything that loads a model on the GPU while JARVIS is running.

## First start after the update

- [ ] Start JARVIS with timers set from before the update. `%APPDATA%\jarvis-core\timers.json` is gone, `timers.json.imported.bak` is there, and "list my timers" shows the same ones with the same times.
- [ ] A timer that came due while JARVIS was off fires once at start, said as "While I was off, …"; restart again: it does not fire a second time.
- [ ] `self_diagnostics` has a `data stores` line: "in cortex: memory facts, chat summaries, people and things, knowledge, timers; file: …".
- [ ] The `timers` boot stage still reports "N set" (and "M missed while off" when one fired at start).

## Timers and reminders

- [ ] "Set a timer for 2 minutes" → set, fires on time, spoken by the proactive engine as before.
- [ ] "Remind me in 5 minutes to feed Rex" (with Rex a known pet from wave 1) → fires; before it fires, "what do you remember about Rex?" lists the reminder.
- [ ] Cancel a reminder by label → "Cancelled the reminder to …"; it does not fire.
- [ ] Set a reminder, quit JARVIS before it is due, start again after → fired once as missed.
- [ ] "Remind me to change my password tomorrow at 9" → JARVIS says it could not save it (the label looks like a password) and does not claim it is set. Decide whether this refusal is acceptable (see the wave 3 report).

## Looked-up knowledge

- [ ] With the offline library NOT installed (or for a topic it lacks): ask "who was Ada Lovelace?" → looked up online (the turn shows a Wikipedia lookup). Ask it again in a new chat → the answer says it is from memory and how long ago it was fetched, and no online lookup is shown for that turn ("from memory").
- [ ] With the offline library installed: a topic it has is answered from the library and nothing new appears in the cortex for it.
- [ ] Switch online lookups off in Settings, ask a question looked up earlier → answered from memory; for one older than 90 days (or edit the clock): "last known, from <date>".
- [ ] "Search the web for the height of the Eiffel Tower", open one result, then ask about that page again within 3 days → the page answer is from memory (no new page read in the web audit log); the search itself goes online again and its results can be opened.
- [ ] Ask a different question about an article looked up before (e.g. its height after its history) → goes online, not a wrong passage from memory.
- [ ] Read a page or file, then "remind me about it tomorrow" → the reminder is set; in Settings → Memory its source is not "you said it".
- [ ] "Search the web for the latest iPhone price" twice → both go online (current things are never kept).
- [ ] Two sites that disagree on a fact → the answer names both sources (the model’s rule; JARVIS links a conflict on his own only when a lower-trust source writes the same stored slot, which no tool does yet).
- [ ] Weather, news headlines and sports scores still answer live (nothing about them in the cortex: the Memory tab's Connections show no weather or score nodes).
- [ ] The web audit log and the network indicator show no request for a question answered from memory.

## Eval (when the GPU is free and JARVIS is closed)

- [ ] `eval/run.js` with the new questions `t-knowledge-reuse` and `t-web-reuse` (tool pick only; the reuse itself is tested in `test/knowledge-reuse.test.js`).
- [ ] Live: ask "who is X" twice in two chats with the real model; the second answer cites memory and age.
