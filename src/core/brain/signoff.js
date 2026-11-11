// The fine-tuned model ends many replies with "Very good." although the prompt says it is not a sign-off. The streamed
// reply drops a trailing "Very good" (", sir" / ", <name>" allowed) before it is shown or spoken: text that could still
// become that sign-off is held back until more text proves otherwise or the reply ends. A reply that is only
// "Very good." is kept, and "Very good" earlier in a reply is left alone.
const FULL = /^very good[,.!]*(?:\s*,?\s*[\p{L}'’]{1,20})?[.!]*\s*$/iu;
const PHRASE = 'very good';
// could this end-of-reply text still turn out to be the sign-off?
const maybe = s => { const t = s.trimStart().toLowerCase(); return t.length > 0 && (PHRASE.startsWith(t) || FULL.test(t)); };
// where a sentence may start: the beginning, or after . ! ? … and a space
const starts = text => [0, ...[...text.matchAll(/[.!?…]\s+/g)].map(m => m.index + 1)];

function createSignoffFilter() {
  let held = '';
  let said = false;   // anything visible already let through
  let ended = false;  // what was let through ends a sentence, so the next text may start one
  function release(s) { if (s.trim()) { said = true; ended = /[.!?…]\s*$/.test(s); } return s; }
  return {
    push(chunk) {
      const text = held + String(chunk ?? '');
      const cut = starts(text).find(i => (i > 0 || (said && ended && /^\s/.test(text))) && maybe(text.slice(i)));
      if (cut === undefined) { held = ''; return release(text); }
      held = text.slice(cut);
      return release(text.slice(0, cut));
    },
    end() {
      const rest = held;
      held = '';
      return said && FULL.test(rest.trim()) ? '' : release(rest);
    },
  };
}

module.exports = { createSignoffFilter };
