// Picks the engine for a voice role: the configured one when it is available, else Windows speech, else None.
// Falling back used to be silent (Piper missing → Windows voice with no word why); now each fallback logs
// one warning naming the reason, and again only if the reason changes.
const ROLE = { stt: 'Speech-to-text', tts: 'Text-to-speech', wake: 'Wake word' };

function createEnginePick({ registries, getConfig, log = () => {} }) {
  const last = {};   // kind → reason last warned about (null while the configured engine is in use)

  return function pick(kind) {
    const id = getConfig().engines?.[kind];
    const e = registries[kind].get(id);
    if (e && (!e.available || e.available())) { last[kind] = null; return e; }
    const fallback = registries[kind].get('windows') || registries[kind].get('none');
    const why = e ? `${e.label || id} is not installed` : `no engine "${id}"`;
    if (last[kind] !== why) {
      last[kind] = why;
      log(`${ROLE[kind] || kind}: ${why}; using ${fallback.label || fallback.id}`);
    }
    return fallback;
  };
}

module.exports = { createEnginePick };
