// A small HTML table reader for the Wikipedia index pages. No parser library (no new dependencies): the pages are machine-generated
// MediaWiki output, so a tag-aware regex pass is enough. It returns text only and never executes or follows anything in the page.
// Verified against real responses captured 2026-11-17 (test/fixtures/stockman-data/*.html): current and old (oldid) revisions of
// "List of S&P 500 companies" and "Nasdaq-100" / "List of NASDAQ-100 companies".
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-' };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '; }
    return Object.hasOwn(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
  });
}
// visible text of a cell: footnote markers (<sup>) and hidden sort keys dropped, other tags removed, whitespace collapsed
function cellText(html) {
  return decode(html.replace(/<sup\b[\s\S]*?<\/sup>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

// every <table> in the page as { attrs, rows: string[][] } (header cells and data cells alike; nested tables are not split out)
function tables(html) {
  const out = [];
  const re = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = re.exec(html))) {
    const rows = [];
    for (const r of m[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => cellText(c[1]));
      if (cells.length) rows.push(cells);
    }
    out.push({ attrs: m[1], id: (/\bid="([^"]*)"/.exec(m[1]) || [])[1] || null, rows });
  }
  return out;
}

// the first table whose header row has all of `headers` (case-insensitive, exact cell text); { header, body } or null
function findTable(html, headers, { id } = {}) {
  const want = headers.map(h => h.toLowerCase());
  for (const t of tables(html)) {
    if (id && t.id !== id) continue;
    const head = t.rows.findIndex(r => want.every(w => r.some(c => c.toLowerCase() === w)));
    if (head === -1 || head > 2) continue;
    return { header: t.rows[head].map(c => c.toLowerCase()), body: t.rows.slice(head + 1), id: t.id };
  }
  return null;
}

module.exports = { tables, findTable, cellText, decode };
