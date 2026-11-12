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
const REPEAT = /\b(again|undo|redo|same|another one|one more|the other one)\b/i;
const IMPERATIVE_PRONOUN = /^(do|play|skip|open|close|save|move|delete|put|turn|set|cancel|stop|repeat|replay|send|try|pause|resume|undo)\b.*\b(it|that|this)(?![\w'’])/i;
const QUESTION = /^(who|whom|whose|what|when|where|why|which|how|is|are|does|was|were)\b/i;
const CHAT = /^(thanks|thank you|thx|ok|okay|cool|nice|great|awesome|perfect|bye|goodbye|good (morning|afternoon|evening|night)|hi|hello|hey|no worries|never ?mind|sure)\b/i;
const NEEDS_PLAYING = new Set(['pause', 'skip', 'next', 'previous', 'back', 'louder', 'quieter', 'mute']);
const NEEDS_PAUSED = new Set(['play', 'resume', 'unmute']);

function resolveFollowUp(text, snap) {
  try {
    if (typeof text !== 'string' || !snap || typeof snap !== 'object') return null;
    const raw = text.trim();
    if (!raw) return null;

    if (snap.confirm && (isYes(raw) || isNo(raw))) return { kind: 'confirm' };

    if (raw.split(/\s+/).length <= 6 && !raw.endsWith('?') && !QUESTION.test(raw) && !CHAT.test(raw)
        && (REPEAT.test(raw) || IMPERATIVE_PRONOUN.test(raw))) {
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
