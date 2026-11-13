// Ask or decline before guessing. Two cases where a small model used to invent an action:
//   ask:     "turn it off", "delete that": an action on a bare pronoun, with nothing earlier in the chat to point at
//   decline: "turn off the living room lights", "order me a pizza": things JARVIS has no tool for at all
// Both answer without the model, so there is no wrong tool call to take back. Anything else returns null and goes on as before.
// clarify(text, { lastGroups }) → null | { kind: 'ask' | 'decline', reply, reason }
// lastGroups is the skill groups the previous turn used: after "open Chrome", "close it" has something to mean, so it is not asked.

const HEAD = String.raw`^(?:please\s+|(?:hey\s+)?jarvis[,.]?\s+)*`;
const IT = String.raw`(?:it|that|this|them|those|these)`;
const END = String.raw`\s*[.!?]*\s*$`;

// verb → what to ask. "undo that" and "stop it" are deliberately absent: they mean something on their own (undo_last, media).
const ASK = [
  // each pattern ends right after the pronoun: a noun ("close this tab") or a destination ("move it to desktop 2") means there is something to act on
  [new RegExp(`${HEAD}(?:turn|switch)\\s+${IT}\\s+(off|on)${END}`, 'i'), m => `What should I turn ${m[1].toLowerCase()}?`],
  [new RegExp(`${HEAD}(?:delete|remove|trash|get rid of)\\s+${IT}${END}`, 'i'), () => 'What should I delete?'],
  [new RegExp(`${HEAD}move\\s+${IT}${END}`, 'i'), () => 'Which files or windows should I move, and where to?'],
  [new RegExp(`${HEAD}close\\s+${IT}${END}`, 'i'), () => 'What should I close?'],
  [new RegExp(`${HEAD}open\\s+${IT}${END}`, 'i'), () => 'What should I open?'],
  [new RegExp(`${HEAD}(?:send|forward|share)\\s+${IT}(?:\\s+to\\s+(?:him|her|them))?${END}`, 'i'), () => 'What should I send, and to whom?'],
  [new RegExp(`${HEAD}(?:rename|copy|change|fix|save)\\s+${IT}\\s*$`, 'i'), m => `What should I ${/rename|copy|change|fix|save/i.exec(m[0])[0].toLowerCase()}?`],
  [new RegExp(`${HEAD}(?:do|run|repeat)\\s+(?:that|it|this)\\s+again\\s*$`, 'i'), () => "Do what again? I don't have an earlier action to repeat."],
];

// things with no tool behind them, and the plain words for what is missing
const NO_TOOL = [
  [/\b(?:turn|switch)\s+(?:on|off)\s+(?:the\s+|my\s+)?(?:(?:living room|bedroom|kitchen|hall(?:way)?|porch|bathroom|desk)\s+)?(?:lights?|lamps?)\b|\b(?:turn|switch)\s+(?:the\s+|my\s+)?(?:(?:living room|bedroom|kitchen|hall(?:way)?|porch|bathroom|desk)\s+)?(?:lights?|lamps?)\s+(?:on|off)\b|\b(?:dim|brighten)\s+the\s+(?:lights?|lamps?)\b/i, 'control lights'],
  [/\bthermostat\b|\b(?:turn|set)\s+(?:the\s+)?(?:heat(?:ing)?|a\/?c|air conditioning)\b/i, 'control the thermostat'],
  [/\b(?:order|get me|buy me)\s+(?:me\s+)?(?:a\s+|an\s+|some\s+)?(?:pizza|food|dinner|lunch|takeout|groceries|coffee|burger)\b/i, 'place orders'],
  [new RegExp(`${HEAD}(?:text|sms|call|phone|dial|ring)\\s+(?:my\\s+)?(?:mom|mum|dad|wife|husband|girlfriend|boyfriend|friend|boss|brother|sister|son|daughter)\\b`, 'i'), 'send messages or make calls'],
  [/\b(?:book|reserve)\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?(?:flight|hotel|table|ticket|room|reservation|uber|taxi|cab)\b/i, 'book travel or reservations'],
  [/\b(?:unlock|lock)\s+(?:the\s+|my\s+)?(?:front|back|garage|car|house)\s+(?:door|lock)?\b|\b(?:open|close)\s+the\s+garage\b/i, 'control door locks'],
  [/\b(?:send|compose and send)\s+(?:an?\s+|the\s+)?(?:e-?mail|text|sms|message)\b/i, 'send email or messages'],
];

// a request whose required detail is missing: the tool cannot run without it, so ask for it instead of letting the model invent one.
// These do not depend on the chat before them (a pronoun might), so they run before the lastGroups check.
const WHEN = String.raw`(?:\bat\b|\bin\b|\bon\b|\bafter\b|\bbefore\b|\bevery\b|\btonight\b|\btomorrow\b|\btoday\b|\bnoon\b|\bmidnight\b|\bmorning\b|\bevening\b|\d)`;
const MISSING = [
  [new RegExp(`${HEAD}(?:set|start|create|make)\\s+(?:me\\s+)?(?:a\\s+|an\\s+|the\\s+)?(?:\\w+\\s+)?timer${END}`, 'i'), () => 'For how long should I set the timer?'],
  [new RegExp(`${HEAD}(?:set|create|make)\\s+(?:me\\s+)?(?:a\\s+|an\\s+|the\\s+)?(?:\\w+\\s+)?alarm${END}`, 'i'), () => 'What time should I set the alarm for?'],
  [new RegExp(`${HEAD}remind\\s+me${END}`, 'i'), () => 'What should I remind you about, and when?'],
  [new RegExp(`${HEAD}remind\\s+me\\s+(?:to|about|that)\\s+(?!.*${WHEN}).+${END}`, 'i'), () => 'When should I remind you?'],
  [new RegExp(`${HEAD}remind\\s+me\\s+(?:at|in|on|after|tomorrow|tonight)\\b(?!.*\\b(?:to|about|that)\\b).*${END}`, 'i'), () => 'What should I remind you about?'],
  [new RegExp(`${HEAD}(?:set|change|adjust)\\s+(?:the\\s+|my\\s+)?(?:\\w+\\s+)?volume${END}`, 'i'), () => 'What volume level should I set?'],
  [new RegExp(`${HEAD}(?:search(?:\\s+(?:for|up))?|look\\s+up|google)${END}`, 'i'), () => 'What should I search for?'],
];

function clarify(text, { lastGroups = [] } = {}) {
  const t = String(text || '').trim();
  if (!t || t.length > 160) return null;
  for (const [re, what] of NO_TOOL) {
    if (re.test(t)) return { kind: 'decline', reason: what, reply: `I'm afraid I can't ${what}: I don't have a tool for that.` };
  }
  for (const [re, ask] of MISSING) {
    const m = re.exec(t);
    if (m) return { kind: 'ask', reason: 'missing detail', reply: ask(m) };
  }
  if (lastGroups.some(id => id !== 'core')) return null;   // there was an earlier action: "it" may mean its object
  for (const [re, ask] of ASK) {
    const m = re.exec(t);
    if (m) return { kind: 'ask', reason: 'bare pronoun', reply: ask(m) };
  }
  return null;
}

module.exports = { clarify, ASK, NO_TOOL };
