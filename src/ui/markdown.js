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

  // ---- LaTeX → readable Unicode (small models slip into LaTeX; the chat has no math renderer) ----
  const CMD = {
    cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', approx: '≈', neq: '≠', ne: '≠', leq: '≤', le: '≤', geq: '≥', ge: '≥',
    infty: '∞', int: '∫', iint: '∬', oint: '∮', sum: '∑', prod: '∏', partial: '∂', nabla: '∇', to: '→', rightarrow: '→',
    leftarrow: '←', Rightarrow: '⇒', iff: '⇔', degree: '°', circ: '°', propto: '∝', sim: '∼', equiv: '≡', in: '∈', forall: '∀',
    exists: '∃', cdots: '⋯', ldots: '…', dots: '…', hbar: 'ħ', ell: 'ℓ', angle: '∠', perp: '⊥', parallel: '∥',
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι',
    kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', chi: 'χ',
    psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    sin: 'sin', cos: 'cos', tan: 'tan', ln: 'ln', log: 'log', exp: 'exp', lim: 'lim', max: 'max', min: 'min', quad: ' ', qquad: ' ',
  };
  const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ' };
  const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎' };

  function script(content, map, mark) {
    if ([...content].every(c => map[c])) return [...content].map(c => map[c]).join('');
    if ([...content].length === 1) return mark + content;
    return mark + '(' + content.replace(/-/g, '−') + ')';
  }

  function texToText(t) {
    let s = t;
    for (let k = 0; k < 4; k++) s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
    for (let k = 0; k < 3; k++) s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)');
    s = s.replace(/\\(?:text|mathrm|mathbf|mathit|operatorname|textbf)\s*\{([^{}]*)\}/g, '$1');
    s = s.replace(/\\left|\\right/g, '').replace(/\\[,;:! ]/g, ' ');
    s = s.replace(/\\([A-Za-z]+)/g, (m, name) => (CMD[name] !== undefined ? CMD[name] : name));
    s = s.replace(/\^\{([^{}]*)\}/g, (m, c) => script(c.trim(), SUP, '^')).replace(/\^([0-9A-Za-z+\-∞])/g, (m, c) => script(c, SUP, '^'));
    s = s.replace(/_\{([^{}]*)\}/g, (m, c) => script(c.trim(), SUB, '_')).replace(/_([0-9])/g, (m, c) => SUB[c]);
    return s.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
  }

  function delatex(text) {
    // leave inline code spans alone
    return String(text).split(/(`[^`]*`)/).map((part, i) => {
      if (i % 2) return part;
      return part
        .replace(/\$\$([^$]+)\$\$/g, (m, t) => texToText(t))
        .replace(/\\\[(.+?)\\\]/g, (m, t) => texToText(t))
        .replace(/\\\((.+?)\\\)/g, (m, t) => texToText(t))
        .replace(/\$(?![\s\d])([^$\n]+?)(?<!\s)\$/g, (m, t) => texToText(t));
    }).join('');
  }

  function parse(src) {
    const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = null;
    let list = null;
    const endPara = () => { para = null; };
    const endList = () => { list = null; };

    for (let i = 0; i < lines.length; i++) {
      const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(lines[i]);
      const line = fence ? lines[i] : delatex(lines[i]);
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

  return { parse, inline, toDom, delatex };
}));
