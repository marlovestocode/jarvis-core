// Plain text out of text files, .docx and simple text PDFs. No dependency.
// extractText(path, { maxChars }) → { text, kind: 'text'|'pdf'|'docx', truncated }; throws a plain sentence when it cannot.
const fs = require('node:fs');
const zlib = require('node:zlib');
const win = require('node:path').win32;
const { readZip } = require('./zip');
const { humanSize } = require('../pc/util');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_CHARS = 12000;
const TEXT_EXT = new Set(['.txt', '.md', '.json', '.csv', '.log', '.js', '.ts', '.py', '.html']);
const KINDS = [...TEXT_EXT, '.pdf', '.docx'];
const CANNOT_PDF = 'I cannot read this PDF (scanned or complex)';
const kindOf = p => { const e = win.extname(p).toLowerCase(); return e === '.pdf' ? 'pdf' : e === '.docx' ? 'docx' : TEXT_EXT.has(e) ? 'text' : null; };

// ---- docx: word/document.xml with the tags removed ----
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function docxText(buf) {
  const [entry] = readZip(buf, { only: 'word/document.xml' });
  if (!entry) throw new Error('I cannot read this Word file (no document text in it)');
  return entry.data.toString('utf8')
    .replace(/<w:tab\s*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\n+$/, '');
}

// ---- pdf: text operators of simple (non-scanned, non-CID) content streams ----
function pdfString(s, i) {   // s[i] === '(' → [string, next index]
  let depth = 1, out = '';
  i++;
  while (i < s.length && depth > 0) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === 'n') out += '\n'; else if (n === 'r') out += '\r'; else if (n === 't') out += '\t'; else if (n === 'b') out += '\b'; else if (n === 'f') out += '\f';
      else if (/[0-7]/.test(n)) { let o = n, k = i + 2; while (o.length < 3 && /[0-7]/.test(s[k])) o += s[k++]; out += String.fromCharCode(parseInt(o, 8) & 255); i = k; continue; }
      else if (n === '\n') { /* line continuation */ } else if (n === '\r') { if (s[i + 2] === '\n') i++; } else out += n;
      i += 2;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') { depth--; if (depth === 0) { i++; break; } }
    out += c;
    i++;
  }
  return [out, i];
}

function contentText(s) {
  let out = '';
  let i = 0;
  let stack = [];   // operands since the last operator
  const flush = () => { stack = []; };
  const isNum = t => /^[-+]?\d*\.?\d+$/.test(t);
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { const [str, next] = pdfString(s, i); stack.push({ str }); i = next; continue; }
    if (c === '<' && s[i + 1] !== '<') {
      const j = s.indexOf('>', i);
      if (j < 0) break;
      const hex = s.slice(i + 1, j).replace(/\s/g, '');
      let str = '';
      for (let k = 0; k + 1 < hex.length; k += 2) str += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16) || 0);
      stack.push({ str, hex: true });
      i = j + 1;
      continue;
    }
    if (c === '[') { stack.push({ open: true }); i++; continue; }
    if (c === ']') { stack.push({ close: true }); i++; continue; }
    if (c === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    if (c === '/') { i++; while (i < s.length && !/[\s/[\]()<>]/.test(s[i])) i++; stack.push({ name: true }); continue; }
    let j = i;
    while (j < s.length && !/[\s/[\]()<>%]/.test(s[j])) j++;
    const tok = s.slice(i, j);
    i = j > i ? j : i + 1;
    if (!tok) continue;
    if (isNum(tok)) { stack.push({ num: Number(tok) }); continue; }
    // an operator
    if (tok === 'Tj' || tok === "'" || tok === '"') {
      if (tok !== 'Tj') out += '\n';
      for (const o of stack) if (o.str !== undefined) out += o.str;
    } else if (tok === 'TJ') {
      for (const o of stack) { if (o.str !== undefined) out += o.str; else if (o.num !== undefined && o.num < -200) out += ' '; }
    } else if (tok === 'T*' || tok === 'ET') out += '\n';
    else if (tok === 'Td' || tok === 'TD' || tok === 'Tm') { const last = stack.filter(o => o.num !== undefined).at(-1); if (tok === 'Tm' || (last && last.num !== 0)) out += '\n'; }
    flush();
  }
  return out;
}

function pdfText(buf) {
  const s = buf.toString('latin1');
  const parts = [];
  let from = 0;
  for (;;) {
    const k = s.indexOf('stream', from);
    if (k < 0) break;
    from = k + 6;
    if (s.slice(k - 3, k) === 'end') continue;   // "endstream"
    let start = k + 6;
    if (s[start] === '\r') start++;
    if (s[start] === '\n') start++;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    from = end + 9;
    const dictStart = s.lastIndexOf('obj', k);
    const dict = s.slice(Math.max(0, dictStart), k);
    if (/\/Subtype\s*\/(?:Image|Form|Type1C|CIDFontType0C|OpenType)/.test(dict) || /\/(?:DCTDecode|JPXDecode|CCITTFaxDecode)/.test(dict)) continue;
    let data = buf.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) { try { data = zlib.inflateSync(data); } catch { continue; } }
    else if (/\/Filter/.test(dict)) continue;   // other filters: not simple
    const content = data.toString('latin1');
    if (!/\bBT\b/.test(content)) continue;
    parts.push(contentText(content));
  }
  const text = parts.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const printable = (text.match(/[\x20-\x7e\n\t -ÿ]/g) || []).length;
  if (text.length < 3 || printable / text.length < 0.85) throw new Error(CANNOT_PDF);
  return text;
}

function extractText(file, { maxChars = MAX_CHARS } = {}) {
  const kind = kindOf(file);
  if (!kind) throw new Error(`I can read: ${KINDS.join(', ')}`);
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error(`${win.basename(file)} is not a file`);
  if (st.size > MAX_BYTES) throw new Error(`${win.basename(file)} is ${humanSize(st.size)}, over my ${humanSize(MAX_BYTES).replace('.0', '')} limit`);
  const buf = fs.readFileSync(file);
  let text;
  if (kind === 'pdf') text = pdfText(buf);
  else if (kind === 'docx') text = docxText(buf);
  else {
    if (buf.includes(0)) throw new Error(`${win.basename(file)} does not look like text`);
    text = buf.toString('utf8').replace(/^﻿/, '');
  }
  const cap = Math.max(1, Math.min(MAX_CHARS, Math.floor(maxChars) || MAX_CHARS));
  return { text: text.slice(0, cap), kind, truncated: text.length > cap, total: text.length };
}

module.exports = { extractText, kindOf, KINDS, MAX_BYTES, MAX_CHARS, CANNOT_PDF };
