# Humanized voice: design (small change)

## Intent
Jarvis sounds like a robot butler: stiff formal dialect, wordy replies, and canned template replies (e.g. the queue readout "Next 12: 1. X by Scrim (2:37); 2. ...") that bypass the model entirely. The owner wants him concise, human in how he speaks numbers/dates/lists, with a slight robotic edge (precise, deadpan, dry), not a butler and not chatty.

## Goals
- New default dialect `human-jarvis` in `src/core/voice/dialect.js` (existing presets stay selectable): shorter replies, fragments allowed, human mannerisms ("so", "right", "hm", "about", "just"), dry deadpan, varied confirmations, no repetition.
- Spoken-number/date style in `articulate()` (`src/core/voice/speech-text.js`): "quarter past three", "half past", weekday/"tomorrow" over full dates, "about twenty degrees", no spelled "P M" where a natural form exists; applied to whatever model wrote the text.
- A shared voice-formatting helper for structured data (lists, durations, totals) used by canned replies. Voice-mode queue readout: no index numbers, no "(2:37)", artist said once when shared, first few titles then "N more after that", rounded total ("about half an hour"). Typed chat keeps the full numbered list.
- Common canned `say(...)` replies in voice mode get a few variants each, picked without immediate repeats.

## Non-goals
- No model call for canned replies (latency, number risk). Typed chat output format unchanged. No TTS engine change. No financial code touched.

## Anti-goals
- Chatty, goofy or sycophantic; any wrong number or title in a readout; mannerisms firing on errors, refusals or when the user is stressed.

## Approaches
1. Prompt-only: leaves canned replies robotic. Rejected.
2. **Chosen:** dialect + spoken-style layer + helper + variants.
3. Model rephrases everything: slow, risks wrong figures. Rejected.

## Constraints
- Golden/route/voice tests may need updating; exact figures and titles must survive (round only durations/totals in voice). Mannerism prompt text must stay compact for small models.

## Left to the builder
Variant wording, the exact count of titles read before "N more", which canned replies get variants (start with media/queue/confirmations), test updates.
