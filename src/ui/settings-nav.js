// Settings chrome only: section nav with scroll-spy, search filter, entrance motion. No settings logic lives here.
(() => {
  const body = document.querySelector('.body');
  const nav = document.getElementById('nav');
  const find = document.getElementById('find');
  const sections = [...document.querySelectorAll('section[data-nav]')];
  const reduced = !!(window.HUD && window.HUD.reduced);

  const buttons = sections.map(sec => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = sec.dataset.nav;
    b.addEventListener('click', () => { find.value = ''; filter(); sec.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' }); });
    nav.append(b);
    return b;
  });

  function spy() {
    let cur = 0;
    sections.forEach((sec, i) => { if (!sec.hidden && sec.offsetTop - body.scrollTop <= 60) cur = i; });
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) cur = sections.length - 1;
    buttons.forEach((b, i) => b.classList.toggle('on', i === cur));
  }
  body.addEventListener('scroll', spy, { passive: true });

  function filter() {
    const q = find.value.trim().toLowerCase();
    body.classList.toggle('searching', !!q);
    for (const sec of sections) {
      const rows = [...sec.querySelectorAll('.row')];
      const headHit = !q || sec.dataset.nav.toLowerCase().includes(q);
      let any = false;
      for (const r of rows) { const hit = headHit || r.textContent.toLowerCase().includes(q); r.classList.toggle('nomatch', !hit); if (hit) any = true; }
      sec.classList.toggle('nomatch', !!q && !headHit && !any);
    }
    spy();
  }
  find.addEventListener('input', filter);
  find.addEventListener('keydown', e => { if (e.key === 'Escape' && find.value) { find.value = ''; filter(); e.stopPropagation(); } });

  // ---- live health strip: the same service checks the analytics page graphs, refreshed while this window is open ----
  const SVC = [['ollama', 'Language model'], ['speechHost', 'Speech'], ['mediaHost', 'Media'], ['pcHost', 'PC control'], ['ytmusic', 'YouTube Music'], ['wallpaper', 'Wallpaper']];
  const strip = document.getElementById('health'), age = document.getElementById('liveAge');
  const chips = new Map(), last = new Map();
  for (const [id, label] of SVC) {
    const c = document.createElement('div'), d = document.createElement('i'), t = document.createElement('span'), s = document.createElement('small');
    c.className = 'svc'; d.className = 'hud-dot off'; t.textContent = label; s.textContent = '…';
    c.append(d, t, s); strip.append(c); chips.set(id, { c, d, s });
  }
  async function pollHealth() {
    if (document.hidden || !window.jarvis?.settings?.health) return;
    try {
      const h = await window.jarvis.settings.health();
      for (const [id] of SVC) {
        const v = h[id], { c, d, s } = chips.get(id), key = v === undefined ? 'idle' : v ? 'up' : 'down';
        d.className = 'hud-dot ' + (key === 'up' ? 'hud-pulse' : key === 'down' ? 'crit' : 'off');
        s.textContent = key === 'up' ? 'up' : key === 'down' ? 'down' : 'not in use';
        c.classList.toggle('down', key === 'down');
        if (last.has(id) && last.get(id) !== key) { c.classList.remove('hud-flash'); void c.offsetWidth; c.classList.add('hud-flash'); }
        last.set(id, key);
      }
      age.textContent = 'updated ' + new Date().toLocaleTimeString();
    } catch { age.textContent = 'unavailable'; }
  }
  pollHealth(); setInterval(pollHealth, 5000);
  document.addEventListener('visibilitychange', pollHealth);

  if (window.HUD) window.HUD.reveal(document);
  spy();
})();
