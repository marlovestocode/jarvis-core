// Runs inside the YouTube Music page (main world) via chrome.scripting.executeScript.
// Must be self-contained: no imports, no outside variables. Uses the page's own player,
// queue store and InnerTube API (same origin, the user's own session).
// ytm(cmd, args) → { ok: true, result } | { ok: false, error }.
export async function ytm(cmd, args = {}) {
  try { return { ok: true, result: await run() }; } catch (err) { return { ok: false, error: String(err?.message || err) }; }
  async function run() {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const $ = s => document.querySelector(s);
  const app = $('ytmusic-app');
  const player = $('#movie_player');
  const queueEl = $('ytmusic-player-queue');
  const runs = t => (t?.runs || []).map(r => r.text).join('') || t?.simpleText || '';
  const ytcfg = window.ytcfg;
  if (!app || !ytcfg?.get) throw new Error('YouTube Music is still loading');

  async function innertube(path, body) {
    const r = await fetch(`/youtubei/v1/${path}?prettyPrint=false`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: ytcfg.get('INNERTUBE_CONTEXT'), ...body }),
    });
    if (!r.ok) throw new Error(`YouTube Music answered ${r.status}`);
    return r.json();
  }

  const panel = it => it?.playlistPanelVideoRenderer || it?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
  const qstate = () => queueEl?.getState?.()?.queue;

  function nowPlaying() {
    if (!player?.getVideoData) return null;
    const d = player.getVideoData() || {};
    if (!d.video_id) return null;
    const st = qstate();
    const cur = st ? panel(st.items[st.selectedItemIndex]) || st.items.map(panel).find(p => p?.selected) : null;
    const byline = cur ? (cur.longBylineText?.runs || []) : [];
    const artist = byline.filter(r => r.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_ARTIST').map(r => r.text).join(', ') || d.author || '';
    const album = byline.find(r => r.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_ALBUM')?.text || '';
    const like = $('ytmusic-player-bar ytmusic-like-button-renderer')?.getAttribute('like-status') || null;
    return {
      videoId: d.video_id, title: (cur && runs(cur.title)) || d.title || '', artist, album,
      state: player.getPlayerState(),   // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
      time: player.getCurrentTime(), duration: player.getDuration(), volume: player.getVolume(), muted: player.isMuted(), like,
    };
  }

  function queue() {
    const st = qstate();
    if (!st) return null;
    const item = (it, i) => { const p = panel(it); return p ? { index: i, videoId: p.videoId, title: runs(p.title), artist: runs(p.shortBylineText), duration: runs(p.lengthText), selected: !!p.selected } : null; };
    const items = st.items.map(item).filter(Boolean);
    const automix = (st.automixItems || []).map((it, i) => item(it, st.items.length + i)).filter(Boolean);
    const index = Math.max(0, items.findIndex(x => x.selected));
    return { index, items, automix: automix.slice(0, 10), repeat: st.repeatMode || null, shuffle: !!st.shuffleEnabled, autoplay: st.autoplay ?? null };
  }

  // Search results → plain candidates for ranking in JARVIS.
  function parseSearch(j) {
    const out = [];
    const sections = j?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    const pageType = r => r?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
    const meta = rs => {
      const artists = rs.filter(r => pageType(r) === 'MUSIC_PAGE_TYPE_ARTIST' || pageType(r) === 'MUSIC_PAGE_TYPE_USER_CHANNEL').map(r => r.text);
      const album = rs.find(r => pageType(r) === 'MUSIC_PAGE_TYPE_ALBUM')?.text || '';
      const duration = rs.map(r => r.text).find(t => /^\d{1,2}(:\d{2}){1,2}$/.test(t)) || '';
      const parts = rs.map(r => r.text).filter(t => t !== ' • ');
      return { artists, album, duration, kind: parts[0] || '', parts };
    };
    const menuQueue = menu => {
      const q = {};
      for (const x of menu?.menuRenderer?.items || []) {
        const v = Object.values(x)[0];
        const e = v?.serviceEndpoint?.queueAddEndpoint;
        if (e) q[e.queueInsertPosition === 'INSERT_AFTER_CURRENT_VIDEO' ? 'next' : 'end'] = e.queueTarget;
      }
      return q;
    };
    const kindOf = (k, mvt) => {
      const s = String(k).toLowerCase();
      if (/song/.test(s)) return 'song';
      if (/video/.test(s)) return 'video';
      if (/album|single|ep\b/.test(s)) return 'album';
      if (/playlist/.test(s)) return 'playlist';
      if (/artist/.test(s)) return 'artist';
      if (/episode|podcast/.test(s)) return 'episode';
      return mvt === 'MUSIC_VIDEO_TYPE_ATV' ? 'song' : mvt ? 'video' : 'other';
    };
    sections.forEach(sec => {
      const card = sec.musicCardShelfRenderer;
      if (card) {
        const t = card.title?.runs?.[0];
        const m = meta(card.subtitle?.runs || []);
        const we = t?.navigationEndpoint?.watchEndpoint;
        const play = card.buttons?.map(b => b.buttonRenderer?.command).find(c => c?.watchEndpoint || c?.watchPlaylistEndpoint) || (we ? { watchEndpoint: we } : null);
        out.push({ top: true, type: kindOf(m.kind, we?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType), title: t?.text || '', artists: m.artists, album: m.album, duration: m.duration,
          videoId: we?.videoId || null, play: play ? { watchEndpoint: play.watchEndpoint, watchPlaylistEndpoint: play.watchPlaylistEndpoint } : null, queue: menuQueue(card.menu) });
      }
      const items = [...(sec.itemSectionRenderer?.contents || []), ...(sec.musicShelfRenderer?.contents || [])];
      for (const c of items) {
        const it = c.musicResponsiveListItemRenderer;
        if (!it) continue;
        const cols = it.flexColumns.map(f => f.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []);
        const m = meta(cols.slice(1).flat());
        const ov = it.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint;
        const we = ov?.watchEndpoint || cols[0]?.[0]?.navigationEndpoint?.watchEndpoint;
        out.push({ top: false, type: kindOf(m.kind, we?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType), title: cols[0]?.map(r => r.text).join('') || '',
          artists: m.artists, album: m.album, duration: m.duration, videoId: it.playlistItemData?.videoId || we?.videoId || null,
          play: ov ? { watchEndpoint: ov.watchEndpoint, watchPlaylistEndpoint: ov.watchPlaylistEndpoint } : we ? { watchEndpoint: we } : null, queue: menuQueue(it.menu) });
      }
    });
    return out.filter(c => c.play || c.queue.next || c.queue.end);
  }

  async function settle(check, ms = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = check(); if (v) return v; await wait(200); }
    return check();
  }

  switch (cmd) {
    case 'status':
      return { url: location.href, loggedIn: !!ytcfg.get('LOGGED_IN'), playing: nowPlaying(), queue: queue() };

    case 'search': {
      const j = await innertube('search', { query: String(args.query || '').slice(0, 200) });
      return { candidates: parseSearch(j).slice(0, 25) };
    }

    case 'play': {   // args.play = { watchEndpoint } | { watchPlaylistEndpoint }, args.videoId (expected first track, optional)
      const ep = args.play?.watchEndpoint ? { watchEndpoint: args.play.watchEndpoint } : args.play?.watchPlaylistEndpoint ? { watchPlaylistEndpoint: args.play.watchPlaylistEndpoint } : null;
      if (!ep) throw new Error('Nothing to play');
      const before = player?.getVideoData?.()?.video_id;
      app.dispatchEvent(new CustomEvent('yt-navigate', { bubbles: true, composed: true, detail: { endpoint: ep } }));
      const want = args.videoId || ep.watchEndpoint?.videoId;
      const loaded = await settle(() => { const id = player.getVideoData()?.video_id; return id && (want ? id === want : id !== before) ? id : null; }, 8000);
      if (!loaded) throw new Error("YouTube Music didn't load it");
      let state = await settle(() => (player.getPlayerState() === 1 ? 1 : null), 2500);
      if (state !== 1) { player.playVideo(); state = await settle(() => (player.getPlayerState() === 1 ? 1 : null), 2500); }
      return { playing: nowPlaying(), started: state === 1 };
    }

    case 'enqueue': {   // args.target = queueTarget ({ videoId } | { playlistId }), args.position = 'next' | 'end'
      if (!queueEl) throw new Error('The queue is not available yet; play something first');
      const t = args.target || {};
      const body = t.videoId ? { videoIds: [t.videoId] } : t.playlistId ? { playlistId: t.playlistId } : null;
      if (!body) throw new Error('Nothing to queue');
      const j = await innertube('music/get_queue', body);
      const items = (j.queueDatas || []).map(d => d.content).filter(Boolean);
      if (!items.length) throw new Error("YouTube Music couldn't queue that");
      const st = qstate();
      if (!st?.items?.length) {   // empty queue: queuing = playing
        app.dispatchEvent(new CustomEvent('yt-navigate', { bubbles: true, composed: true, detail: { endpoint: t.videoId ? { watchEndpoint: { videoId: t.videoId } } : { watchPlaylistEndpoint: { playlistId: t.playlistId } } } }));
        await wait(1500);
        return { queue: queue(), added: items.length, started: true };
      }
      const cur = Math.max(0, st.items.findIndex(it => panel(it)?.selected));
      const index = args.position === 'next' ? cur + 1 : st.items.length;
      const n0 = st.items.length;
      queueEl.dispatch({ type: 'ADD_ITEMS', payload: { nextQueueItemId: st.nextQueueItemId, index, items, shuffleEnabled: false, shouldAssignIds: true } });
      const ok = await settle(() => (qstate().items.length >= n0 + items.length ? true : null), 2000);
      if (!ok) throw new Error("The queue didn't change");
      return { queue: queue(), added: items.length, at: index };
    }

    case 'remove': {   // args.index (queue index; never the current track)
      const st = qstate();
      if (!st) throw new Error('No queue');
      const cur = Math.max(0, st.items.findIndex(it => panel(it)?.selected));
      const idx = args.index;
      if (!Number.isInteger(idx) || idx < 0 || idx >= st.items.length || idx === cur) throw new Error('No such song in the queue');
      const removed = panel(st.items[idx]);
      queueEl.dispatch({ type: 'REMOVE_ITEM', payload: idx });
      await wait(300);
      return { removed: { title: runs(removed?.title), artist: runs(removed?.shortBylineText) }, queue: queue() };
    }

    case 'clear': {   // everything after the current track
      const st = qstate();
      if (!st) throw new Error('No queue');
      const cur = Math.max(0, st.items.findIndex(it => panel(it)?.selected));
      let n = 0;
      for (let i = st.items.length - 1; i > cur; i--) { queueEl.dispatch({ type: 'REMOVE_ITEM', payload: i }); n++; }
      await wait(300);
      return { removed: n, queue: queue() };
    }

    case 'repeat': {   // args.mode = 'NONE' | 'ALL' | 'ONE'
      const btn = $('ytmusic-player-bar .repeat');
      if (!btn || !qstate()) throw new Error('Repeat is not available yet');
      for (let i = 0; i < 3 && qstate().repeatMode !== args.mode; i++) { btn.click(); await wait(250); }
      if (qstate().repeatMode !== args.mode) throw new Error("Repeat didn't change");
      return { repeat: qstate().repeatMode };
    }

    case 'shuffle': {   // YouTube Music shuffles the queue once; there is no lasting shuffle mode
      const btn = $('ytmusic-player-bar .shuffle');
      if (!btn) throw new Error('Shuffle is not available yet');
      const before = qstate()?.items.map(it => panel(it)?.videoId).join();
      btn.click();
      const changed = await settle(() => (qstate()?.items.map(it => panel(it)?.videoId).join() !== before ? true : null), 2000);
      return { shuffled: !!changed, queue: queue() };
    }

    case 'like': {   // args.value = 'LIKE' | 'DISLIKE' | 'INDIFFERENT'
      const r = $('ytmusic-player-bar ytmusic-like-button-renderer');
      if (!r) throw new Error('Nothing is playing');
      if (!ytcfg.get('LOGGED_IN')) throw new Error('Sign in to YouTube Music to like songs');
      const cur = r.getAttribute('like-status');
      if (cur === args.value) return { like: cur };
      const label = args.value === 'DISLIKE' || (args.value === 'INDIFFERENT' && cur === 'DISLIKE') ? 'Dislike' : 'Like';
      const b = [...r.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === label);
      if (!b) throw new Error('Like button not found');
      b.click();
      const v = await settle(() => (r.getAttribute('like-status') === args.value ? args.value : null), 2000);
      if (!v) throw new Error("The like didn't register");
      return { like: v };
    }

    default:
      throw new Error(`Unknown command ${cmd}`);
  }
  }
}
