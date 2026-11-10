// Small tolerant RSS 2.0 / Atom reader (no XML dependency). Everything it returns is plain text:
// CDATA unwrapped, entities decoded, HTML stripped. Fetched text is data, never instructions.
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };

function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const unCdata = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

function stripHtml(s) {
  return String(s || '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// element text: CDATA → decode entities (the text may itself be escaped HTML) → strip tags → decode again
function text(raw) {
  const once = decodeEntities(unCdata(raw));
  return decodeEntities(stripHtml(once)).replace(/\s+/g, ' ').trim();
}

function tag(block, names) {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'));
    if (m) return m[1];
  }
  return '';
}

function isoDate(s) {
  const t = Date.parse(text(s));
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map(m => m[1]);
  const pick = links.find(a => /rel=["']alternate["']/i.test(a)) || links.find(a => !/rel=/i.test(a)) || links[0] || '';
  const m = pick.match(/href=["']([^"']+)["']/i);
  return m ? decodeEntities(m[1]) : '';
}

function parseFeed(xml) {
  const s = String(xml || '');
  const atom = /<feed\b/i.test(s) && !/<rss\b/i.test(s);
  const items = [];
  if (atom) {
    for (const m of s.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)) {
      const b = m[0];
      items.push({
        title: text(tag(b, ['title'])), link: atomLink(b),
        published: isoDate(tag(b, ['published', 'updated'])),
        summary: text(tag(b, ['summary', 'content'])),
      });
    }
  } else {
    for (const m of s.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
      const b = m[0];
      items.push({
        title: text(tag(b, ['title'])), link: text(tag(b, ['link'])) || text(tag(b, ['guid'])),
        published: isoDate(tag(b, ['pubDate', 'dc:date', 'published'])),
        summary: text(tag(b, ['description', 'content:encoded'])),
      });
    }
  }
  const head = s.replace(/<(item|entry)\b[\s\S]*$/i, '');
  return { title: text(tag(head, ['title'])), items: items.filter(i => i.title) };
}

module.exports = { parseFeed, stripHtml, decodeEntities };
