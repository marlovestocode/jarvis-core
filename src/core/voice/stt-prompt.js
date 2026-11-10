// Whisper initial prompt: biases spelling toward words JARVIS actually hears. Shared by main.js and
// scripts/voice-bench.js so the bench measures what the app runs. v0 = the original; v1 adds the command
// vocabulary of src/core/tools/* (media, weather, news, sports, knowledge, maths). Keep under ~200 tokens:
// a long prompt costs decode time and can be echoed back on silence (cleanTranscript must still blank it).
const STT_PROMPTS = Object.freeze({
  v0: 'JARVIS, Ollama, sysmon, Wallpaper Engine, Ryzen, RTX 3050, GPU, CPU, VRAM, Spotify, Discord, Steam.',
  v1: 'JARVIS, Ollama, sysmon, Wallpaper Engine, Ryzen, RTX 3050, GPU, CPU, VRAM, RAM, Spotify, Discord, Steam, '
    + 'YouTube Music, Chrome. Play, pause, skip, next song, previous, shuffle, repeat, volume up, volume down, mute, '
    + 'queue, playlist, album. Weather, forecast, rain, news headlines, scores, NFL, NBA, MLB, NHL. '
    + 'Wikipedia, look up, convert, calculate, integrate, derivative, solve, square root.',
});

const sttPrompt = name => (name === 'none' ? '' : STT_PROMPTS[name] ?? STT_PROMPTS.v1);

// Add the user's own words (playlist names, followed teams, their name) so "suicide timing" is heard as the
// playlist, not "Play My Part by Timing". Extra terms are capped so the prompt stays short and cheap to decode.
function withTerms(base, terms = [], maxChars = 240) {
  if (!base) return base;
  const seen = new Set(), out = [];
  let used = 0;
  for (const t of terms) {
    const w = String(t || '').replace(/\s+/g, ' ').trim();
    if (!w || w.length > 60 || seen.has(w.toLowerCase())) continue;
    if (used + w.length + 2 > maxChars) break;
    seen.add(w.toLowerCase()); out.push(w); used += w.length + 2;
  }
  return out.length ? `${base} ${out.join(', ')}.` : base;
}

module.exports = { STT_PROMPTS, sttPrompt, withTerms };
