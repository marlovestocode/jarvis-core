// Runs in the YouTube Music page (MAIN world) after tracker.js (same content-script group).
// Once a second it reads the page's own player, feeds the tracker, and posts each finished play to
// logger-relay.js (isolated world), which hands it to the background worker. Reads only; changes nothing.
(() => {
  if (window.__jarvisLogger) return;
  window.__jarvisLogger = true;
  const runs = t => (t?.runs || []).map(r => r.text).join('') || t?.simpleText || '';
  const pageType = r => r?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;

  const tracker = createTracker({ emit: event => window.postMessage({ __jarvisYtm: 'play', event }, location.origin) });

  function sample() {
    try {
      const player = document.querySelector('#movie_player');
      if (!player?.getVideoData) return null;
      const d = player.getVideoData() || {};
      if (!d.video_id) return null;
      let artist = '', album = '', title = d.title || '';
      try {
        const st = document.querySelector('ytmusic-player-queue')?.getState?.()?.queue;
        const panel = it => it?.playlistPanelVideoRenderer || it?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
        const cur = st ? panel(st.items[st.selectedItemIndex]) || st.items.map(panel).find(p => p?.selected) : null;
        if (cur && cur.videoId === d.video_id) {
          const by = cur.longBylineText?.runs || [];
          artist = by.filter(r => pageType(r) === 'MUSIC_PAGE_TYPE_ARTIST').map(r => r.text).join(', ');
          album = by.find(r => pageType(r) === 'MUSIC_PAGE_TYPE_ALBUM')?.text || '';
          title = runs(cur.title) || title;
        }
      } catch { /* queue not ready: fall back to the player data */ }
      if (!artist) artist = String(d.author || '').replace(/ - Topic$/, '');
      return {
        videoId: d.video_id, title, artist, album, state: player.getPlayerState(), time: player.getCurrentTime() || 0, duration: player.getDuration() || 0,
        list: new URLSearchParams(location.search).get('list') || null,
        like: document.querySelector('ytmusic-player-bar ytmusic-like-button-renderer')?.getAttribute('like-status') || null,
      };
    } catch { return null; }
  }

  setInterval(() => tracker.tick(sample()), 1000);
  addEventListener('pagehide', () => tracker.flush());
})();
