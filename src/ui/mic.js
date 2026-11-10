// Hidden mic window: getUserMedia → AudioWorklet → 16 kHz Int16 frames → main (mic:pcm).
// Runs only between a 'start' and a 'stop' command from main.
(() => {
  let ctx = null, stream = null, node = null, src = null, sink = null, gen = 0;

  function stop() {
    gen++;
    try { src && src.disconnect(); } catch (e) { /* closed */ }
    try { node && node.disconnect(); } catch (e) { /* closed */ }
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (ctx) ctx.close().catch(() => {});
    ctx = stream = node = src = sink = null;
  }

  async function start(deviceId) {
    stop();
    const my = gen;
    try {
      const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      if (deviceId) audio.deviceId = { exact: deviceId };
      const s = await navigator.mediaDevices.getUserMedia({ audio });
      if (my !== gen) { s.getTracks().forEach(t => t.stop()); return; }
      stream = s;
      stream.getAudioTracks()[0].addEventListener('ended', () => { window.micBridge.status(false, 'Microphone disconnected'); stop(); });
      ctx = new AudioContext({ sampleRate: 16000 });
      await ctx.audioWorklet.addModule('mic-worklet.js');
      if (my !== gen) return;
      src = ctx.createMediaStreamSource(stream);
      node = new AudioWorkletNode(ctx, 'jarvis-mic');
      node.port.onmessage = e => window.micBridge.pcm(e.data);
      sink = ctx.createGain();
      sink.gain.value = 0;                 // keep the graph pulled without playing the mic back
      src.connect(node).connect(sink).connect(ctx.destination);
      window.micBridge.status(true, '', ctx.sampleRate);
    } catch (err) {
      if (my !== gen) return;
      stop();
      window.micBridge.status(false, (err && (err.name + ': ' + err.message)) || 'unknown error');
    }
  }

  window.micBridge.onCommand(c => {
    if (c.cmd === 'start') start(c.deviceId || null);
    else if (c.cmd === 'stop') stop();
  });
  window.micBridge.ready();
})();
