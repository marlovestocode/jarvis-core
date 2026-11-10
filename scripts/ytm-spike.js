// Phase 0 spike: proves the YouTube Music playlist calls from inside a signed-in music.youtube.com tab.
// Run: paste the whole file into the DevTools console (or run it with a browser tool) on https://music.youtube.com/
// It only touches ONE playlist it creates itself ("JARVIS TEST (delete me)") and deletes it at the end.
// Result: { steps: [...], raw } where raw holds full responses (also on window.__ytmSpike) for test fixtures.
(async () => {
  const out = { steps: [], raw: {} };
  const step = (name, ok, info) => { out.steps.push({ name, ok, ...info }); return ok; };
  const ytcfg = window.ytcfg;
  if (!ytcfg?.get) return { error: 'not on music.youtube.com' };
  if (!ytcfg.get('LOGGED_IN')) return { error: 'not signed in' };

  const origin = location.origin;
  const sapisid = (document.cookie.match(/(?:^|;\s*)(?:__Secure-3PAPISID|SAPISID)=([^;]+)/) || [])[1];
  async function sha1hex(s) { const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
  async function authHeader() {
    if (!sapisid) return null;
    const ts = Math.floor(Date.now() / 1000);
    return `SAPISIDHASH ${ts}_${await sha1hex(`${ts} ${sapisid} ${origin}`)}`;
  }
  step('sapisid cookie readable', !!sapisid, {});

  async function call(path, body, { auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) { const a = await authHeader(); if (a) { headers.Authorization = a; headers['X-Goog-AuthUser'] = String(ytcfg.get('SESSION_INDEX') ?? 0); headers['X-Origin'] = origin; } }
    const r = await fetch(`/youtubei/v1/${path}?prettyPrint=false`, { method: 'POST', credentials: 'include', headers, body: JSON.stringify({ context: ytcfg.get('INNERTUBE_CONTEXT'), ...body }) });
    let json = null; try { json = await r.json(); } catch { /* not json */ }
    return { status: r.status, json };
  }
  const rec = (k, r) => { out.raw[k] = r.json; return r.status; };

  // 1. read library playlists, without and with the auth header
  const noAuth = await call('browse', { browseId: 'FEmusic_liked_playlists' }, { auth: false });
  step('library read, no auth header', noAuth.status === 200, { status: noAuth.status });
  const lib = await call('browse', { browseId: 'FEmusic_liked_playlists' });
  rec('library', lib);
  step('library read, with SAPISIDHASH', lib.status === 200, { status: lib.status });

  // 2. create a throwaway playlist (write call: this is the real auth test)
  const created = await call('playlist/create', { title: 'JARVIS TEST (delete me)', description: 'Temporary playlist made by the JARVIS spike. Safe to delete.', privacyStatus: 'PRIVATE', videoIds: ['dQw4w9WgXcQ'] });
  rec('create', created);
  const pid = created.json?.playlistId;
  if (!step('create playlist', created.status === 200 && !!pid, { status: created.status, playlistId: pid })) {
    window.__ytmSpike = out; return out;
  }

  try {
    // 3. read it back (find setVideoId)
    // reads right after a write can be empty: wait for the playlist to settle (3.5 s was enough)
    await new Promise(r => setTimeout(r, 3500));
    const r1 = await call('browse', { browseId: 'VL' + pid }); rec('read1', r1);
    // read rows carry playlistItemData { playlistSetVideoId, videoId }; edit results use setVideoId
    const rows = j => JSON.stringify(j).match(/"playlistSetVideoId":"[^"]+"/g) || [];
    step('read playlist (VL id)', r1.status === 200, { status: r1.status, setVideoIds: rows(r1.json).length });

    // 4. add a second track, then a third
    const add = await call('browse/edit_playlist', { playlistId: pid, actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: '9bZkp7q19f0', dedupeOption: 'DEDUPE_OPTION_SKIP' }] });
    rec('add', add);
    step('add track', add.status === 200 && add.json?.status === 'STATUS_SUCCEEDED', { status: add.status, apiStatus: add.json?.status });
    const dup = await call('browse/edit_playlist', { playlistId: pid, actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: '9bZkp7q19f0', dedupeOption: 'DEDUPE_OPTION_CHECK' }] });   // CHECK refuses a duplicate with STATUS_FAILED; SKIP did not
    rec('addDuplicate', dup);
    step('duplicate add is skipped', dup.status === 200, { status: dup.status, apiStatus: dup.json?.status, results: JSON.stringify(dup.json?.playlistEditResults || null).slice(0, 200) });

    // 5. read again for setVideoIds, move track 2 before track 1
    await new Promise(r => setTimeout(r, 2500));
    const r2 = await call('browse', { browseId: 'VL' + pid }); rec('read2', r2);
    const ids = [...JSON.stringify(r2.json).matchAll(/"playlistSetVideoId":"([^"]+)"/g)].map(m => m[1]);
    const unique = [...new Set(ids)];
    step('two tracks present', unique.length === 2, { setVideoIds: unique.length });
    if (unique.length === 2) {
      const mv = await call('browse/edit_playlist', { playlistId: pid, actions: [{ action: 'ACTION_MOVE_VIDEO_BEFORE', setVideoId: unique[1], movedSetVideoIdSuccessor: unique[0] }]   // moves unique[1] to sit before unique[0] });
      rec('move', mv);
      step('move track', mv.status === 200 && mv.json?.status === 'STATUS_SUCCEEDED', { status: mv.status, apiStatus: mv.json?.status });
    }

    // 6. rename
    const ren = await call('browse/edit_playlist', { playlistId: pid, actions: [{ action: 'ACTION_SET_PLAYLIST_NAME', playlistName: 'JARVIS TEST (renamed, delete me)' }] });
    rec('rename', ren);
    step('rename playlist', ren.status === 200 && ren.json?.status === 'STATUS_SUCCEEDED', { status: ren.status, apiStatus: ren.json?.status });

    // 7. remove one track
    await new Promise(r => setTimeout(r, 2500));
    const r3 = await call('browse', { browseId: 'VL' + pid }); rec('read3', r3);
    const m3 = JSON.stringify(r3.json).match(/"playlistItemData":\{"playlistSetVideoId":"([^"]+)","videoId":"9bZkp7q19f0"/);
    const sv = m3 && m3[1];
    if (sv) {
      const rm = await call('browse/edit_playlist', { playlistId: pid, actions: [{ action: 'ACTION_REMOVE_VIDEO', removedVideoId: '9bZkp7q19f0', setVideoId: sv }] });
      rec('remove', rm);
      step('remove track', rm.status === 200 && rm.json?.status === 'STATUS_SUCCEEDED', { status: rm.status, apiStatus: rm.json?.status });
    } else step('remove track', false, { note: 'could not find setVideoId for the track' });
  } finally {
    // 8. always clean up the throwaway playlist
    const del = await call('playlist/delete', { playlistId: pid });
    rec('delete', del);
    step('delete throwaway playlist', del.status === 200, { status: del.status, apiStatus: del.json?.status });
  }
  window.__ytmSpike = out;
  return { steps: out.steps };
})()
