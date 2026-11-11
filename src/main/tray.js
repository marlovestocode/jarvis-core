// Tray icon + menu. Tooltip lists hotkeys that could not be registered.
const path = require('node:path');
const { Tray, Menu, nativeImage } = require('electron');

function tooltipText(failed) {
  return failed.length ? `JARVIS Core — hotkey taken: ${failed.join(', ')}` : 'JARVIS Core';
}

function createTray({ openChat, talk, openSettings, copyLinkKey, openWebLog, quit }) {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'tray.png'));
  const tray = new Tray(icon);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open chat', click: openChat },
    { label: 'Talk', click: talk },
    { label: 'Settings', click: openSettings },
    { label: 'Copy extension link key', click: copyLinkKey },
    { label: 'Web activity log', click: openWebLog },
    { type: 'separator' },
    { label: 'Quit', click: quit },
  ]));
  tray.on('click', openChat);
  tray.setToolTip(tooltipText([]));
  return {
    setFailed(failed) { tray.setToolTip(tooltipText(failed)); },
    // balloon fallback when Windows toasts are unavailable (proactive alerts)
    displayBalloon(o) { tray.displayBalloon({ iconType: 'info', ...o }); },
    destroy() { tray.destroy(); },
  };
}

module.exports = { createTray, tooltipText };
