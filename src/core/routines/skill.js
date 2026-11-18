'use strict';
// Fast path for saved routines: "game mode", "run game mode", "undo game mode", "undo that routine", "list routines".
// A phrase must be exactly a routine name (after an optional run word); anything else is left to the rest of the chain,
// so "play music" and a bare "undo that" never land here.
const { NEEDS_OK } = require('../brain/guard');
const { normName } = require('./store');

const RUN_WORD = /^(?:run|start|activate|launch|enable|begin)\s+/;
const LIST = new Set(['what routines do i have', 'list routines', 'list my routines', 'what are my routines', 'show my routines']);
const UNDO_ANY = new Set(['undo that routine', 'undo the routine', 'undo my routine', 'undo last routine']);

const strip = t => String(t || '').toLowerCase().replace(/[.!?,]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:please|hey jarvis|jarvis)\s+/, '').trim();

function createRoutinesSkill({ store, routines }) {
  const say = (res, ok = res.ok) => {
    const out = String(res.text ?? '');
    const reply = out.startsWith(NEEDS_OK) ? out.slice(NEEDS_OK.length) : out;
    return { reply, record: reply, tool: 'routine', ok: !!ok };
  };

  async function handle(text, { source, signal } = {}) {
    const t = strip(text);
    if (!t) return null;
    try {
      if (LIST.has(normName(t))) {
        const names = store.list().map(r => r.name);
        const reply = names.length ? `Your routines: ${names.join(', ')}.` : 'You have no routines yet. Add one in settings.';
        return { reply, record: reply, tool: 'routine', ok: true };
      }
      if (UNDO_ANY.has(normName(t))) return say(await routines.undo());
      const undo = /^undo\s+(.+)$/.exec(t);
      if (undo) {
        const r = store.get(undo[1]);
        return r ? say(await routines.undo(r.name)) : null;
      }
      const r = store.get(t.replace(RUN_WORD, ''));
      if (!r) return null;
      return say(await routines.run(r.name, { turn: { source, tainted: false }, signal }));
    } catch (err) {
      return { reply: `I could not run that routine: ${err?.message || err}`, tool: 'routine', ok: false };
    }
  }
  return { handle };
}

module.exports = { createRoutinesSkill };
