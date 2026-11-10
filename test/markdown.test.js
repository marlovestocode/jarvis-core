const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/ui/markdown');

test('markdown: headings, paragraphs, lists, fenced code', () => {
  const t = parse('# Title\n\nSome **bold** and *it* and `x<y`\n\n- a\n- b\n\n1. one\n2. two\n\n```js\nlet a = "<b>";\n```');
  assert.deepEqual(t.map(n => n.tag), ['h1', 'p', 'ul', 'ol', 'pre']);
  assert.deepEqual(t[1].children, [
    { text: 'Some ' }, { tag: 'strong', children: [{ text: 'bold' }] }, { text: ' and ' },
    { tag: 'em', children: [{ text: 'it' }] }, { text: ' and ' }, { tag: 'code', children: [{ text: 'x<y' }] },
  ]);
  assert.equal(t[2].children.length, 2);
  assert.deepEqual(t[4], { tag: 'pre', lang: 'js', code: 'let a = "<b>";' });
});

test('markdown: raw html stays text', () => {
  const t = parse('<img src=x onerror=alert(1)>');
  assert.deepEqual(t, [{ tag: 'p', children: [{ text: '<img src=x onerror=alert(1)>' }] }]);
});

test('markdown: unclosed fence while streaming is still code', () => {
  const t = parse('hi\n```py\nprint(1)');
  assert.deepEqual(t[1], { tag: 'pre', lang: 'py', code: 'print(1)' });
});

test('markdown: tags used are from a fixed allow list', () => {
  const allowed = new Set(['h1', 'h2', 'h3', 'p', 'ul', 'ol', 'li', 'pre', 'strong', 'em', 'code', 'br']);
  const walk = ns => ns.forEach(n => { if (n.tag) assert.ok(allowed.has(n.tag), n.tag); if (n.children) walk(n.children); });
  walk(parse('### h\n* x **y** _z_\nline two\n\n```\n<script>\n```'));
});
