// Short two-note "I'm listening" chime (no files): 22.05 kHz Int16 PCM.
function chime({ rate = 22050, volume = 0.18 } = {}) {
  const notes = [[880, 0.07], [1320, 0.09]];
  const total = Math.round(notes.reduce((s, [, d]) => s + d, 0) * rate);
  const pcm = new Int16Array(total);
  let o = 0;
  for (const [hz, dur] of notes) {
    const n = Math.round(dur * rate);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / (0.005 * rate)) * Math.min(1, (n - i) / (0.02 * rate)); // no clicks
      pcm[o + i] = Math.round(Math.sin(2 * Math.PI * hz * i / rate) * env * volume * 32767);
    }
    o += n;
  }
  return pcm;
}

module.exports = { chime };
