// Claim check: a reply that says JARVIS DID something ("I've paused it", "Chrome volume is now 90%",
// "I dimmed the lights") must be backed by a tool that ran and did not fail in the same turn.
// Past chats show a small model confirming actions it never took.
//   unbackedClaim(reply, okTools) → true when the reply claims an action and no tool confirmed anything.
const DONE_VERB = '(?:opened|opening|launched|dimmed|paused|played|started|stopped|set|turned|switched|added|saved|muted|unmuted|skipped|closed|adjusted|restarted|activated|deactivated|toggled|changed|sent|deleted|removed|raised|lowered|increased|decreased|resumed|queued|liked|enabled|disabled)';

const CLAIMS = [
  new RegExp(`\\bI(?:'ve| have|'m| am)?\\s+(?:just\\s+|now\\s+|already\\s+)?${DONE_VERB}\\b`, 'i'),
  new RegExp(`\\b(?:is|are|has been|have been|was|were|has|have) (?:now |successfully )?${DONE_VERB}\\b`, 'i'),
  /\b(?:volume|brightness|playback|music|media) (?:is|are) now\b/i,
  /^\s*(?:done|opening|playing|pausing|stopping|muting|skipping)\b/i,
];
// not a claim: offers, hypotheticals, refusals, questions about the user's own actions
const NOT_CLAIM = /\b(?:I (?:cannot|can't|can not|couldn't|could not|did not|didn't|don't|do not|won't|will not)|if I|would you like|should I|unable to)\b/i;

function unbackedClaim(reply, okTools = 0) {
  if (okTools > 0) return false;
  const text = String(reply || '').trim();
  if (!text) return false;
  // judge sentence by sentence so "I can't open Discord. Playback is now paused" is still caught
  return text.split(/(?<=[.!?])\s+/).some(s => !NOT_CLAIM.test(s) && CLAIMS.some(re => re.test(s)));
}

const UNBACKED_FIX = " Correction: I didn't actually do that. No tool confirmed it.";

module.exports = { unbackedClaim, UNBACKED_FIX };
