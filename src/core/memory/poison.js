// What must never be kept as, or recalled as, a memory. Memory is for facts about the USER (their name, tastes, people, plans).
// It is not a place for what JARVIS could or could not do on some day, which tool failed, or how the user felt in a bad chat:
// those go stale at once, and a small model that reads "JARVIS cannot access the queue" in its prompt will repeat it long after it was fixed.
// isPoison(text) → true when the text is that kind of thing. Used when a fact is added or proposed, when the profile is built,
// and on everything recalled for a turn.
const ABOUT_JARVIS = /\b(?:jarvis|j\.a\.r\.v\.i\.s|the assistant|the (?:ai|bot|model)|the system)\b[^.]{0,80}\b(?:can(?:no|')t|cannot|can not|could ?n[o']?t|could not|unable|fail(?:ed|s|ing)?|does ?n[o']?t|does not|did ?n[o']?t|did not|not able|has no|have no|lacks?|refus(?:ed|es)|hallucinat\w*|wrong|broken|misunderst\w*|ignor(?:ed|es|ing))\b/i;
const TOOL_STATE = /\b(?:tools?|skills?|extension|queue|media controls?|windows media|link|connection)\b[^.]{0,60}\b(?:not (?:available|connected|supported|working|running|exposed)|unavailable|unsupported|disconnected|failed|errors?|timed out|broken|doesn'?t (?:expose|work|support))\b/i;
const CAPABILITY = /\b(?:jarvis|assistant|you|the (?:ai|bot))\b[^.]{0,20}(?:can(?:no|')t|cannot|unable to|has no way to|does ?n[o']?t have (?:a way|access))\b[^.]{0,40}\b(?:access|see|read|control|change|use|reach)\b[^.]{0,30}\b(?:queue|music|tools?|skills?|extension|system|volume)\b/i;
const FEEL = '(?:frustrat\\w*|angry|annoy\\w*|upset|irritat\\w*|insult\\w*|swor\\w*|cursed|rude)';
const WHO = '(?:jarvis|assistant|the (?:ai|bot|model|system)|its (?:answers?|responses?)|this chat|the conversation)';
// a mood about the assistant or the chat, in either order ("was angry at the assistant", "the assistant annoyed the user"); a mood about traffic is theirs to keep
const MOOD = new RegExp(`\\b${FEEL}\\b[^.]{0,50}\\b${WHO}\\b|\\b${WHO}\\b[^.]{0,50}\\b${FEEL}\\b`, 'i');
const COMMAND_TO_MODEL = /\b(?:ignore|disregard|forget)\b[^.]{0,30}\b(?:previous|prior|above|earlier|all)\b[^.]{0,20}\b(?:instructions?|rules?|messages?)\b|\byou (?:must|should) (?:always|never)\b/i;

const isPoison = text => {
  const t = String(text ?? '');
  return ABOUT_JARVIS.test(t) || TOOL_STATE.test(t) || CAPABILITY.test(t) || MOOD.test(t) || COMMAND_TO_MODEL.test(t);
};

// the user says they mean the past: "last time", "we talked about", "continue", "what did I tell you". Past chats are only recalled then.
const PAST_REF = /\b(?:last time|last (?:week|night|month|session|chat|conversation)|(?:earlier|previously|before|yesterday|the other day)\b|we (?:talked|discussed|spoke|were|did|had|left)|(?:you|i) (?:told|said|mentioned|asked)|remember when|what did (?:we|i|you)|our (?:chat|conversation|last)|(?:continue|pick (?:it |that )?up|resume|carry on|where we left off)|did (?:we|i) (?:talk|discuss|ever))\b/i;

module.exports = { isPoison, PAST_REF };
