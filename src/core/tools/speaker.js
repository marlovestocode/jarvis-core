// Speaker recognition: why a turn whose voice is not known to be the owner's is refused (turn.speaker 'unsure' | 'guest').
// One wording for the tool runner, the task runner and plan checks, and skills that refuse on their own (clipboard).
const REASON = {
  unsure: "I can't be sure it's you, so I won't do that by voice. Confirm with the keyboard or the hotkey.",
  guest: 'I only do that for my owner.',
};

// speakerReason(turn) → the reason text (no "Error: "), or null when the turn is the owner's
const speakerReason = turn => REASON[turn?.speaker] || null;

module.exports = { speakerReason };
