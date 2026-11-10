# JARVIS for YouTube Music

Lets JARVIS search, play and queue music in your YouTube Music tab in Chrome.
It talks only to JARVIS on this PC (`127.0.0.1:47830`), and JARVIS accepts only this extension.

## Install (once, about 2 minutes)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Pick this folder: `C:\Users\gdani\Projects\Apps\jarvis-core\extension`
5. Check the card says **JARVIS for YouTube Music** with ID `kekfpeebafdohogkjmlnakddhbpednea`.
6. Click the puzzle icon in the toolbar and pin the extension (optional, shows status).
7. Restart JARVIS (tray icon → Quit, then start it again) so it opens the link.
8. Click the extension icon: **JARVIS link: connected** means it works.

Sign in to YouTube Music in Chrome as usual. Likes need a signed-in account.

## Say or type

- "play blinding lights by the weeknd", "play the album american idiot", "play some lofi"
- "play mr brightside next", "add take on me to the queue"
- "what's up next?", "remove the next song", "clear the queue"
- "repeat this song", "repeat off", "shuffle"
- "like this song", "thumbs down"
- Pause, skip, seek, volume and "what's playing" work as before.

## Good to know

- One tab: JARVIS uses your open YouTube Music tab. It opens one in the background only if none is open.
- Autoplay: if Chrome blocks it, JARVIS says so. Press play once in the tab; after that it plays on its own.
- Shuffle: YouTube Music shuffles the queue once. There is no shuffle mode to turn off.
- Updating: after JARVIS updates this folder, click the reload arrow on the extension card.

## Troubleshooting

- **Not connected**: JARVIS isn't running, or it is an older version. Restart JARVIS, then click **Reconnect** in the popup.
- **Wrong ID**: don't edit `manifest.json`. The `key` in it sets the ID JARVIS trusts.
- **Remove it**: `chrome://extensions` → Remove. JARVIS keeps working without it (no song search or queue).
