// Per-turn routing: quick chat → fast model; anything technical → main model;
// "thinking" only where step-by-step reasoning pays for its latency.
const MATH = /\d\s*[-+*/^×÷=]\s*\d|\b(calculat|comput|solve|equation|integra|derivat|differentiat|limit|matrix|vector|probabilit|percent|average|mean|median|deviation|variance|sum of|factor|prime|logarithm|exponent|sqrt|square root|raised to|power of|\d+\s*!)/i;
const SCIENCE = /\b(physic|velocity|speed of|accelerat|force|energy|momentum|mass|gravity|gravitational|orbit|wavelength|frequency|photon|electron|quantum|relativ|thermo|entropy|pressure|voltage|current|resistance|circuit|chemi|molecul|reaction|moles?|atom|biolog|dna|enzyme|projectile|escape velocity|pendulum)/i;
const UNITS = /\b(convert|conversion|in (?:meters|feet|miles|km|kilograms|pounds|celsius|fahrenheit|kelvin)|mph|km\/h|m\/s|kwh|psi)\b/i;
const CODE = /```|\b(code|function|script|python|javascript|typescript|node|powershell|c\+\+|rust|java|sql|regex|bug|error|exception|stack trace|compile|debug|api|algorithm)\b/i;
const SYSTEM = /\b(my (?:pc|computer|gpu|cpu|ram|system|machine)|this (?:pc|computer)|gpu|cpu|vram|temperature|temps|fps|sysmon|wallpaper|jarvis status|play|pause|next track|volume|music|song)\b/i;
const DATES = /\b(days? (?:between|until|since|from)|how many (?:days|weeks|months)|what day|weekday|date)\b/i;
const EXPLAIN = /\b(explain|why|how does|how do|compare|difference between|analy[sz]e|design|plan|strategy|summari[sz]e|essay|write)\b/i;
const THINK = /\b(prove|proof|derive|derivation|show that|step by step|puzzle|riddle|logic|paradox|optimi[sz]e|trade-?offs?|catch up|how far|how long until|word problem)\b/i;
const ASK_THINK = /\b(think (?:hard|carefully|deeply|step by step)|reason carefully)\b/i;
const CHAT = /^(hi|hey|hello|yo|thanks|thank you|thx|ok|okay|cool|nice|good (?:morning|night|evening|afternoon)|bye|goodbye|who are you|what are you|how are you|tell me a joke|joke)\b/i;

function route(text, { source = 'text' } = {}) {
  const t = String(text || '').trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  const asked = ASK_THINK.test(t);
  const technical = MATH.test(t) || SCIENCE.test(t) || UNITS.test(t) || CODE.test(t) || SYSTEM.test(t) || DATES.test(t);
  const heavy = technical || EXPLAIN.test(t) || words > 25 || (t.match(/\?/g) || []).length > 1;
  if (!heavy && !asked && (CHAT.test(t) || words <= 12)) return { tier: 'fast', think: false, reason: 'chat' };
  // reasoning: proofs/derivations/multi-step word problems; long multi-part asks
  const reasoning = THINK.test(t) || (words > 30 && (MATH.test(t) || SCIENCE.test(t)));
  const think = asked || (source !== 'voice' && reasoning);
  return { tier: 'deep', think, reason: asked ? 'asked to think' : reasoning ? 'reasoning' : technical ? 'technical' : 'long' };
}

module.exports = { route };
