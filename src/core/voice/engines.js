// Voice engine interfaces (spec §3) and registries. 'none' engines are the fallback.
//   SttEngine  { id, label, async status(), async transcribe(pcm16, sampleRate, signal) → text }
//   TtsEngine  { id, label, async status(), speak(text, { rate, signal }) → { levels: AsyncIterable<number>, done: Promise } }
//   WakeEngine { id, label, async status(), start(onWake), stop() }
const { createRegistry } = require('../providers/provider');

const notReady = async () => ({ ready: false, detail: 'No engine' });

const NoneStt = {
  id: 'none', label: 'None', status: notReady,
  async transcribe() { throw new Error('No speech-to-text engine'); },
};
const NoneTts = {
  id: 'none', label: 'None', status: notReady,
  speak() { throw new Error('No text-to-speech engine'); },
};
const NoneWake = {
  id: 'none', label: 'None', status: notReady,
  start() {}, stop() {},
};

function createEngineRegistries() {
  const stt = createRegistry(), tts = createRegistry(), wake = createRegistry();
  stt.add(NoneStt); tts.add(NoneTts); wake.add(NoneWake);
  return { stt, tts, wake };
}

module.exports = { createEngineRegistries, NoneStt, NoneTts, NoneWake };
