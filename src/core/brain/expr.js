// Safe math expression engine (no eval). Small grammar, exact BigInt path for
// integer-only arithmetic, Number path otherwise.
//   expr   := sum
//   sum    := prod (('+'|'-') prod)*
//   prod   := unary (('*'|'/'|'%') unary | implicit unary)*
//   unary  := ('-'|'+') unary | power
//   power  := postfix (('^'|'**') unary)?        right-assoc, binds tighter than unary minus
//   postfix:= atom '!'*
//   atom   := number | name | name '(' args ')' | '(' expr ')'
const MAX_LEN = 2000;
const MAX_BIG_BITS = 1 << 20;      // ~315k decimal digits
const MAX_FACT = 5000;

const CONSTANTS = { pi: Math.PI, π: Math.PI, e: Math.E, tau: 2 * Math.PI, phi: (1 + Math.sqrt(5)) / 2, deg: Math.PI / 180, inf: Infinity };

function factorial(n) {
  if (!Number.isInteger(n) || n < 0) throw new Error('factorial needs a whole number ≥ 0');
  if (n > 170) return Infinity;
  let r = 1; for (let i = 2; i <= n; i++) r *= i; return r;
}
const gcd2 = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; };
const choose = (n, k) => { if (k < 0 || k > n) return 0; k = Math.min(k, n - k); let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return Math.round(r); };

const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  sec: x => 1 / Math.cos(x), csc: x => 1 / Math.sin(x), cot: x => 1 / Math.tan(x),
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log10: Math.log10, log2: Math.log2,
  log: (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)),
  floor: Math.floor, ceil: Math.ceil, round: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d, trunc: Math.trunc, sign: Math.sign,
  min: Math.min, max: Math.max, hypot: Math.hypot, pow: Math.pow,
  factorial, gamma: x => (Number.isInteger(x) && x > 0 ? factorial(x - 1) : lanczos(x)),
  nCr: choose, nPr: (n, k) => (k < 0 || k > n ? 0 : Math.round(choose(n, k) * factorial(k))),
  gcd: (...a) => a.reduce(gcd2), lcm: (...a) => a.reduce((x, y) => Math.abs(x * y) / gcd2(x, y)),
  deg2rad: x => x * Math.PI / 180, rad2deg: x => x * 180 / Math.PI,
};

function lanczos(x) {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * lanczos(1 - x));
  x -= 1; let a = c[0]; const t = x + g + 0.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return Math.sqrt(2 * Math.PI) * t ** (x + 0.5) * Math.exp(-t) * a;
}

function tokenize(src) {
  if (src.length > MAX_LEN) throw new Error('Expression too long');
  const toks = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)|([A-Za-z_π][A-Za-z_0-9]*)|(\*\*|[-+*/%^!(),×÷−]))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`Unexpected "${src.slice(i).trim()[0]}"`);
    if (m[1] !== undefined) toks.push({ t: 'num', v: m[1] });
    else if (m[2] !== undefined) toks.push({ t: 'name', v: m[2] });
    else toks.push({ t: 'op', v: ({ '×': '*', '÷': '/', '−': '-' })[m[3]] || m[3] });
    i = re.lastIndex;
  }
  return toks;
}

function parse(src) {
  const toks = tokenize(String(src));
  let p = 0;
  const peek = () => toks[p];
  const isOp = v => peek() && peek().t === 'op' && peek().v === v;
  const need = v => { if (!isOp(v)) throw new Error(peek() ? `Unexpected "${peek().v}"` : 'Unexpected end'); p++; };

  function atom() {
    const tk = peek();
    if (!tk) throw new Error('Unexpected end');
    if (tk.t === 'num') { p++; return { k: 'num', v: tk.v }; }
    if (tk.t === 'name') {
      p++;
      if (isOp('(')) {
        p++;
        const args = [];
        if (!isOp(')')) { args.push(sum()); while (isOp(',')) { p++; args.push(sum()); } }
        need(')');
        if (!Object.prototype.hasOwnProperty.call(FUNCS, tk.v)) throw new Error(`Unknown function "${tk.v}"`);
        return { k: 'call', f: tk.v, args };
      }
      return { k: 'name', v: tk.v };
    }
    if (isOp('(')) { p++; const e = sum(); need(')'); return e; }
    throw new Error(`Unexpected "${tk.v}"`);
  }
  function postfix() { let e = atom(); while (isOp('!')) { p++; e = { k: 'fact', a: e }; } return e; }
  function power() {
    const b = postfix();
    if (isOp('^') || isOp('**')) { p++; return { k: 'pow', a: b, b: unary() }; }
    return b;
  }
  function unary() {
    if (isOp('-')) { p++; return { k: 'neg', a: unary() }; }
    if (isOp('+')) { p++; return unary(); }
    return power();
  }
  const startsAtom = () => peek() && (peek().t === 'num' || peek().t === 'name' || isOp('('));
  function prod() {
    let e = unary();
    for (;;) {
      if (isOp('*') || isOp('/') || isOp('%')) { const o = toks[p++].v; e = { k: 'bin', o, a: e, b: unary() }; }
      else if (startsAtom()) e = { k: 'bin', o: '*', a: e, b: power() };  // 2pi, 3(x+1), 30 deg
      else return e;
    }
  }
  function sum() {
    let e = prod();
    while (isOp('+') || isOp('-')) { const o = toks[p++].v; e = { k: 'bin', o, a: e, b: prod() }; }
    return e;
  }
  const ast = sum();
  if (p < toks.length) throw new Error(`Unexpected "${toks[p].v}"`);
  return ast;
}

