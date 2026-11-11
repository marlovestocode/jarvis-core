// A web page → the text a person would read. Scripts, styles, menus, forms and hidden elements are dropped before
// anything reaches the model: hidden text is the usual place a page hides instructions meant for an AI.
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', deg: '°', middot: '·', bull: '•', laquo: '«', raquo: '»', euro: '€', pound: '£', times: '×', minus: '−' };

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

// elements removed with everything inside them
const DROP = ['script', 'style', 'noscript', 'svg', 'iframe', 'canvas', 'template', 'nav', 'footer', 'aside', 'form', 'select', 'button', 'dialog', 'object', 'embed', 'head'];
const HIDDEN_ATTR = /\s(?:hidden|aria-hidden\s*=\s*["']?true["']?)(?=[\s>\/])|style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0(?![.\d])|height\s*:\s*0(?:px)?\s*;[^"']*overflow\s*:\s*hidden|text-indent\s*:\s*-\d{3,})[^"']*["']/i;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

// walks the tags with a depth count, so a hidden element goes together with everything nested inside it
function dropHidden(s) {
  const re = /<(\/?)([a-z][a-z0-9-]*)\b([^>]*)>/gi;
  let out = '', last = 0, skip = null, depth = 0, m;
  while ((m = re.exec(s))) {
    const close = m[1] === '/', t = m[2].toLowerCase(), attrs = m[3], selfClosed = /\/\s*$/.test(attrs) || VOID.has(t);
    if (skip) {
      if (t === skip) {
        if (close) { depth--; if (depth === 0) { skip = null; last = re.lastIndex; } } else if (!selfClosed) depth++;
      }
      continue;
    }
    if (!close && HIDDEN_ATTR.test(attrs + ' ')) {
      out += s.slice(last, m.index) + ' ';
      if (selfClosed) last = re.lastIndex; else { skip = t; depth = 1; }
    }
  }
  return skip ? out : out + s.slice(last);
}

function dropElements(html) {
  let s = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of DROP) s = s.replace(new RegExp(String.raw`<${tag}\b[\s\S]*?<\/${tag}\s*>`, 'gi'), ' ');
  return dropHidden(s);
}

function htmlToText(html, { maxChars = 20000 } = {}) {
  const raw = String(html || '');
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 200);
  let s = dropElements(raw.replace(/^[\s\S]*?(?=<)/, ''));
  const main = /<(main|article)\b[^>]*>([\s\S]*)<\/\1\s*>/i.exec(s);
  if (main && main[2].replace(/<[^>]*>/g, '').trim().length > 400) s = main[2];
  s = s.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(?:p|div|section|h[1-6]|tr|table|ul|ol|blockquote|pre|figure|figcaption|dd|dt)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ').replace(/<h([1-6])\b[^>]*>/gi, '\n\n').replace(/<\/t[dh]\s*>/gi, ' | ').replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s).replace(/[​-‏⁠﻿]/g, '').replace(/[ \t\f\v ]+/g, ' ');
  const seen = new Set();
  const lines = [];
  for (const l of s.split('\n')) {
    const t = l.trim();
    if (t.length < 3 || /^[-|·•\s]+$/.test(t)) continue;
    const k = t.toLowerCase();
    if (t.length < 80 && seen.has(k)) continue;   // repeated menu and button text
    seen.add(k);
    lines.push(t);
  }
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return { title, text };
}

module.exports = { htmlToText, decodeEntities };
