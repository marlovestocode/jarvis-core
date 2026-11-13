// How JARVIS talks: one place for word choice, register and spoken number style, chosen in config.speech instead of hard-coded.
//   config.speech = { dialect: 'british-formal' | 'neutral' | 'casual', contractions: true|false, pauses: true|false, dateOrder: 'mdy' | 'dmy' }
//   Anything not set is what the dialect does. The model is told the dialect in its prompt (character, diction); the text that
//   reaches the voice is then normalised the same way (register words, contractions, dates, numbers), so what he says matches what he
//   was told to say whichever model wrote it.
// resolve(speech) → { id, label, character, diction, register: [[RegExp, string|fn]], contractions, dateOrder, numberAnd, pauses }
// formal register: informal words become their formal equivalent when spoken
const FORMAL_REGISTER = [
  [/\b(?:yeah|yep|yup)\b/gi, w => (/^[A-Z]/.test(w) ? 'Yes' : 'yes')], [/\bnope\b/gi, w => (/^[A-Z]/.test(w) ? 'No' : 'no')],
  [/\b(?:okay|ok)\b(?=[.!,]|\s*$)/gi, w => (/^[A-Z]/.test(w) ? 'Very well' : 'very well')],
  [/\bgonna\b/gi, 'going to'], [/\bwanna\b/gi, 'want to'], [/\bgotta\b/gi, 'have to'], [/\bkinda\b/gi, 'rather'], [/\bsorta\b/gi, 'somewhat'],
  [/\bawesome\b/gi, 'excellent'], [/\bno worries\b/gi, 'not at all'], [/\bno problem\b/gi, 'not at all'], [/\bsuper (?=[a-z])/gi, 'very '],
  [/\bstuff\b/gi, 'things'], [/\ba bunch of\b/gi, 'several'], [/\bhey\b[,!]?\s*/gi, ''], [/\blet's see\b/gi, 'let me see'],
];
// neutral and casual only tidy what a voice should not say
const PLAIN_REGISTER = [[/\bhey\b[,!]?\s*(?=[A-Z])/g, '']];

const SHARED_NEVER = 'Never open with "Certainly!", "Sure!", "Great question" or "I understand"; never close with "let me know if you need anything else" or "I hope this helps"; never say "As an AI".';
const VARY = 'Vary sentence length: mix short sentences with one longer one, and never three of the same length in a row.';
const ACK = 'Acknowledge only a request you have just carried out, in a word or two, and only now and then: never after an answer, a refusal, an error, a question or a greeting, and never twice in a row.';

const PRESETS = {
  'british-formal': {
    label: 'British, formal (butler)',
    character: 'Character: J.A.R.V.I.S. as in the films: a refined British butler-intelligence. Formal, articulate, exact and unhurried; dry understatement used lightly, never when something has failed or the user is stressed. Loyal and warm beneath the composure; never gushing, never robotic. Give the answer first, then at most one clause of the most useful context, and raise anything that needs their attention.',
    diction: `Diction: British English in a formal but natural register: complete sentences, the exact word, correct grammar. Use contractions where a person would say them aloud ("I'm afraid I can't", "that's done"); keep the formality in word choice ("I'm afraid", "rather", "quite", "indeed", "shall I", "if I may"), not by avoiding contractions. No slang or filler: never "yeah", "nope", "okay", "gonna", "wanna", "stuff", "a bunch", "kind of", "super", "awesome", "cool", "no worries". Say numbers, dates and times the way they are read aloud. ${VARY} ${ACK} ${SHARED_NEVER} Own an error briefly ("My apologies, I misheard that."). Vary how you begin; use their name only now and then.`,
    register: FORMAL_REGISTER, contractions: true, dateOrder: 'mdy', numberAnd: true, pauses: true,   // dates stay month-first (the user's own locale) unless config.speech.dateOrder says 'dmy'
  },
  neutral: {
    label: 'Neutral American, friendly',
    character: 'Character: J.A.R.V.I.S., a calm, capable assistant. Clear, friendly and direct; light humour is fine, never when something has failed or the user is stressed. Give the answer first, then at most one clause of the most useful context, and raise anything that needs their attention.',
    diction: `Diction: American English in plain words and complete sentences. Use contractions the way people speak ("I can't", "that's done", "it's 21 degrees"). No filler, no flattery, no slang beyond a light "okay". Say numbers, dates and times the way they are read aloud. ${VARY} ${ACK} ${SHARED_NEVER} Own an error briefly ("Sorry, I misheard that."). Vary how you begin; use their name only now and then.`,
    register: PLAIN_REGISTER, contractions: true, dateOrder: 'mdy', numberAnd: false, pauses: true,
  },
  casual: {
    label: 'Casual, relaxed',
    character: 'Character: J.A.R.V.I.S., a relaxed, quick-witted friend who happens to be very capable. Short, warm and direct; a little humour is welcome, never when something has failed or the user is stressed. Answer first, then at most one useful clause.',
    diction: `Diction: everyday spoken English: contractions, short sentences, simple words; "yeah", "okay" and "no problem" are fine. Say numbers, dates and times the way they are read aloud. ${VARY} ${ACK} ${SHARED_NEVER} Own an error briefly ("Oops, I misheard that."). Vary how you begin; use their name only now and then.`,
    register: PLAIN_REGISTER, contractions: true, dateOrder: 'mdy', numberAnd: false, pauses: true,
  },
};
const DEFAULT_ID = 'british-formal';

function resolve(speech = {}) {
  const s = speech && typeof speech === 'object' ? speech : {};
  const id = Object.hasOwn(PRESETS, s.dialect) ? s.dialect : DEFAULT_ID;
  const p = PRESETS[id];
  return {
    id, label: p.label, character: p.character, diction: p.diction, register: p.register,
    contractions: typeof s.contractions === 'boolean' ? s.contractions : p.contractions,
    dateOrder: s.dateOrder === 'dmy' || s.dateOrder === 'mdy' ? s.dateOrder : p.dateOrder, numberAnd: p.numberAnd, pauses: typeof s.pauses === 'boolean' ? s.pauses : p.pauses,
  };
}

const list = () => Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label }));

module.exports = { resolve, list, PRESETS, DEFAULT_ID };