function names(ast, out = new Set()) {
  if (ast.k === 'name') out.add(ast.v);
  for (const c of [ast.a, ast.b, ...(ast.args || [])]) if (c) names(c, out);
  return out;
}

function evalNum(ast, vars) {
  switch (ast.k) {
    case 'num': return parseFloat(ast.v);
    case 'name':
      if (vars && Object.prototype.hasOwnProperty.call(vars, ast.v)) return vars[ast.v];
      if (Object.prototype.hasOwnProperty.call(CONSTANTS, ast.v)) return CONSTANTS[ast.v];
      throw new Error(`Unknown name "${ast.v}"`);
    case 'neg': return -evalNum(ast.a, vars);
    case 'fact': return factorial(evalNum(ast.a, vars));
    case 'pow': return Math.pow(evalNum(ast.a, vars), evalNum(ast.b, vars));
    case 'call': return FUNCS[ast.f](...ast.args.map(a => evalNum(a, vars)));
    case 'bin': {
      const a = evalNum(ast.a, vars), b = evalNum(ast.b, vars);
      return ast.o === '+' ? a + b : ast.o === '-' ? a - b : ast.o === '*' ? a * b : ast.o === '/' ? a / b : a % b;
    }
  }
  throw new Error('bad expression');
}

// Exact path: integer literals with + - * ^ ! only. Returns null when not applicable.
function evalBig(ast) {
  switch (ast.k) {
    case 'num': return /^\d+$/.test(ast.v) ? BigInt(ast.v) : null;
    case 'neg': { const a = evalBig(ast.a); return a === null ? null : -a; }
    case 'fact': {
      const n = evalBig(ast.a);
      if (n === null || n < 0n) return null;
      if (n > BigInt(MAX_FACT)) throw new Error('Result too large to compute exactly');
      let r = 1n; for (let i = 2n; i <= n; i++) r *= i; return r;
    }
    case 'pow': {
      const a = evalBig(ast.a), b = evalBig(ast.b);
      if (a === null || b === null || b < 0n) return null;
      const bits = a === 0n || a === 1n || a === -1n ? 1 : (a < 0n ? -a : a).toString(2).length * Number(b);
      if (bits > MAX_BIG_BITS) throw new Error('Result too large to compute exactly');
      return a ** b;
    }
    case 'bin': {
      if (!['+', '-', '*'].includes(ast.o)) return null;
      const a = evalBig(ast.a), b = evalBig(ast.b);
      if (a === null || b === null) return null;
      return ast.o === '+' ? a + b : ast.o === '-' ? a - b : a * b;
    }
    default: return null;
  }
}

function format(v) {
  if (typeof v !== 'number') return String(v);
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  let s = v.toPrecision(12);
  if (s.includes('e')) { const [m, ex] = s.split('e'); s = (m.includes('.') ? m.replace(/\.?0+$/, '') : m) + 'e' + ex; }
  else if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  return s;
}

function compile(src) {
  const ast = parse(src);
  const vars = [...names(ast)].filter(n => !Object.prototype.hasOwnProperty.call(CONSTANTS, n));
  return { ast, vars, eval: v => evalNum(ast, v) };
}

function evaluate(src) {
  const ast = parse(src);
  const big = evalBig(ast);
  if (big !== null) {
    const exact = big.toString();
    return { value: Number(big), exact, text: exact };
  }
  const value = evalNum(ast);
  if (!Number.isFinite(value)) throw new Error('Result is not a finite number');
  return { value, text: format(value) };
}

module.exports = { evaluate, compile, format, FUNCS, CONSTANTS };
