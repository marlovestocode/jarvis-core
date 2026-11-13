// JARVIS for YouTube Music: background worker.
// Connects to JARVIS on this PC (ws://127.0.0.1:47830-47832/ytmusic), receives commands
// { id, cmd, args } and runs them in your YouTube Music tab (one tab, reused; opened only if none exists).
// Only the fixed command sets in page.js (YouTube Music) and browser.js (tabs, page text, history...) can run;
// JARVIS cannot send code. Everything it does is written to an activity list you can read in the popup.
import { ytm } from './page.js';
import { browserCommand } from './browser.js';
import { backoff, createQueue, describeArgs, pushRing } from './util.js';

const PORTS = [47830, 47831, 47832];   // the same list as src/core/media/ytmusic-link.js (test/ext-link-sync.test.js keeps them equal)
const HOME = 'https://music.youtube.com/';
const NEEDS_TAB = new Set(['search', 'play', 'enqueue', 'playlists', 'playlist', 'playlist_edit']);   // these open YouTube Music if it is closed
const VERSION = chrome.runtime.getManifest().version;

const PING_MS = 20000;          // traffic keeps this worker alive while JARVIS is connected (Chrome 116+) and proves the link is up
const SILENT_MS = 50000;        // nothing heard for this long (JARVIS answers every ping): the socket is half-open, replace it
const STABLE_MS = 30000;        // a link that stayed up this long resets the retry delay
const PENDING_MAX = 5000;
const ACTIVITY_MAX = 100;

let ws = null;
let connecting = false;
let keepalive = null;
let lastRx = 0, upSince = 0;
const status = { connected: false, port: null, lastError: null, lastCommand: null, at: null, retryInMs: null, attempt: 0 };
const storage = createQueue();   // every read-modify-write of chrome.storage goes through here, one at a time

// ---- activity: what JARVIS and this extension did, newest last; kept for the popup and shown as a badge ----
let activity = [];
let badgeTimer = null;
function record(kind, text, ok = true, extra = {}) {
  const entry = { at: Date.now(), kind, text: String(text).slice(0, 120), ok, ...extra };
  activity = pushRing(activity, entry, ACTIVITY_MAX);
  storage(() => chrome.storage.session.set({ activity })).catch(() => {});
  try {
    chrome.action.setBadgeBackgroundColor({ color: ok ? '#1f9d6a' : '#c0392b' });
    chrome.action.setBadgeText({ text: ok ? '•' : '!' });
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => { try { chrome.action.setBadgeText({ text: '' }); } catch { /* worker stopping */ } }, 4000);
  } catch { /* no action API in this context */ }
}
const loadActivity = chrome.storage.session.get('activity').then(v => { if (Array.isArray(v.activity)) activity = [...v.activity, ...activity].slice(-ACTIVITY_MAX); }, () => {});

// ---- connection ----
// Retry delay doubles from 2 s to 30 s with jitter. It goes back to 2 s only after a link that lasted, so a server that
// accepts and then drops us is not hammered every 2 s. The 30 s alarm below is the backup that also wakes a sleeping worker.
let retryTimer = null;
function scheduleRetry() {
  if (retryTimer) return;
  const wait = backoff(status.attempt++);
  status.retryInMs = wait; save();
  retryTimer = setTimeout(() => { retryTimer = null; status.retryInMs = null; connect(); }, wait);
}

function save() { chrome.storage.session.set({ status: { ...status, at: Date.now() } }).catch(() => {}); }

