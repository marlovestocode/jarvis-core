// Memory fast path: "remember that...", "forget...", "what do you remember about me?" are handled here,
// before any model call (quick chat has no tools, so the model could not do this itself).
// handle(text) → null | { reply, record, tool: 'memory', ok }
const STRIP = /^\s*(?:(?:hey |ok(?:ay)? )?jarvis[,.!]?\s*)?(?:please\s+)?(?:(?:can|could|would|will) you\s+(?:please\s+)?)?/i;
// "… from your memory please?": the place and the politeness are not part of what to forget
const TAIL = /\s+(?:from|out of)\s+(?:your\s+|my\s+|the\s+)?memor(?:y|ies)\b|\s*,?\s*please$|\s*\?+$/gi;

const REMEMBER = /^(?:remember|memorize|make a note|note|keep in mind|don'?t forget)\s+(?:that\s+)?(.{3,})$/i;
const FORGET_ALL = /^(?:forget|erase|clear|wipe|delete)\s+(?:everything|all)(?:\s+(?:you\s+)?(?:know|remember)(?:\s+about me)?)?$|^(?:clear|wipe|erase)\s+(?:your\s+|my\s+)?memory$/i;
const FORGET = /^(?:forget|delete|remove)\s+(?:that\s+|about\s+)?(.{2,})$/i;
const RECALL = /^(?:what|who)\s+(?:do|did)\s+you\s+(?:remember|know)(?:\s+about\s+(?:me|us))?\s*\??$|^what(?:'s| is| have you got| do you have)\s+(?:in\s+)?(?:your\s+)?memory\??$|^(?:list|show)\s+(?:your\s+|my\s+)?(?:memory|memories|notes)\??$|^what have you (?:remembered|learned)(?:\s+about me)?\??$/i;

// "what do you remember about Rex" (not "about me"): the memory_about text, no model call
const ABOUT = /^(?:what|who)\s+(?:do|did)\s+you\s+(?:remember|know)\s+about\s+(?!(?:me|us|myself)\s*\??$)(.{2,60}?)\s*\??$/i;

const NAME = /^(?:(?:please\s+)?call me|my name(?:'s| is)|i am called|i'm called|you can call me)\s+([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,2})$/i;
const say = (reply, ok = true) => ({ reply, record: reply, tool: 'memory', ok });

// "my name is Daniel" → kept as said; "I" statements become third person only in the prompt, not here
function createMemorySkill({ memory, setName = null, about = null }) {
  async function handle(text) {
    const t = String(text || '').replace(STRIP, '').replace(/[.!]+\s*$/, '').trim();
    if (!t) return null;
    if (FORGET_ALL.test(t)) {
      const n = memory.clear();
      return say(n ? `Done. I forgot all ${n} thing${n === 1 ? '' : 's'}.` : 'There was nothing to forget.');
    }
    if (RECALL.test(t)) {
      const l = memory.list();
      if (!l.length) return say("I don't have anything saved about you yet.");
      return say(`I remember ${l.length} thing${l.length === 1 ? '' : 's'}: ${l.slice(-12).join('; ')}.`);
    }
    const ab = about && ABOUT.exec(t);
    if (ab) return say(String(await about(ab[1])));
    const nm = setName && NAME.exec(t);
    if (nm) {
      const name = nm[1].replace(/\b\w/g, c => c.toUpperCase());
      setName(name);
      return say(`Understood, ${name}. I'll call you that.`);
    }
    let m = REMEMBER.exec(t);
    if (m) {
      const r = memory.add(m[1]);
      if (r.ok) return say(r.duplicate ? 'I already had that.' : `Got it. I'll remember that ${r.text.replace(/^i\b/i, 'you').replace(/\bmy\b/gi, 'your')}.`);
      return say({ secret: "I won't store passwords, keys or card numbers.", long: 'That is too long to remember. Make it shorter.', empty: 'Remember what?', incomplete: 'That sounded cut off, so I did not save it. Say all of it again?' }[r.reason] || 'I could not save that.', false);
    }
    m = FORGET.exec(t.replace(TAIL, '').replace(TAIL, '').trim());
    if (m && !/^(?:it|this|that|him|her|them)$/i.test(m[1].trim())) {
      const r = memory.forget(m[1]);
      if (r.removed.length) return say(`Forgot ${r.removed.length === 1 ? 'that' : `those ${r.removed.length}`}: ${r.removed.join('; ')}.`);
      if (r.ambiguous) return say(`That matches ${r.ambiguous.length} things: ${r.ambiguous.slice(0, 4).join('; ')}. Say which one, or "forget everything".`, true);
      return null;   // maybe "forget about the meeting" for the model to answer: not a stored fact
    }
    return null;
  }
  return { handle };
}

module.exports = { createMemorySkill };
