// JARVIS browser control: a FIXED set of commands the background worker can run for JARVIS (tabs, search, page
// text, downloads, history, bookmarks). JARVIS sends a command name and plain arguments (never a script). There is no
// eval, no Function, and the one function injected into a page (readPage) takes no arguments.
// Every argument is validated here; the history, bookmarks, downloads and search APIs and access to page text are
// OPTIONAL permissions the user grants in the extension popup, and a missing one answers
// "permission not granted: <name>" without touching the API.
// browserCommand(cmd, args, chromeApi) → result, or throws a plain Error (the worker answers { ok: false, error }).

const MAX_TEXT = 12000;
const MAX_TABS = 100;
const MAX_URL = 2048;
const MAX_QUERY = 200;

const intId = v => { if (!Number.isInteger(v) || v < 1 || v > 2147483647) throw new Error('Bad tab id (a positive whole number)'); return v; };
const bool = (v, what) => { if (typeof v !== 'boolean') throw new Error(`Bad ${what} (true or false)`); return v; };
function query(v, { required = true } = {}) {
  if (v === undefined && !required) return '';
  if (typeof v !== 'string' || v.length > MAX_QUERY || (required && !v.trim())) throw new Error(`Bad query (1 to ${MAX_QUERY} characters)`);
  return v;
}
function limit(v) {
  if (v === undefined) return 10;
  if (!Number.isInteger(v) || v < 1 || v > 25) throw new Error('Bad limit (a whole number from 1 to 25)');
  return v;
}
function webUrl(v) {
  let u;
  try { if (typeof v !== 'string' || !v || v.length > MAX_URL) throw new Error('x'); u = new URL(v); } catch { throw new Error('Bad url: I only open full http or https addresses'); }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) throw new Error('Only http and https addresses can be opened');
  return u.href;
}
const cleanTab = t => ({ id: t.id, windowId: t.windowId, title: String(t.title ?? ''), url: String(t.url ?? ''), active: !!t.active, pinned: !!t.pinned, audible: !!t.audible });

async function need(chromeApi, permission, label = permission) {
  if (!(await chromeApi.permissions.contains({ permissions: [permission] }))) throw new Error(`permission not granted: ${label}`);
}

// Injected into the page: reads text only. No arguments, no outside variables.
function readPage() {
  const text = (document.body && document.body.innerText) || '';
  return { title: document.title || '', url: location.href, text: text.slice(0, 12000) };
}

// pages a script may not or should not read
const readable = url => /^https?:\/\//i.test(url || '') && !/^https:\/\/(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)\b/i.test(url);

export async function browserCommand(cmd, args, chromeApi) {
  const a = args && typeof args === 'object' ? args : {};
  switch (cmd) {
    case 'browser_tabs': {
      const tabs = await chromeApi.tabs.query({});
      return tabs.slice(0, MAX_TABS).map(cleanTab);
    }
    case 'browser_tab_switch': {
      const id = intId(a.id);
      const tab = await chromeApi.tabs.update(id, { active: true });
      if (!tab) throw new Error('That tab is gone');
      if (Number.isInteger(tab.windowId)) await chromeApi.windows.update(tab.windowId, { focused: true });
      return { id, title: String(tab.title ?? '') };
    }
    case 'browser_tab_open': {
      const url = webUrl(a.url);
      const tab = await chromeApi.tabs.create({ url, active: true });
      return { id: tab.id, url };
    }
    case 'browser_tab_close': {
      const id = intId(a.id);
      await chromeApi.tabs.remove(id);
      return { id };
    }
    case 'browser_tab_pin': {
      const id = intId(a.id);
      const pinned = bool(a.pinned, 'pinned');
      await chromeApi.tabs.update(id, { pinned });
      return { id, pinned };
    }
    case 'browser_search': {
      const text = query(a.query);
      await need(chromeApi, 'search');
      await chromeApi.search.query({ text, disposition: 'NEW_TAB' });
      return { searched: true };
    }
    case 'browser_page_text': {
      const id = a.id === undefined ? undefined : intId(a.id);
      if (!(await chromeApi.permissions.contains({ origins: ['<all_urls>'] }))) throw new Error('permission not granted: page access (all sites)');
      let tab;
      if (id === undefined) [tab] = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
      else tab = await chromeApi.tabs.get(id);
      if (!tab) throw new Error('No tab to read');
      if (!readable(tab.url)) throw new Error('I cannot read that kind of page (browser pages, local files and the Chrome Web Store are off limits)');
      const [r] = await chromeApi.scripting.executeScript({ func: readPage, target: { tabId: tab.id } });
      const out = r?.result;
      if (!out || typeof out.text !== 'string') throw new Error('The page did not give any text');
      return { title: String(out.title ?? '').slice(0, 300), url: String(out.url ?? ''), text: out.text.slice(0, MAX_TEXT) };
    }
    case 'browser_downloads': {
      const n = limit(a.limit);
      await need(chromeApi, 'downloads');
      const items = await chromeApi.downloads.search({ orderBy: ['-startTime'], limit: n });
      return items.slice(0, n).map(d => ({ name: String(d.filename ?? '').split(/[\\/]/).pop(), url: String(d.url ?? ''), state: String(d.state ?? ''), bytes: Number.isFinite(d.totalBytes) ? d.totalBytes : null, startTime: String(d.startTime ?? '') }));
    }
    case 'browser_history': {
      const text = query(a.query, { required: false });
      const n = limit(a.limit);
      await need(chromeApi, 'history');
      const items = await chromeApi.history.search({ text, maxResults: n, startTime: 0 });
      return items.slice(0, n).map(h => ({ title: String(h.title ?? ''), url: String(h.url ?? ''), lastVisit: Number.isFinite(h.lastVisitTime) ? h.lastVisitTime : null }));
    }
    case 'browser_bookmarks': {
      const text = query(a.query);
      const n = limit(a.limit);
      await need(chromeApi, 'bookmarks');
      const items = await chromeApi.bookmarks.search(text);
      return items.filter(b => b.url).slice(0, n).map(b => ({ title: String(b.title ?? ''), url: String(b.url) }));
    }
    default:
      throw new Error(`Unknown browser command: ${String(cmd).slice(0, 40)}`);
  }
}
