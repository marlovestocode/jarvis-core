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

// ---- Browser control: optional permissions, requested from a click (Chrome requires a user gesture) ----
const PERMS = [
  { id: 'tabs-note', label: 'Tabs (always on)', fixed: true },
  { id: 'history', label: 'Browsing history', req: { permissions: ['history'] } },
  { id: 'bookmarks', label: 'Bookmarks', req: { permissions: ['bookmarks'] } },
  { id: 'downloads', label: 'Downloads list', req: { permissions: ['downloads'] } },
  { id: 'search', label: 'Run searches', req: { permissions: ['search'] } },
  { id: 'page', label: 'Read page text (all sites)', req: { origins: ['<all_urls>'] } },
];

async function drawPerms() {
  const box = $('perms');
  box.textContent = '';
  for (const p of PERMS) {
    const row = document.createElement('div');
    row.className = 'perm';
    const name = document.createElement('span');
    name.textContent = p.label;
    row.append(name);
    if (!p.fixed) {
      const on = await chrome.permissions.contains(p.req);
      const b = document.createElement('button');
      b.textContent = on ? 'Remove' : 'Allow';
      b.addEventListener('click', async () => {
        try { if (on) await chrome.permissions.remove(p.req); else await chrome.permissions.request(p.req); } catch { /* declined */ }
        drawPerms();
      });
      row.append(b);
    }
    box.append(row);
  }
}
drawPerms();
