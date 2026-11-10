// Mini orb for the chat header (48×48 canvas). Draws only real events.
// UMD: window.MiniOrb in the browser, module.exports (model only) in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MiniOrb = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const MAX_SPARKS = 16;
  const SPARK_LIFE = 0.9; // seconds

  function createModel() {
    let state = 'idle';
    let flash = 0;
    let pulse = 0;
    let t = 0;
    const sparks = [];

    function event(ev) {
      switch (ev.type) {
        case 'state':
          state = ev.state;
          if (state === 'error') flash = 1;
          break;
        case 'token':
          if (sparks.length >= MAX_SPARKS) sparks.shift();
          sparks.push({ age: 0, angle: Math.random() * Math.PI * 2 });
          break;
        case 'level': {
          const want = (state === 'speaking' && ev.source === 'tts') || (state === 'listening' && ev.source === 'mic');
          if (want) pulse = Math.max(pulse, Math.min(1, ev.rms));
          break;
        }
        case 'wake':
          flash = Math.max(flash, 0.6);
          break;
      }
    }

    function step(dt) {
      t += dt;
      flash = Math.max(0, flash - dt * 1.2);
      pulse = Math.max(0, pulse - dt * 2.5);
      for (const s of sparks) s.age += dt;
      while (sparks.length && sparks[0].age >= SPARK_LIFE) sparks.shift();
    }

    function snapshot() {
      return { color: state, state, flash, pulse, t, sparks: sparks.slice() };
    }

    return { event, step, snapshot };
  }

  // Colors come from the palette CSS variables.
  function readColors() {
    const css = getComputedStyle(document.documentElement);
    const v = n => css.getPropertyValue(n).trim();
    return {
      idle: v('--accent-rgb') || '63, 215, 255',
      listening: v('--accent-rgb') || '63, 215, 255',
      speaking: v('--accent-rgb') || '63, 215, 255',
      thinking: v('--gold-rgb') || '255, 181, 71',
      error: v('--crit-rgb') || '255, 77, 106',
    };
  }

  function create(canvas) {
    const g = canvas.getContext('2d');
    const model = createModel();
    const colors = readColors();
    const W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2;
    let last = performance.now();
    let raf = 0;

    function draw(now) {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      model.step(dt);
      const s = model.snapshot();
      g.clearRect(0, 0, W, H);
      const rgb = s.flash > 0 && s.state === 'error' ? colors.error : (colors[s.state] || colors.idle);
      let r = 7;
      let glow = 0.35;
      if (s.state === 'idle') { r += Math.sin(s.t * 1.2) * 0.6; }
      if (s.state === 'listening') { r += 1 + s.pulse * 5; glow = 0.6 + s.pulse * 0.4; }
      if (s.state === 'thinking') { const p = (Math.sin(s.t * 6) + 1) / 2; r += p * 2; glow = 0.4 + p * 0.4; }
      if (s.state === 'speaking') { r += s.pulse * 6; glow = 0.45 + s.pulse * 0.5; }
      if (s.state === 'error') glow = 0.3 + s.flash * 0.7;

      const grd = g.createRadialGradient(cx, cy, 0, cx, cy, r * 2.6);
      grd.addColorStop(0, `rgba(${rgb}, ${glow})`);
      grd.addColorStop(1, `rgba(${rgb}, 0)`);
      g.fillStyle = grd;
      g.beginPath(); g.arc(cx, cy, r * 2.6, 0, Math.PI * 2); g.fill();
      g.fillStyle = `rgba(${rgb}, 0.95)`;
      g.beginPath(); g.arc(cx, cy, r * 0.55, 0, Math.PI * 2); g.fill();
      g.strokeStyle = `rgba(${rgb}, 0.5)`;
      g.lineWidth = 1;
      g.beginPath(); g.arc(cx, cy, 20, 0, Math.PI * 2); g.stroke();

      // token sparks: expanding rings with a bright dot on each
      for (const sp of s.sparks) {
        const k = sp.age / SPARK_LIFE;
        const rr = r + k * (22 - r);
        g.strokeStyle = `rgba(${colors.idle}, ${0.5 * (1 - k)})`;
        g.beginPath(); g.arc(cx, cy, rr, 0, Math.PI * 2); g.stroke();
        g.fillStyle = `rgba(${colors.idle}, ${1 - k})`;
        g.beginPath(); g.arc(cx + Math.cos(sp.angle) * rr, cy + Math.sin(sp.angle) * rr, 1.4, 0, Math.PI * 2); g.fill();
      }
      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);

    return {
      event: ev => model.event(ev),
      destroy: () => cancelAnimationFrame(raf),
    };
  }

  return { create, createModel, MAX_SPARKS };
}));
