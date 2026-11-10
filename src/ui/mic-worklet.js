// AudioWorklet: mono float input (context runs at 16 kHz) → Int16 frames of 20 ms (320 samples).
class JarvisMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(320);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      this.frame[this.n++] = v < 0 ? v * 32768 : v * 32767;
      if (this.n === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Int16Array(320);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('jarvis-mic', JarvisMic);
