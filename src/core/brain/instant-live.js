// Questions whose whole answer is one argument-free read-only tool's result: the timers that are set, the PC's load and temperatures.
// The code runs the tool and speaks its result; the model is not asked to choose the tool or to phrase the answer back.
// ("what is playing" is already answered without the model by the media skill.)
//   liveIntent(text) -> null | { tool, focus? }          whole-message matches only
//   liveReply(intent, toolText) -> string | null          null = let the model answer (an error text, nothing usable)
const HEAD = /^(?:(?:please|hey|ok|okay)[,\s]+|jarvis[,\s]+)*/i;
const THING = String.raw`(?:timers?|alarms?|reminders?)`;

const TIMERS = [
  new RegExp(String.raw`^(?:what|which) ${THING}(?: do i have| have i (?:set|got)| are (?:set|running|active|going)| are there)?(?: right now| at the moment)?$`, 'i'),
  new RegExp(String.raw`^(?:list|show|read|check)(?: me)?(?: all)?(?: of)?(?: my| the)? ${THING}$`, 'i'),
  new RegExp(String.raw`^(?:do i have|have i got|are there) any ${THING}(?: set| running| going| active)?(?: right now)?$`, 'i'),
  /^(?:how much time|how long) (?:is )?(?:left|remaining)(?: on| for)?(?: my| the)?(?: timer)?(?: right now)?$/i,
];

const PART = String.raw`(?:cpu|processor|gpu|graphics card|video card|ram|memory|vram|disk|drives?|network)`;
const STATS = [
  /^how(?:'s|’s| is) my (?:pc|computer|system|machine|rig) (?:doing|running|performing|holding up)(?: right now)?$/i,
  /^(?:the )?(?:system|pc|computer|machine) (?:stats|status|usage|info|information|performance|load|specs)$/i,
  new RegExp(String.raw`^(?:what(?:'s|’s| is) )?(?:my |the )?${PART} (?:usage|load|temp(?:erature)?s?|use|status|stats)(?: right now)?$`, 'i'),
  new RegExp(String.raw`^how (?:hot|warm|busy|loaded|stressed) is my ${PART}(?: right now)?$`, 'i'),
  new RegExp(String.raw`^how much ${PART} (?:am i|are we|is being|is my pc) us(?:ing|ed)(?: right now)?$`, 'i'),
  new RegExp(String.raw`^how(?:'s|’s| is) my ${PART} (?:doing|running|holding up)$`, 'i'),
];

const FOCUS = [[/\b(?:cpu|processor)\b/i, 'CPU'], [/\b(?:gpu|graphics card|video card|vram)\b/i, 'GPU'], [/\b(?:ram|memory)\b/i, 'RAM'], [/\b(?:disk|drives?)\b/i, 'disk|drives'], [/\bnetwork\b/i, 'network']];

function liveIntent(text) {
  const t = String(text || '').trim().replace(HEAD, '').trim().replace(/[?!.\s]+$/, '');
  if (!t || t.length > 70) return null;
  if (TIMERS.some(re => re.test(t))) return { tool: 'list_timers' };
  if (STATS.some(re => re.test(t))) {
    const f = FOCUS.find(([re]) => re.test(t));
    return { tool: 'get_system_stats', ...(f ? { focus: f[1] } : {}) };
  }
  return null;
}

function liveReply(intent, toolText) {
  const text = String(toolText || '').trim();
  if (!text || /^error/i.test(text) || text.length > 400) return null;
  if (intent.tool === 'list_timers') return text;
  // "CPU 12% (45°C); GPU 3%; RAM 41%; network ...; drives C: 60% used.": a named part answers with its own part only
  const parts = text.replace(/\.$/, '').split('; ');
  if (intent.focus) {
    const re = new RegExp('^(?:' + intent.focus + ')\\b', 'i');
    const own = parts.filter(p => re.test(p));
    if (!own.length) return null;
    return own.join('; ') + '.';
  }
  return text;
}

module.exports = { liveIntent, liveReply };
