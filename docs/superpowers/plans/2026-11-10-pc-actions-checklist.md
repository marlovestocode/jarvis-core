# PC Actions: manual checklist

Things only a person at the PC can check. Start JARVIS normally (`npm start`), voice on.

## Timers and proactive speech
- [ ] "Jarvis, set a timer for one minute" → reply says the end time. After a minute: chime, spoken "Your timer is done.", a Windows toast, and the line in the chat history.
- [ ] "Set an alarm for 7" in the evening → reply says "7:00 AM tomorrow".
- [ ] "Remind me to stretch in 2 minutes" → spoken "Reminder: stretch."
- [ ] Start talking to JARVIS just before a timer is due → it waits, then speaks after your turn ends.
- [ ] While it speaks the alert, say "Jarvis, stop" → speech stops and is not repeated (the toast stays).
- [ ] Set a 2-minute timer, quit JARVIS from the tray, wait 3 minutes, start it → "While I was off, your timer finished." once. Restart again → not repeated.
- [ ] Settings: set quiet hours to cover now → next timer gives a toast only, no sound. Same with Do not disturb on.
- [ ] "List my timers" / "cancel the pasta timer" / "cancel all timers".

## Apps and windows
- [ ] "Open Spotify" (or any Start menu app) → it opens and the reply says "Opened Spotify." only after a window shows.
- [ ] "Open cmd.exe /c dir" → refused, nothing starts.
- [ ] "Close Notepad" with an unsaved file → asks "Close Notepad. Say yes to confirm." → "yes" → Notepad shows its save prompt → JARVIS asks to force close → "no" → Notepad stays open.
- [ ] "Switch to Chrome" → Chrome comes to the front.

## Files (by voice)
- [ ] "Find my PDFs in Downloads" → at most 10 paths, nothing changed.
- [ ] "Move the PDFs from Downloads to Documents/Sorted" → JARVIS asks; say something else ("what time is it") → nothing moved. Ask again → "yes" → files moved, existing names kept as "name (2).pdf".
- [ ] "Undo that" → asks → "yes" → files back in Downloads.
- [ ] "Delete old.txt from my Desktop" → asks → "yes" → the file is in the Recycle Bin and can be restored.
- [ ] Recycle a folder bigger than your Recycle Bin allows (or on a drive with the bin off) → Windows itself asks before deleting for good; say No there → JARVIS reports it did not work, folder still there.
- [ ] Ask to move files, then press Esc / say "Jarvis, stop" before the question is spoken → a later "yes" does nothing.
- [ ] Set an alarm, sleep the PC past it, wake it → "While I was off, your … alarm went off", not "It's 7:00".
- [ ] Wait more than 60 s after a question, then say "yes" → nothing happens.
- [ ] Open `%APPDATA%\jarvis-core\actions.log` → one line per action that ran.

## Power
- [ ] "Set the volume to 30" → Windows volume is 30%.
- [ ] "Lock the PC" → lock screen.
- [ ] "Shut down" → asks → "no" → nothing happens.
