// Keeps the music playing through YouTube Music's interruptions (content script, isolated world, after prompts.js).
// It confirms only what prompts.js allows: "Continue watching?" and content-warning notices the signed-in account may accept.
// It never signs in, verifies an age, or clicks anything that asks for personal data.
// How it notices: a MutationObserver on added/removed nodes (rate limited), the player's own pause event, and a slow fallback
// scan, so a dialog shown by a style change or an unknown element still gets found. Each click is reported to the worker,
// which writes it to the visible activity list. Off switch: chrome.storage.local.autoConfirm = false (popup).
(() => {
  if (window.__jarvisKeepalive) return;
  window.__jarvisKeepalive = true;
  const P = self.JarvisPrompts;
  if (!P) return;

  const DIALOGS = ['ytmusic-you-there-renderer', 'yt-confirm-dialog-renderer', 'ytmusic-confirm-dialog-renderer', 'tp-yt-paper-dialog', 'ytmusic-popup-container',
    'ytd-popup-container', 'yt-player-error-message-renderer', 'ytmusic-player-error-message-renderer', '[role="dialog"]', '[role="alertdialog"]', 'dialog[open]'].join(',');
  const BUTTONS = 'button, [role="button"], tp-yt-paper-button, yt-button-renderer';
  const FALLBACK_MS = 10000, MIN_GAP_MS = 400, MAX_CLICKS = 4, WINDOW_MS = 60000;

  let enabled = true, timer = null, lastScan = 0;
  const clicks = [], skipsSent = new Map();
  try { chrome.storage.local.get('autoConfirm').then(v => { enabled = v.autoConfirm !== false; }, () => {}); } catch { /* extension reloaded */ }
  const onStorage = (c, area) => { if (area === 'local' && c.autoConfirm) enabled = c.autoConfirm.newValue !== false; };
  try { chrome.storage.onChanged.addListener(onStorage); } catch { /* extension reloaded */ }

  const visible = el => {
    if (!el || !el.isConnected || el.hidden || el.closest('[aria-hidden="true"]')) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const labelOf = el => (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim();

  function collect() {
    const out = [], seen = new Set();
    for (const el of document.querySelectorAll(DIALOGS)) {
      if (!visible(el)) continue;
      const text = (el.innerText || '').trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      const els = [...el.querySelectorAll(BUTTONS)].filter(visible);
      out.push({ text, buttons: els.map(b => ({ label: labelOf(b) })), els });
    }
    return out;
  }

  const send = msg => { try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch { /* extension reloaded: this page needs a refresh */ } };

  function scan() {
    timer = null; lastScan = Date.now();
    if (!enabled) return;
    let r, el = null;
    try {
      const dialogs = collect();
      r = P.decide(dialogs);
      if (r && !r.skip) el = dialogs.find(x => x.buttons.some(b => b.label === r.label))?.els[r.index] || null;
    } catch { return; }
    if (!r) return;
    if (r.skip) {   // said once a minute per reason, never clicked
      const key = r.kind + r.skip;
      if (Date.now() - (skipsSent.get(key) || 0) > WINDOW_MS) { skipsSent.set(key, Date.now()); send({ type: 'prompt-skipped', kind: r.kind, reason: r.skip, at: Date.now() }); }
      return;
    }
    const now = Date.now();
    while (clicks.length && now - clicks[0] > WINDOW_MS) clicks.shift();
    if (clicks.length >= MAX_CLICKS) { send({ type: 'prompt-skipped', kind: r.kind, reason: 'too many in a minute', at: now }); return; }   // a loop: stop, do not fight the page
    if (!el) return;
    clicks.push(now);
    (el.querySelector('button') || el).click();
    send({ type: 'prompt-confirmed', kind: r.kind, label: r.label, at: now });
  }

  // run at most once per MIN_GAP_MS, on the trailing edge, so a busy page costs one scan, not one per mutation
  function schedule() {
    if (timer || !enabled) return;
    timer = setTimeout(scan, Math.max(50, MIN_GAP_MS - (Date.now() - lastScan)));
  }

  const mo = new MutationObserver(schedule);
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'aria-hidden'] });
  document.addEventListener('pause', schedule, true);          // the player stopped: look now
  const fallback = setInterval(schedule, FALLBACK_MS);
  addEventListener('pagehide', () => {
    mo.disconnect(); clearInterval(fallback); clearTimeout(timer);
    document.removeEventListener('pause', schedule, true);
    try { chrome.storage.onChanged.removeListener(onStorage); } catch { /* gone */ }
  });
  schedule();
})();
