// Browser tabs, pages, downloads, history and bookmarks through the JARVIS Chrome extension. The group exists when
// the extension link does; the tools themselves refuse while config.browser.enabled is off (the default) or the
// extension is not connected (see tools/browser.js).
const { createBrowserTools } = require('../../tools/browser');
const { own } = require('../util');

function createGroup({ browserLink, getConfig = () => ({}), pc } = {}) {
  if (!browserLink) return null;
  return {
    id: 'browser',
    label: 'Browser tabs, page text, downloads, history, bookmarks (Chrome extension)',
    triggers: [
      { words: ['tab', 'tabs'], w: 5 },
      { words: ['browser', 'chrome tab', 'bookmark', 'bookmarks', 'browsing history'], w: 3 },
      { re: /\b(?:browser|chrome|recent|latest) downloads\b|\bdownload(?:ed)? history\b|\bwhat did i download\b/i, w: 3 },   // "downloads" alone is the folder
      { re: /\b(?:this|the|that) page\b|\bopen\b.*\b(?:website|site|web ?page)\b/i, w: 3 },
    ],
    tools: createBrowserTools({ link: browserLink, getConfig, confirm: pc?.confirm || null }).map(t => own(t)),
  };
}

module.exports = { createGroup };
