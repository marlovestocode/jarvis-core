// What was asked, for the lyrics fast path. -> null | { kind: 'show', current: true } | { kind: 'show', title, artist? }
//   | { kind: 'find', phrase } | { kind: 'next', phrase }
// Anchored at the start so "play the lyrics video" or a long sentence that merely mentions lyrics is left to the model.
const CURRENT = /^(?:this|it|that|this song|that song|this track|that track|the current song|the current track|the song|the song (?:that'?s|that is) playing|what'?s playing|what is playing|the song playing(?: now| right now)?|the one playing|right now)$/i;
const unquote = s => String(s || '').trim().replace(/^["'“‘]+|["'”’.?!,]+$/g, '').trim();
const LEAD = String.raw`(?:(?:hey |ok |okay )?jarvis,? )?(?:(?:can|could|would) you |please )?`;

function target(raw) {
  const t = unquote(raw);
  if (!t || CURRENT.test(t)) return { kind: 'show', current: true };
  const m = t.match(/^(.+?)\s+by\s+(.+)$/i);
  return m ? { kind: 'show', title: unquote(m[1]), artist: unquote(m[2]) } : { kind: 'show', title: t };
}

function parse(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t || t.length > 300) return null;
  let m;
  // the line after a remembered line
  if ((m = t.match(new RegExp(`^${LEAD}(?:what(?:'s| is) )?(?:the )?(?:next|following) line (?:after|to|of|from)\\s+(.{3,})$`, 'i')))) return { kind: 'next', phrase: unquote(m[1]) };
  if ((m = t.match(new RegExp(`^${LEAD}what (?:comes|goes|is|follows) after (?:the line |the lyric )?(.{3,})$`, 'i')))) return { kind: 'next', phrase: unquote(m[1]) };
  // a song from its words
  if ((m = t.match(new RegExp(`^${LEAD}(?:what|which) (?:song|track) (?:goes|says|has the (?:line|lyrics?)|has|is the (?:line|lyric)|starts with|contains)\\s*:?\\s+(.{3,})$`, 'i')))) return { kind: 'find', phrase: unquote(m[1]) };
  if ((m = t.match(new RegExp(`^${LEAD}(?:name|find|identify) (?:the |that )?(?:song|track) (?:that )?(?:goes|says|with the (?:line|lyrics?))\\s*:?\\s+(.{3,})$`, 'i')))) return { kind: 'find', phrase: unquote(m[1]) };
  if ((m = t.match(new RegExp(`^${LEAD}(?:what|which) (?:song|track) is (?:the (?:line|lyric) )?(.{6,}?) from$`, 'i')))) return { kind: 'find', phrase: unquote(m[1]) };
  // lyrics to a song
  if ((m = t.match(new RegExp(`^${LEAD}(?:(?:show|get|give|find|pull up|display|read|bring up|look up|pull|tell|say|sing|recite|print|write out)(?: me)? |what(?:'s| is| are) |let me see |i (?:want|need) )?(?:the )?(?:full )?lyrics?(?:\\s+(?:to|for|of)\\s+(.+))?$`, 'i')))) return target(m[1]);
  if ((m = t.match(new RegExp(`^${LEAD}(?:show|get|give|find|pull up|bring up)(?: me)? (?:the )?(.{3,}?) lyrics$`, 'i')))) return target(m[1]);
  if ((m = t.match(new RegExp(`^${LEAD}(?:what )?(?:are |is )?the (?:words|lyrics) (?:to|for|of) (.+)$`, 'i')))) return target(m[1]);
  // a looser sentence that is clearly about the playing song's lyrics ("I want to see the lyrics for the song that's playing")
  if (t.length <= 90 && !/\b(?:play|queue|add|skip|download|video)\b/i.test(t) && /\blyrics?\b/i.test(t) && /\b(?:this|that|current|playing|right now)\b/i.test(t)) return { kind: 'show', current: true };
  return null;
}

module.exports = { parse, target };
