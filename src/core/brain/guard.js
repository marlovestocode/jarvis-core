// Claim check: a reply that says JARVIS DID something ("I've paused it", "Chrome volume is now 90%",
// "I dimmed the lights") must be backed by a tool that ran and did not fail in the same turn.
// Past chats show a small model confirming actions it never took.
//   unbackedClaim(reply, okTools) → true when the reply claims an action and no tool confirmed anything.
const DONE_VERB = '(?:opened|opening|launched|dimmed|paused|played|started|stopped|set|turned|switched|added|saved|muted|unmuted|skipped|closed|adjusted|restarted|activated|deactivated|toggled|changed|sent|deleted|removed|raised|lowered|increased|decreased|resumed|queued|liked|enabled|disabled)';

const CLAIMS = [
  new RegExp(`\\bI(?:'ve| have|'m| am)?\\s+(?:just\\s+|now\\s+|already\\s+)?${DONE_VERB}\\b`, 'i'),
  new RegExp(`\\b(?:is|are|has been|have been|was|were|has|have) (?:now |successfully )?${DONE_VERB}\\b`, 'i'),
  /\b(?:volume|brightness|playback|music|media) (?:is|are) now\b/i,
  /^\s*(?:done|opening|playing|now playing|pausing|stopping|muting|skipping|queued|queueing|queuing|added|adding|resumed|resuming|liked|unmuted|turned|switched)\b/i,
  // "Sure. Queued five." / "Got it. Playing X.": a claim that opens a later sentence
  /(?:^|[.!?]\s+)(?:playing(?!\s+(?:it|them|that|this)\s+again)|queued|added|skipped|queueing|queuing)\b/i,
  // a state read from nowhere: "The media is already paused", "it is still playing" with no tool checking it this turn
  /\b(?:is|are|was|were)\s+(?:already|currently|still|now)\s+(?:paused|playing|muted|stopped|queued|added|open|closed|running)\b/i,
  /^\s*already\s+(?:paused|playing|muted|stopped|queued|added)\b/i,
  // "I'll queue five songs now" said with no tool call is a promise nothing backs
  /\bI(?:'ll| will)\s+(?:go ahead and\s+)?(?:queue|play|add|skip|pause|resume)\b/i,
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

const UNBACKED_FIX = "I haven't actually done that: no tool confirmed it.";

// The reply with every sentence that claims an action taken out, plus one plain line saying nothing was done.
// What is left (an answer, a question) stays. Voice has already spoken the claim, so it only gets the line.
function stripClaims(reply) {
  const kept = String(reply || '').trim().split(/(?<=[.!?])\s+/).filter(s => NOT_CLAIM.test(s) || !CLAIMS.some(re => re.test(s)));
  return [...kept, UNBACKED_FIX].join(' ').trim();
}

// PC actions (src/core/pc/confirm.js). A risky action only runs after the user's own plain "yes" in
// the next turn. That answer is read from the user's text only (the fastPath), never from a tool
// result, page or file. The tools below return text from outside; after one of them runs in a turn,
// no confirm tool may start in that turn (so a page saying "move all files" cannot queue the move).
const UNTRUSTED_TOOLS = new Set(['lookup_knowledge', 'read_article', 'news_headlines', 'get_weather', 'weather_alerts', 'sports_scores', 'find_files', 'list_windows']);
// a confirm tool's result starts with this: the turn ends and the question is the reply, word for word
const NEEDS_OK = 'Needs your OK: ';
const plain = t => String(t || '').toLowerCase().replace(/^\s*(?:(?:hey |ok(?:ay)? )?jarvis[,.!]?\s*)/, '').replace(/[.!,]+/g, ' ').replace(/\s+/g, ' ').trim();
const YES = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'confirm', 'confirmed', 'do it', 'go ahead', 'yes please', 'yes do it', 'ok do it', 'okay do it', 'yes go ahead', 'please do', 'do it now']);
const NO = new Set(['no', 'nope', 'cancel', 'stop', "don't", 'do not', 'never mind', 'nevermind', 'no thanks', 'forget it']);
const isYes = t => YES.has(plain(t));
const isNo = t => NO.has(plain(t));

module.exports = { unbackedClaim, stripClaims, UNBACKED_FIX, isYes, isNo, UNTRUSTED_TOOLS, NEEDS_OK };
