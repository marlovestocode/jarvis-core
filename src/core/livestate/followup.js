'use strict';
// Follow-up resolver: pure function mapping a short utterance + a live-state
// Snapshot to a follow-up intent, or null. No I/O, never throws.
//   resolveFollowUp(text, snap) ->
//     null | { kind:'confirm' } | { kind:'continue', groups:string[] }
//          | { kind:'media', action:string }
// Rules, first match wins: (1) pending confirm + bare yes/no; (2) <=6-word
// pronoun/repeat phrase, a tool run within FOLLOWUP_MS, and known groups;
// (3) bare media command matching current playback state; (4) null.
const { isYes, isNo } = require('../brain/guard');

const FOLLOWUP_MS = 3 * 60 * 1000;
const PRONOUN = /\b(it|that|this|again|undo|same|the other one|another one|one more)\b/i;
const NEEDS_PLAYING = new Set(['pause', 'skip', 'next', 'previous', 'back', 'louder', 'quieter', 'mute']);
const NEEDS_PAUSED = new Set(['play', 'resume', 'unmute']);

function resolveFollowUp(text, snap) {
  try {
    if (typeof text !== 'string' || !snap || typeof snap !== 'object') return null;
    const raw = text.trim();
    if (!raw) return null;

    if (snap.confirm && (isYes(raw) || isNo(raw))) return { kind: 'confirm' };

    if (raw.split(/\s+/).length <= 6 && PRONOUN.test(raw)) {
      const tools = Array.isArray(snap.tools) ? snap.tools : [];
      const recent = tools.some(r => r && typeof r.t === 'number' && snap.t - r.t <= FOLLOWUP_MS);
      const list = snap.groups && Array.isArray(snap.groups.list) ? snap.groups.list : [];
      if (recent && list.length) return { kind: 'continue', groups: list.slice() };
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
