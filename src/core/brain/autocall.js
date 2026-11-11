// Calls JARVIS makes for the user before the model answers. A small local model often "describes" a clear request
// ("I have initiated a full health check") instead of calling the tool, so for a few unambiguous, argument-free requests the
// code makes the call and the model only phrases the result.
//   autoCalls(text) → [{ name, args }]   (empty when nothing clearly matches)
const RULES = [
  // "run a system diagnostic", "do a health check", "diagnostics"
  { re: /\b(?:run|do|start|perform|give me|show(?: me)?|check)\b.*\b(?:diagnostics?|health ?check|self[- ]?check)\b|^\W*(?:system )?(?:diagnostics?|health ?check)\W*$/i, call: { name: 'self_diagnostics', args: {} } },
  // "system information", "system stats", "cpu usage", "how much memory are you using"
  { re: /\bsystem (?:info(?:rmation)?|stats|status|specs|usage)\b|\b(?:cpu|gpu|ram|memory|vram|disk)\b.*\b(?:usage|using|used|load|temps?|temperatures?)\b|\b(?:usage|using|used)\b.*\b(?:cpu|gpu|ram|memory|vram)\b/i, call: { name: 'get_system_stats', args: {} } },
  // "what can you do", "what tools do you have"
  { re: /\bwhat (?:can|could) you (?:do|help)\b|\bwhat (?:skills|tools|abilities|capabilities) (?:do )?you\b|\bwhat do you have\b/i, call: { name: 'skills_list', args: {} } },
  // "what timers do I have", "list my alarms"
  { re: /^(?!.*\b(?:set|start|create|make|cancel|delete|remove)\b).*\b(?:what|which|any|list|show)\b.*\b(?:timers?|alarms?|reminders?)\b/i, call: { name: 'list_timers', args: {} } },
];

function autoCalls(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 200) return [];
  const out = [];
  for (const r of RULES) if (r.re.test(t) && !out.some(c => c.name === r.call.name)) out.push({ ...r.call, args: { ...r.call.args } });
  return out.slice(0, 2);
}

module.exports = { autoCalls };
