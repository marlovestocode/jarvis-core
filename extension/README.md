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
8. Right-click the JARVIS tray icon → **Copy extension link key**, click the extension icon, paste the key, and press **Save key and connect**. (JARVIS and the extension prove they hold this key to each other; nothing on this PC without it can drive the extension. Needed once per browser profile, and again if you delete `link.key` in the JARVIS data folder.)
9. **JARVIS link: connected** in the popup means it works.

Sign in to YouTube Music in Chrome as usual. Likes need a signed-in account.

## Say or type

- "play blinding lights by the weeknd", "play the album american idiot", "play some lofi"
- "play mr brightside next", "add take on me to the queue"
- "what's up next?", "remove the next song", "clear the queue"
- "repeat this song", "repeat off", "shuffle"
- "like this song", "thumbs down"
- Pause, skip, seek, volume and "what's playing" work as before.

## Your playlists (version 1.1.0)

- "what playlists do I have?", "what's in my gym playlist?", "show more" (JARVIS reads them live from your library).
- Needs the extension reloaded after updating (`chrome://extensions` → reload arrow) and you signed in to YouTube Music.
- "play my gym playlist", "shuffle my chill playlist", "play stronger from my gym playlist", "play my liked songs".
- If two playlists fit, JARVIS asks which one ("the second one" works). A loose phrase like "play the rock playlist" tries your library first, then YouTube Music search; "my" means your library only.
- "add this to gym" (the song that's playing), "add this song" (JARVIS asks which playlist), "add stronger by kanye west to my gym playlist", "undo".
- JARVIS skips songs already in the playlist, asks when a song name fits two songs, and only says it's done after reading the playlist back. Needs extension version 1.2.0 (reload it).
- Removing, moving and renaming come next.

## Good to know

- One tab: JARVIS uses your open YouTube Music tab. It opens one in the background only if none is open.
- Autoplay: if Chrome blocks it, JARVIS says so. Press play once in the tab; after that it plays on its own.
- Shuffle: YouTube Music shuffles the queue once. There is no shuffle mode to turn off.
- Updating: after JARVIS updates this folder, click the reload arrow on the extension card.

## Troubleshooting

- **Not connected**: JARVIS isn't running, or it is an older version. Restart JARVIS, then click **Reconnect** in the popup. "Link key does not match" or "Paste the link key": copy the key again from the tray menu and save it in the popup.
- **Wrong ID**: don't edit `manifest.json`. The `key` in it sets the ID JARVIS trusts.
- **Remove it**: `chrome://extensions` → Remove. JARVIS keeps working without it (no song search or queue).

## Listening log (version 1.3.0)

While a YouTube Music tab is open, the extension notes each track you play: title, artist, album, when, how long you actually heard it, how far you got, seeks, whether it ended, was skipped or was replayed, the playlist it came from, and your like state.
Each finished play goes to JARVIS on this PC (`music-plays.jsonl` in the JARVIS data folder). Plays heard while JARVIS is closed wait in this browser profile (up to 5000) and are sent when JARVIS connects.
Nothing leaves your computer. Turn it off in JARVIS settings ("Log what I listen to").

After updating: open `chrome://extensions`, click the reload icon on the JARVIS card, then refresh the YouTube Music tab.
Ask JARVIS: "what are my top artists this month?", "how often do I skip $uicideboy$?", "when do I listen most?", "how has my taste changed?", "what did I replay this week?".

## Browser control (version 1.4.0, off by default)

JARVIS can also list, switch, open, close and pin your tabs, run a search, read the text of a page, and look
through your downloads, history and bookmarks. This is **off** until you turn it on in two places:

1. JARVIS settings: the **Browser control** switch.
2. This extension's popup: **Allow** each permission you want. Chrome asks every time; **Remove** takes one back.
   History, bookmarks, downloads, searching and "read page text (all sites)" are optional permissions, so nothing
   beyond YouTube Music is requested at install.

JARVIS only sends a command name and plain arguments (`browser_tabs`, `browser_tab_open { url }`, ...). It never
sends code: the commands are a fixed list in `browser.js`, every argument is checked, only `http`/`https` addresses
open, and page text is returned as quoted text that JARVIS treats as untrusted. Reload the extension in
`chrome://extensions` after updating.
