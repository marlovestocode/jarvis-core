// Tiny markdown renderer. parse() builds a plain tree from a fixed tag list;
// toDom() turns it into elements with textContent only, so model text never
// reaches innerHTML. UMD: window.Markdown in the browser, module.exports in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Markdown = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_/g;

  function inline(text) {
    const out = [];
    let last = 0;
    const re = new RegExp(INLINE.source, 'g'); // own lastIndex: inline() recurses
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ text: text.slice(last, m.index) });
      if (m[1] !== undefined) out.push({ tag: 'code', children: [{ text: m[1] }] });
      else if (m[2] !== undefined || m[3] !== undefined) out.push({ tag: 'strong', children: inline(m[2] ?? m[3]) });
      else out.push({ tag: 'em', children: inline(m[4] ?? m[5]) });
      last = re.lastIndex;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
  }

  function parse(src) {
    const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = null;
    let list = null;
    const endPara = () => { para = null; };
    const endList = () => { list = null; };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
      if (fence) {
        endPara(); endList();
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
        out.push({ tag: 'pre', lang: fence[1] || '', code: code.join('\n') });
        continue;
      }
      if (!line.trim()) { endPara(); endList(); continue; }
      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) { endPara(); endList(); out.push({ tag: 'h' + h[1].length, children: inline(h[2]) }); continue; }
      const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        endPara();
        const tag = ul ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { list = { tag, children: [] }; out.push(list); }
        list.children.push({ tag: 'li', children: inline((ul || ol)[1]) });
        continue;
      }
      endList();
      if (para) para.children.push({ tag: 'br' }, ...inline(line));
      else { para = { tag: 'p', children: inline(line) }; out.push(para); }
    }
    return out;
  }

  // onCopy(code) is called by the copy button on code blocks.
  function toDom(nodes, doc, { onCopy } = {}) {
    const frag = doc.createDocumentFragment();
    for (const n of nodes) {
      if (n.tag === undefined) { frag.appendChild(doc.createTextNode(n.text)); continue; }
      if (n.tag === 'pre') {
        const wrap = doc.createElement('div');
        wrap.className = 'code';
        const bar = doc.createElement('div');
        bar.className = 'code-bar';
        const lang = doc.createElement('span');
        lang.textContent = n.lang || 'code';
        const btn = doc.createElement('button');
        btn.className = 'copy';
        btn.type = 'button';
        btn.textContent = 'COPY';
        btn.addEventListener('click', () => {
          if (onCopy) onCopy(n.code);
          btn.textContent = 'COPIED';
          setTimeout(() => { btn.textContent = 'COPY'; }, 1200);
        });
        bar.append(lang, btn);
        const pre = doc.createElement('pre');
        const code = doc.createElement('code');
        code.textContent = n.code;
        pre.appendChild(code);
        wrap.append(bar, pre);
        frag.appendChild(wrap);
        continue;
      }
      const el = doc.createElement(n.tag);
      if (n.children) el.appendChild(toDom(n.children, doc, { onCopy }));
      frag.appendChild(el);
    }
    return frag;
  }

  return { parse, inline, toDom };
}));
