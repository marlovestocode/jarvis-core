# Cortex Wave 2 (music, playlists, actions, tool history) — manual checklist

Things the automated tests and the bench cannot prove. **None of these is verified yet**; tick one only after doing it on the real PC.
Never run `eval/run.js` or anything that loads a model on the GPU while JARVIS is running.

## First start after the update (the one-time import)

- [ ] Before starting, note the size of `%APPDATA%\jarvis-core\music-plays.jsonl` (lines) and of `actions.log`, and whether `ytm-undo.json` exists.
- [ ] Start JARVIS. The window opens at once (the import must not delay boot). `jarvis.log` gets, within about 10 s for 100k plays:
      `actions: imported N entries from actions.log (…)`, `ytmusic: imported N playlist edits from ytm-undo.json`,
      `music: imported N plays from music-plays.jsonl (M malformed lines skipped)` with N close to the line count.
- [ ] The three files are now `*.imported.bak`; `cortex.db` grew (roughly 0.4 KB per play).
- [ ] Ask "what are my top artists this month?" right after start, during the import: the answer starts "Still importing your older plays (x%)".
      After it finishes, the same question gives the same numbers as before the update.
- [ ] `self_diagnostics` has a `history` line: "imported … this start; N plays, M actions, K tool calls logged".
- [ ] Quit JARVIS during the music import (large file), start again: the import resumes, no plays are counted twice
      (`music_stats` overview play count equals the old line count minus malformed lines).
- [ ] Restart again: no second import (no new "imported" lines).

## Listening and taste

- [ ] Play a real listening session in YouTube Music (5+ songs, let them finish). `music_stats` report recent lists them.
- [ ] Skip a song within 30 s after another one: nothing breaks; `music_stats` skips counts it.
- [ ] "Play songs you think I'd like" / "queue 5 songs I'd like": songs from your own history start or queue, each with a reason
      ("you often play it after …", "you like …", "it is in your … playlist"); none played in the last 24 h.
- [ ] "Play a random song by <artist you play>": a song by that artist from your history; for an artist you never played, the old artist search.
- [ ] `music_stats` report taste lists picks with reasons.

## Playlists

- [ ] Open a playlist by name ("play my gym playlist"): works as before.
- [ ] Add a song to a playlist, then "undo that": the song is removed (journal on the cortex). Restart JARVIS, add again, restart, undo: still works.
- [ ] Rename or delete a playlist on YouTube Music, ask JARVIS to list playlists: the list is current (YouTube is the truth).
- [ ] With the extension disconnected, playlist questions say it is not connected; nothing is lost when it reconnects.

## PC actions and undo

- [ ] "Move the PDFs on my Desktop to Documents", say yes, then "undo that", say yes: the files go back.
- [ ] A move of a file named like `secret plan 2026.pdf`: the move and its undo both work.
- [ ] Restart JARVIS between the move and the undo: the undo still offers that move.

## Tool history and activity

- [ ] "What did you do for me today?": actions with times and results, tool calls with counts, music played.
- [ ] Make a tool fail (e.g. weather with the network off), restart JARVIS, run diagnostics: the failure is still counted ("failed 1 of N (…%) in the last 7 days").
- [ ] "What failed this week?" names the failing tool.
- [ ] After a search for something with a long number or the word "password" in it, `activity_log` shows that arg as `[hidden]`.

## Performance

- [ ] A voice turn during the music import feels as fast as usual (the slices are 50 ms).
- [ ] `node --expose-gc scripts/cortex-bench.js` on this PC with JARVIS closed: every gate passes, including the music import gate.
