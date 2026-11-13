// What the owner is doing right now, as a short search hint for memory recall (cortex/recall.js `context`).
// It only nudges what the question already found, and stands in for the question when a message says too little ("what port does it use").
// Input is one LiveState snapshot. Used: the app in front, its window title (the source drops it unless config livestate.windowTitle
// is on), and the active task's title. Never used: tool names, confirm text, media, voice state. The text is a query only: it is not put
// in the prompt, saved, logged or sent anywhere. Never throws.
const MAX = 300;

const text = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

function liveContext(snap) {
  try {
    if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return '';
    const parts = [];
    const w = snap.activeWindow;
    if (w && typeof w === 'object') parts.push(text(w.app, 80), text(w.title, 200));
    const t = snap.task;
    if (t && typeof t === 'object') parts.push(text(t.title, 120));
    return parts.filter(Boolean).join(' ').slice(0, MAX);
  } catch { return ''; }
}

module.exports = { liveContext };
