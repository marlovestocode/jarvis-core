// Chat overlay (frameless glass panel, bottom-center) and settings window.
const path = require('node:path');
const { app, BrowserWindow, screen } = require('electron');

const UI = path.join(__dirname, '..', 'ui');
const PRELOAD = path.join(__dirname, 'preload.js');
const CHAT_W = 760;
const CHAT_H = 520;

const webPrefs = { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true };

function createWindows({ hideOnBlur = true } = {}) {
  let chat = null;
  let settings = null;
  let shownAt = 0;

  function placeChat() {
    const { workArea } = screen.getPrimaryDisplay();
    const x = Math.round(workArea.x + (workArea.width - CHAT_W) / 2);
    const y = Math.round(workArea.y + workArea.height - CHAT_H - 48);
    chat.setBounds({ x, y, width: CHAT_W, height: CHAT_H });
  }

  function ensureChat() {
    if (chat && !chat.isDestroyed()) return chat;
    chat = new BrowserWindow({
      width: CHAT_W, height: CHAT_H, show: false, frame: false, transparent: true, resizable: false,
      skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#00000000', title: 'JARVIS',
      webPreferences: webPrefs,
    });
    chat.setMenu(null);
    chat.loadFile(path.join(UI, 'chat.html'));
    // Opened from the wallpaper or a hotkey, Windows may hand focus back for a moment: ignore
    // blur right after showing, or the chat would vanish the instant it appears.
    chat.on('blur', () => {
      if (Date.now() - shownAt < 1200) return;
      if (hideOnBlur && !chat.webContents.isDevToolsOpened()) chat.hide();
    });
    return chat;
  }

  function showChat() {
    ensureChat();
    placeChat();
    shownAt = Date.now();
    chat.show();
    // a background app may not take focus on Windows; ask for it so typing works at once
    try { app.focus({ steal: true }); } catch { /* older Electron */ }
    chat.moveTop();
    chat.focus();
    chat.webContents.send('ai:shown');
  }

  function hideChat() { if (chat && !chat.isDestroyed()) chat.hide(); }

  function toggleChat() {
    if (chat && !chat.isDestroyed() && chat.isVisible()) hideChat();
    else showChat();
  }

  function showSettings() {
    if (settings && !settings.isDestroyed()) { settings.show(); settings.focus(); return settings; }
    settings = new BrowserWindow({
      width: 560, height: 640, show: false, frame: false, transparent: true, resizable: false,
      backgroundColor: '#00000000', title: 'JARVIS Settings', webPreferences: webPrefs,
    });
    settings.setMenu(null);
    settings.loadFile(path.join(UI, 'settings.html'));
    settings.once('ready-to-show', () => settings.show());
    return settings;
  }

  function sendAll(channel, payload) {
    for (const w of [chat, settings]) {
      if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
    }
  }

  return {
    ensureChat, showChat, hideChat, toggleChat, showSettings, sendAll,
    get chat() { return chat; },
    get settings() { return settings; },
  };
}

module.exports = { createWindows };
