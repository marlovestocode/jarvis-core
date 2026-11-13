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

// A tool can answer "ok" and still say it did nothing ("Could not find that window", "No change"). Such an answer never backs a claim
// that something was done: the reply must report what the tool said, not what the user hoped for.
const SOFT_FAIL = /^\s*(?:could ?n[o']?t|can ?n[o']?t|unable to|no such|not found|nothing (?:was )?(?:changed|done|found|happened|to do)|no change|failed|did ?n[o']?t|was ?n[o']?t|is ?n[o']?t|not (?:connected|available|supported|allowed))\b/i;
const softFail = text => SOFT_FAIL.test(String(text ?? ''));

// Precise figures in a reply (4 or more digits, or a decimal) that appear in nothing the tools returned and nothing the user said.
// A small model rounds, converts and sometimes invents; a figure it cannot trace to a result is the one to check. Years and values
// that are a rounding of a result pass. → the first few offending figures.
function ungroundedFigures(reply, evidence = []) {
  const nums = t => [...String(t ?? '').replace(/(\d),(?=\d{3}(?!\d))/g, '$1').matchAll(/\d+(?:\.\d+)?/g)].map(m => m[0]);
  const have = nums(evidence.join(" "));
  const vals = have.map(Number);
  const bad = [];
  for (const n of nums(reply)) {
    if (n.replace('.', '').length < 4 || /^(?:19|20)\d\d$/.test(n) || have.includes(n)) continue;
    const v = Number(n);
    // a rounding of a result: equal to the reply's own last decimal place, or a round integer ("4800" for 4821) within 1 %
    const dec = (n.split('.')[1] || '').length, round = !n.includes('.') && n.endsWith('0');
    if (vals.some(h => Math.abs(h - v) <= 0.5 * 10 ** -dec + 1e-9 || (round && h !== 0 && Math.abs(h - v) / Math.abs(h) < 0.01))) continue;
    bad.push(n);
  }
  return [...new Set(bad)].slice(0, 3);
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
// The tool definition owns the flag: `untrusted: true` (see tools/registry.js). Unknown names are not untrusted.
const isUntrustedTool = (name, catalog) => catalog?.byName?.get(name)?.tool?.untrusted === true;
// a confirm tool's result starts with this: the turn ends and the question is the reply, word for word
const NEEDS_OK = 'Needs your OK: ';
const plain = t => String(t || '').toLowerCase().replace(/^\s*(?:(?:hey |ok(?:ay)? )?jarvis[,.!]?\s*)/, '').replace(/[.!,]+/g, ' ').replace(/\s+/g, ' ').trim();
const YES = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'confirm', 'confirmed', 'do it', 'go ahead', 'yes please', 'yes do it', 'ok do it', 'okay do it', 'yes go ahead', 'please do', 'do it now']);
const NO = new Set(['no', 'nope', 'cancel', 'stop', "don't", 'do not', 'never mind', 'nevermind', 'no thanks', 'forget it']);
const isYes = t => YES.has(plain(t));
const isNo = t => NO.has(plain(t));

module.exports = { ungroundedFigures, softFail, unbackedClaim, stripClaims, UNBACKED_FIX, isYes, isNo, isUntrustedTool, NEEDS_OK };