function open(port) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}/ytmusic`);
    const t = setTimeout(() => { try { s.close(); } catch { /* closing */ } reject(new Error('timeout')); }, 1500);
    s.onopen = () => { clearTimeout(t); resolve(s); };
    s.onerror = () => { clearTimeout(t); reject(new Error('refused')); };
  });
}

async function hmac(key, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Whatever listens on these local ports is trusted only after it proves it knows the link key (JARVIS tray menu →
// "Copy extension link key", pasted into this popup): it answers a challenge, we answer with a proof naming the port
// we dialled, and it must send back a proof of its own. Until then nothing it says is read and nothing is sent to it.
function authenticate(sock, key, port) {
  return new Promise((resolve, reject) => {
    const fail = msg => { clearTimeout(timer); sock.onmessage = null; reject(new Error(msg)); };
    const timer = setTimeout(() => fail('JARVIS did not prove the link key'), 5000);
    const nonce = crypto.randomUUID().replaceAll('-', '');
    let challenge = null;
    sock.onmessage = async e => {
      let m; try { m = JSON.parse(e.data); } catch { return fail('bad reply'); }
      try {
        if (!challenge) {
          if (m.type !== 'challenge' || typeof m.nonce !== 'string') return fail('This is not a JARVIS that uses a link key');
          challenge = m.nonce;
          send(sock, { type: 'hello', version: VERSION, nonce, proof: await hmac(key, `ext|${port}|${challenge}`) });
        } else if (m.type === 'auth' && m.proof === await hmac(key, `srv|${port}|${challenge}|${nonce}`)) {
          clearTimeout(timer); sock.onmessage = null; resolve();
        } else fail('The link key does not match');
      } catch { fail('handshake failed'); }
    };
  });
}

async function connect() {
  if (ws || connecting) return;
  connecting = true;
  let sock = null, key = '';
  let lastErr = null;
  try {
    try { key = String((await chrome.storage.local.get('linkKey')).linkKey || '').trim(); } catch { /* storage unavailable */ }
    if (!key) { status.connected = false; status.lastError = 'Paste the link key from the JARVIS tray menu below, then press Reconnect.'; save(); return; }
    // the three ports are tried together, so a dead one does not cost 1.5 s each
    const tries = await Promise.allSettled(PORTS.map(async port => {
      const s = await open(port);
      try { await authenticate(s, key, port); return { s, port }; } catch (err) { try { s.close(); } catch { /* closing */ } throw err; }
    }));
    const winner = tries.find(t => t.status === 'fulfilled');
    if (winner) {
      sock = winner.value.s; status.port = winner.value.port;
      for (const t of tries) if (t.status === 'fulfilled' && t !== winner) { try { t.value.s.close(); } catch { /* closing */ } }
    } else {
      lastErr = tries.map(t => t.reason?.message).find(m => m && m !== 'refused' && m !== 'timeout') || null;   // a key problem is worth showing; "refused" only means JARVIS is off
    }
  } finally { connecting = false; }
  if (!sock) { status.connected = false; status.lastError = lastErr || 'JARVIS is not running'; save(); scheduleRetry(); return; }
  ws = sock;
  lastRx = upSince = Date.now();
  status.connected = true; status.lastError = null; status.retryInMs = null; save();
  record('link', `Connected to JARVIS (port ${status.port})`);
  sock.onmessage = e => { lastRx = Date.now(); onMessage(sock, e.data); };
  sock.onerror = () => { /* onclose follows and handles it */ };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    clearInterval(keepalive);
    status.connected = false;
    if (Date.now() - upSince >= STABLE_MS) status.attempt = 0;   // it was a real link: start the delays over
    save();
    record('link', 'Disconnected from JARVIS', false);
    scheduleRetry();
  };
  flushPending(sock);
  clearInterval(keepalive);
  keepalive = setInterval(() => {
    if (Date.now() - lastRx > SILENT_MS) { record('link', 'JARVIS stopped answering; reconnecting', false); try { sock.close(); } catch { /* closing */ } return; }
    if (Date.now() - upSince >= STABLE_MS) status.attempt = 0;
    send(sock, { type: 'ping' });
  }, PING_MS);
}

// send → true when the frame was handed to an open socket
function send(sock, msg) {
  try { if (!sock || sock.readyState !== 1) return false; sock.send(JSON.stringify(msg)); return true; } catch { return false; }
}

// plays heard while JARVIS is not running wait in chrome.storage.local (this browser profile only) and are sent when it connects
function flushPending(sock) {
  return storage(async () => {
    const { pending = [] } = await chrome.storage.local.get('pending');
    if (!pending.length) return;
    let sent = 0;
    for (let i = 0; i < pending.length; i += 200) { if (!send(sock, { type: 'plays', events: pending.slice(i, i + 200) })) break; sent = Math.min(pending.length, i + 200); }
    // only what was handed to the socket leaves the list; anything after a failed send stays for the next connect
    await chrome.storage.local.set({ pending: pending.slice(sent) });
  }).catch(() => { /* storage unavailable: nothing to flush */ });
}

function onPlay(event) {
  if (ws && status.connected && send(ws, { type: 'play', event })) return Promise.resolve();
  return storage(async () => {
    const { pending = [] } = await chrome.storage.local.get('pending');
    pending.push(event);
    await chrome.storage.local.set({ pending: pending.slice(-PENDING_MAX) });
  }).catch(() => { /* storage full or unavailable: this play is lost */ });
}

async function onMessage(sock, data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (msg.type === 'ping') { send(sock, { type: 'pong' }); return; }
  if (msg.type === 'pong') return;
  if (!msg.id || !msg.cmd) return;
  status.lastCommand = msg.cmd; save();
  const t0 = Date.now();
  const what = `${msg.cmd}${describeArgs(msg.args) ? ' · ' + describeArgs(msg.args) : ''}`;
  try {
    const result = await run(msg.cmd, msg.args || {});
    record('command', what, true, { ms: Date.now() - t0 });
    send(sock, { id: msg.id, ok: true, result });
  } catch (err) {
    const text = String(err?.message || err);
    status.lastError = text; save();
    record('command', `${what} failed: ${text}`, false, { ms: Date.now() - t0 });
    send(sock, { id: msg.id, ok: false, error: text });
  }
}

// ---- the YouTube Music tab ----
async function findTab() {
  const tabs = await chrome.tabs.query({ url: 'https://music.youtube.com/*' });
  if (!tabs.length) return null;
  return tabs.find(t => t.audible) || tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

function waitComplete(tabId, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { chrome.tabs.onUpdated.removeListener(on); reject(new Error('YouTube Music took too long to load')); }, ms);
    function on(id, info) { if (id === tabId && info.status === 'complete') { clearTimeout(t); chrome.tabs.onUpdated.removeListener(on); resolve(); } }
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(tabId).then(tab => { if (tab.status === 'complete') on(tabId, { status: 'complete' }); }, () => {});
  });
}

async function ready(tabId) {
  for (let i = 0; i < 40; i++) {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => !!(window.ytcfg?.get && document.querySelector('ytmusic-app') && document.querySelector('#movie_player')) }).catch(() => [{ result: false }]);
    if (r?.result) return;
    await new Promise(r2 => setTimeout(r2, 250));
  }
  throw new Error('YouTube Music did not finish loading');
}

async function tabFor(cmd) {
  let tab = await findTab();
  if (!tab) {
    if (!NEEDS_TAB.has(cmd)) return null;
    tab = await chrome.tabs.create({ url: HOME, active: false });
  } else if (tab.discarded) {
    await chrome.tabs.reload(tab.id);   // Chrome's memory saver unloaded it
  }
  await waitComplete(tab.id);
  await ready(tab.id);
  return tab;
}

async function run(cmd, args) {
  if (cmd === 'hello') return { version: VERSION };
  if (typeof cmd === 'string' && cmd.startsWith('browser_')) return browserCommand(cmd, args, chrome);   // fixed switch in browser.js; optional permissions
  if (cmd === 'tab') {   // bring the YouTube Music tab to the front
    const tab = await tabFor('play');
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { tabId: tab.id };
  }
  const tab = await tabFor(cmd);
  if (!tab) return { noTab: true };
  const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: ytm, args: [cmd, args] });
  const out = r?.result;
  if (!out) throw new Error('No answer from the YouTube Music tab');
  if (!out.ok) throw new Error(out.error);
  return { ...out.result, tabId: tab.id };
}

// ---- keeping the music going (keepalive.js reports each prompt it confirmed or refused) ----
function onPrompt(m, tabId) {
  const kind = m.kind === 'age-confirm' ? 'age notice' : 'still-listening prompt';
  if (m.type === 'prompt-confirmed') record('prompt', `Confirmed the ${kind} ("${String(m.label).slice(0, 40)}")`, true, { tabId });
  else record('prompt', `Left the ${kind} alone: ${String(m.reason).slice(0, 60)}`, false, { tabId });
  if (ws && status.connected) send(ws, { type: 'prompt', kind: m.kind, confirmed: m.type === 'prompt-confirmed', label: String(m.label || '').slice(0, 60), reason: String(m.reason || '').slice(0, 60), at: Date.now() });
}

// ---- lifecycle: connect on start, retry every 30 s (also wakes a sleeping worker) ----
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('jarvis-reconnect', { periodInMinutes: 0.5 }); connect(); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'jarvis-reconnect') { if (!ws) { status.attempt = Math.min(status.attempt, 2); } connect(); } });
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m?.type === 'set-key') { chrome.storage.local.set({ linkKey: String(m.key || '').trim() }).then(() => { try { ws?.close(); } catch { /* closing */ } ws = null; status.attempt = 0; return connect(); }).then(() => reply({ ...status })); return true; }
  if (m?.type === 'play-log') { onPlay(m.event); return false; }
  if (m?.type === 'reconnect') { status.attempt = 0; clearTimeout(retryTimer); retryTimer = null; connect().then(() => reply({ ...status })); return true; }
  if (m?.type === 'status') { reply({ ...status }); return false; }
  if (m?.type === 'activity') { loadActivity.then(() => reply(activity)); return true; }
  if ((m?.type === 'prompt-confirmed' || m?.type === 'prompt-skipped') && sender?.url?.startsWith('https://music.youtube.com/')) { onPrompt(m, sender.tab?.id); return false; }
  return false;
});
chrome.alarms.get('jarvis-reconnect').then(a => { if (!a) chrome.alarms.create('jarvis-reconnect', { periodInMinutes: 0.5 }); });
connect();
