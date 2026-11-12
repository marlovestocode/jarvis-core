'use strict';
// Follow-up resolver: pure function mapping a short utterance + a live-state
// Snapshot to a follow-up intent, or null. No I/O, never throws.
//   resolveFollowUp(text, snap) ->
//     null | { kind:'confirm' } | { kind:'continue', groups:string[] }
//          | { kind:'media', action:string }
// Rules, first match wins: (1) pending confirm + bare yes/no; (2) <=6-word
// repeat word or imperative+pronoun (not a question/chat), a tool run and groups.at
// both within FOLLOWUP_MS, and known groups;
// (3) bare media command matching current playback state; (4) null.
const { isYes, isNo } = require('../brain/guard');

const FOLLOWUP_MS = 3 * 60 * 1000;
// Closed set of whole-utterance shapes (anchored); anything else is not a follow-up.
const SHAPES = [
  /^(do|try|play|run|say|send|make)\s+(it|that|this)\s+(again|once more|the same way|too)$/,
  /^(again|once more|one more time|another one|one more|the other one|the same|same again|same as before|do the same|do the same for the other one|undo|undo that|undo it|redo|redo that|redo it|revert that|put it back|put it back the way it was)$/,
  /^(skip|pause|stop|cancel|repeat|replay|resume|reverse)\s+(it|that|this)$/,
];
const QUESTION = /^(who|whom|whose|what|when|where|why|which|how|is|are|does|was|were|did|do you|can|could|would|will|should|have|you)\b/;
const CHAT = /^(thanks|thank you|thx|ok|okay|cool|nice|great|awesome|perfect|bye|goodbye|good (morning|afternoon|evening|night)|hi|hello|hey|no worries|never ?mind|sure)\b/;
const NEEDS_PLAYING = new Set(['pause', 'skip', 'next', 'previous', 'back', 'louder', 'quieter', 'mute']);
const NEEDS_PAUSED = new Set(['play', 'resume', 'unmute']);

function resolveFollowUp(text, snap) {
  try {
    if (typeof text !== 'string' || !snap || typeof snap !== 'object') return null;
    const raw = text.trim();
    if (!raw) return null;

    if (snap.confirm && (isYes(raw) || isNo(raw))) return { kind: 'confirm' };

    let norm = raw.toLowerCase().replace(/[.!\s]+$/, '');
    for (let m; (m = /^(please|ok|okay|and|now)\b[,\s]*/.exec(norm)); ) norm = norm.slice(m[0].length);
    if (raw.split(/\s+/).length <= 6 && !raw.endsWith('?') && !QUESTION.test(norm) && !CHAT.test(norm)
        && SHAPES.some(re => re.test(norm))) {
      const tools = Array.isArray(snap.tools) ? snap.tools : [];
      const recent = tools.some(r => r && typeof r.t === 'number' && snap.t - r.t <= FOLLOWUP_MS);
      const g = snap.groups;
      const list = g && Array.isArray(g.list) ? g.list : [];
      const fresh = g && typeof g.at === 'number' && snap.t - g.at <= FOLLOWUP_MS;
      if (recent && fresh && list.length) return { kind: 'continue', groups: list.slice() };
    }

    const word = raw.toLowerCase().replace(/[\s.!?,;:]+$/, '');
    if (snap.media) {
      if (NEEDS_PLAYING.has(word) && snap.media.playing === true) return { kind: 'media', action: word };
      if (NEEDS_PAUSED.has(word) && snap.media.playing === false) return { kind: 'media', action: word };
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = { resolveFollowUp, FOLLOWUP_MS };
