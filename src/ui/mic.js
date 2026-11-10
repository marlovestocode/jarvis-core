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

  // ---- speech playback (Piper PCM from main). One output context, one source at a time. ----
  let out = null, current = null;
  function play({ id, pcm, rate }) {
    try {
      if (!out) out = new AudioContext({ latencyHint: 'interactive' });
      if (out.state === 'suspended') out.resume();
      const samples = pcm instanceof Int16Array ? pcm : new Int16Array(pcm.buffer || pcm);
      const buf = out.createBuffer(1, samples.length, rate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768;
      const src = out.createBufferSource();
      src.buffer = buf;
      src.connect(out.destination);
      src.onended = () => { if (current === src) current = null; window.micBridge.played(id, 'ended'); };
      current = src;
      src.start();
      window.micBridge.played(id, 'started', out.outputLatency || out.baseLatency || 0);
    } catch (err) {
      window.micBridge.played(id, 'error', 0, String(err && err.message || err));
    }
  }
  function stopPlay() { if (current) { try { current.stop(); } catch (e) { /* ended */ } current = null; } }

  window.micBridge.onCommand(c => {
    if (c.cmd === 'start') start(c.deviceId || null);
    else if (c.cmd === 'stop') stop();
    else if (c.cmd === 'play') play(c);
    else if (c.cmd === 'stop-play') stopPlay();
  });
  window.micBridge.ready();
})();
