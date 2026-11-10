// JARVIS for YouTube Music: background worker.
// Connects to JARVIS on this PC (ws://127.0.0.1:47830-47832/ytmusic), receives commands
// { id, cmd, args } and runs them in your YouTube Music tab (one tab, reused; opened only if none exists).
// Only the fixed command set in page.js can run; JARVIS cannot send code.
import { ytm } from './page.js';

const PORTS = [47830, 47831, 47832];
const HOME = 'https://music.youtube.com/';
const NEEDS_TAB = new Set(['search', 'play', 'enqueue']);   // these open YouTube Music if it is closed
const VERSION = chrome.runtime.getManifest().version;

let ws = null;
let connecting = false;
let keepalive = null;
const status = { connected: false, port: null, lastError: null, lastCommand: null, at: null };

function save() { chrome.storage.session.set({ status: { ...status, at: Date.now() } }).catch(() => {}); }

function open(port) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}/ytmusic`);
    const t = setTimeout(() => { try { s.close(); } catch { /* closing */ } reject(new Error('timeout')); }, 1500);
    s.onopen = () => { clearTimeout(t); resolve(s); };
    s.onerror = () => { clearTimeout(t); reject(new Error('refused')); };
  });
}

async function connect() {
  if (ws || connecting) return;
  connecting = true;
  try {
    for (const port of PORTS) {
      try { ws = await open(port); status.port = port; break; } catch { /* next port */ }
    }
  } finally { connecting = false; }
  if (!ws) { status.connected = false; status.lastError = 'JARVIS is not running'; save(); return; }
  status.connected = true; status.lastError = null; save();
  const sock = ws;
  sock.onmessage = e => onMessage(sock, e.data);
  sock.onclose = () => {
    if (ws === sock) ws = null;
    clearInterval(keepalive);
    status.connected = false; save();
    setTimeout(connect, 3000);
  };
  send(sock, { type: 'hello', version: VERSION });
  // traffic every 20 s keeps this worker alive while JARVIS is connected (Chrome 116+)
  clearInterval(keepalive);
  keepalive = setInterval(() => send(sock, { type: 'ping' }), 20000);
}

function send(sock, msg) { try { sock.send(JSON.stringify(msg)); } catch { /* closed */ } }

async function onMessage(sock, data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (msg.type === 'ping') return send(sock, { type: 'pong' });
  if (!msg.id || !msg.cmd) return;
  status.lastCommand = msg.cmd; save();
  try {
    const result = await run(msg.cmd, msg.args || {});
    send(sock, { id: msg.id, ok: true, result });
  } catch (err) {
    status.lastError = String(err?.message || err); save();
    send(sock, { id: msg.id, ok: false, error: String(err?.message || err) });
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

// ---- lifecycle: connect on start, retry every 30 s (also wakes a sleeping worker) ----
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('jarvis-reconnect', { periodInMinutes: 0.5 }); connect(); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'jarvis-reconnect') connect(); });
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m?.type === 'reconnect') { connect().then(() => reply({ ...status })); return true; }
  if (m?.type === 'status') { reply({ ...status }); return false; }
  return false;
});
chrome.alarms.get('jarvis-reconnect').then(a => { if (!a) chrome.alarms.create('jarvis-reconnect', { periodInMinutes: 0.5 }); });
connect();
