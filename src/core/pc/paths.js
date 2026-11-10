// File tools only touch the user's own folders: Desktop, Documents, Downloads and Projects.
// safePath(input, roots) → absolute path, or throws. Refused: other folders, ".." escapes, UNC and
// device paths, drive-relative "C:x", and junctions/symlinks whose real target is outside the roots
// (checked on the nearest existing parent, so a new file under a junction is caught too).
const fs = require('node:fs');
const win = require('node:path').win32;

const defaultRoots = home => ['Desktop', 'Documents', 'Downloads', 'Projects'].map(d => win.join(home, d));
const rootNames = roots => roots.map(r => win.basename(r));
const inside = (p, root) => { const rel = win.relative(root, p); return rel === '' || (!rel.startsWith('..') && !win.isAbsolute(rel)); };

function outside(input, roots) {
  const names = rootNames(roots);
  return new Error(`Not allowed: ${input} is outside your ${names.slice(0, -1).join(', ')} and ${names.at(-1)}.`);
}

// the real location of p: realpath of its nearest existing parent, plus the part that does not exist yet
function realOf(p, realpath) {
  let cur = p, tail = [];
  for (;;) {
    try { return win.join(realpath(cur), ...tail); } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
      const up = win.dirname(cur);
      if (up === cur) throw err;
      tail.unshift(win.basename(cur));
      cur = up;
    }
  }
}

function safePath(input, roots, { realpath = fs.realpathSync.native } = {}) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw || /[\0\r\n]/.test(raw) || raw.length > 1024) throw outside(JSON.stringify(input), roots);
  if (/^[\\/]{2}/.test(raw)) throw outside(raw, roots);                       // UNC, \\?\, \\.\
  if (/^[a-z]:(?![\\/])/i.test(raw)) throw outside(raw, roots);               // C:foo (drive-relative)
  let p;
  if (win.isAbsolute(raw) && /^[a-z]:/i.test(raw)) p = win.resolve(raw);
  else {
    // "Downloads\x.pdf": the first part names one of the roots
    const [first, ...rest] = raw.replace(/^[\\/]+/, '').split(/[\\/]+/);
    const i = rootNames(roots).findIndex(n => n.toLowerCase() === first.toLowerCase());
    if (i < 0) throw new Error(`Say which folder: ${rootNames(roots).join(', ')}, or a full path inside one of them.`);
    p = win.resolve(roots[i], ...rest);
  }
  if (!roots.some(r => inside(p, r))) throw outside(raw, roots);
  const real = realOf(p, realpath);
  const realRoots = roots.map(r => { try { return realOf(r, realpath); } catch { return r; } });
  if (!realRoots.some(r => inside(real, r))) throw outside(raw, roots);
  return p;
}

module.exports = { safePath, defaultRoots, rootNames, inside };
