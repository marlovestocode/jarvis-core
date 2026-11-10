// Isolated-world relay: the page (MAIN world) cannot call chrome.runtime, so logger-main.js posts here.
// Only messages from this same page, with our marker, are passed on to the background worker.
addEventListener('message', e => {
  if (e.source !== window || e.origin !== location.origin) return;
  const m = e.data;
  if (!m || m.__jarvisYtm !== 'play' || !m.event || typeof m.event.videoId !== 'string') return;
  try { chrome.runtime.sendMessage({ type: 'play-log', event: m.event }).catch(() => {}); } catch { /* extension reloaded: this page needs a refresh */ }
});
