const $ = id => document.getElementById(id);

function show(s = {}) {
  $('link').textContent = s.connected ? `connected (port ${s.port})` : 'not connected';
  $('link').className = s.connected ? 'ok' : 'bad';
  $('cmd').textContent = s.lastCommand || '–';
  $('err').textContent = s.connected ? '' : (s.lastError || 'Start JARVIS, then press Reconnect.');
}

async function refresh() {
  chrome.runtime.sendMessage({ type: 'status' }, s => show(s));
  const tabs = await chrome.tabs.query({ url: 'https://music.youtube.com/*' });
  $('tab').textContent = tabs.length ? 'open' : 'opens when needed';
  $('tab').className = tabs.length ? 'ok' : '';
}

$('retry').addEventListener('click', () => {
  $('link').textContent = 'connecting…';
  chrome.runtime.sendMessage({ type: 'reconnect' }, s => { show(s); refresh(); });
});
refresh();
