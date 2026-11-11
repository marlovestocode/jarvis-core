// Is this address one that belongs to the public internet? Everything else (this PC, the home network, link-local
// and cloud-metadata addresses, multicast, documentation ranges) is refused for general web access, so a page or a
// redirect can never aim JARVIS at the router, a local service or another device.
const net = require('node:net');

const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const v4ToInt = a => a.split('.').reduce((n, p) => (n * 256) + Number(p), 0);

function publicV4(addr) {
  if (net.isIPv4(addr) === false) return false;
  const n = v4ToInt(addr);
  for (const [base, bits] of V4_BLOCKS) {
    const size = 2 ** (32 - bits);
    const start = v4ToInt(base);
    if (n >= start && n < start + size) return false;
  }
  return true;
}

// the 32 bits tucked into an IPv6 address that wraps an IPv4 one (::ffff:a.b.c.d, 64:ff9b::/96, 6to4 2002::/16)
function embeddedV4(groups) {
  const [a, b, c, d, e, f, g, h] = groups;
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return v4(g, h);   // ::ffff:v4
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && (g || h) && !(g === 0 && h === 1)) return v4(g, h);   // ::v4 (deprecated)
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return v4(g, h);   // NAT64
  if (a === 0x2002) return v4(b, c);   // 6to4
  return null;
}

function expandV6(addr) {
  let s = addr.split('%')[0].toLowerCase();
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const p = tail[1].split('.').map(Number);
    s = s.slice(0, -tail[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const [head, rest] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = rest === undefined ? [] : rest ? rest.split(':') : [];
  const fill = rest === undefined ? [] : Array(Math.max(0, 8 - h.length - t.length)).fill('0');
  const groups = [...h, ...fill, ...t].map(x => parseInt(x || '0', 16));
  return groups.length === 8 && groups.every(Number.isFinite) ? groups : null;
}

function isPublicIp(addr) {
  const a = String(addr || '').trim();
  if (net.isIPv4(a)) return publicV4(a);
  if (!net.isIPv6(a)) return false;
  const g = expandV6(a);
  if (!g) return false;
  const inner = embeddedV4(g);
  if (inner) return publicV4(inner);
  if (g.every(x => x === 0)) return false;                       // ::
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return false;   // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return false;                  // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false;                  // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return false;                  // fec0::/10 site-local (old)
  if ((g[0] & 0xff00) === 0xff00) return false;                  // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;          // documentation
  return (g[0] & 0xe000) === 0x2000;                             // only global unicast 2000::/3
}

module.exports = { isPublicIp };
