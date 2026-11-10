// Unit conversion by dimensional analysis. Dimensions: L M T I Θ N J bit angle.
const D = (L = 0, M = 0, T = 0, I = 0, K = 0, N = 0, J = 0, B = 0, A = 0) => [L, M, T, I, K, N, J, B, A];
const DIMS = {
  length: D(1), mass: D(0, 1), time: D(0, 0, 1), current: D(0, 0, 0, 1), temperature: D(0, 0, 0, 0, 1), amount: D(0, 0, 0, 0, 0, 1),
  luminosity: D(0, 0, 0, 0, 0, 0, 1), data: D(0, 0, 0, 0, 0, 0, 0, 1), angle: D(0, 0, 0, 0, 0, 0, 0, 0, 1),
  area: D(2), volume: D(3), speed: D(1, 0, -1), acceleration: D(1, 0, -2), force: D(1, 1, -2), energy: D(2, 1, -2),
  power: D(2, 1, -3), pressure: D(-1, 1, -2), frequency: D(0, 0, -1), charge: D(0, 0, 1, 1), voltage: D(2, 1, -3, -1),
  resistance: D(2, 1, -3, -2), density: D(-3, 1), 'data rate': D(0, 0, -1, 0, 0, 0, 0, 1),
};

const g0 = 9.80665, lb = 0.45359237, inch = 0.0254, ft = 0.3048, mi = 1609.344, gal = 3.785411784e-3, eV = 1.602176634e-19, cal = 4.184;
// name: [factor to SI, dims, prefixable, offset]
const U = {};
const def = (names, f, d, prefix = false, off = 0) => { for (const n of names.split(' ')) U[n] = { f, d, prefix, off }; };
def('m meter meters metre metres', 1, DIMS.length, true);
def('in inch inches', inch, DIMS.length); def('ft foot feet', ft, DIMS.length); def('yd yard yards', 0.9144, DIMS.length);
def('mi mile miles', mi, DIMS.length); def('nmi', 1852, DIMS.length); def('au AU', 149597870700, DIMS.length);
def('ly lightyear lightyears', 9460730472580800, DIMS.length); def('pc parsec parsecs', 3.0856775814913673e16, DIMS.length, true);
def('angstrom Å', 1e-10, DIMS.length);
def('g gram grams', 1e-3, DIMS.mass, true); def('t tonne tonnes', 1000, DIMS.mass); def('lb lbs pound pounds', lb, DIMS.mass);
def('oz ounce ounces', lb / 16, DIMS.mass); def('st stone', 14 * lb, DIMS.mass); def('u Da dalton', 1.66053906660e-27, DIMS.mass);
def('s sec second seconds', 1, DIMS.time, true); def('min minute minutes', 60, DIMS.time); def('h hr hour hours', 3600, DIMS.time);
def('day days d', 86400, DIMS.time); def('week weeks wk', 604800, DIMS.time); def('yr year years', 31557600, DIMS.time);
def('A amp amps ampere', 1, DIMS.current, true); def('mol', 1, DIMS.amount, true); def('cd candela', 1, DIMS.luminosity, true);
def('K kelvin', 1, DIMS.temperature, true); def('degC °C celsius', 1, DIMS.temperature, false, 273.15);
def('degF °F fahrenheit', 5 / 9, DIMS.temperature, false, 459.67 * 5 / 9); def('degR °R rankine', 5 / 9, DIMS.temperature);
def('L l liter liters litre litres', 1e-3, DIMS.volume, true); def('gal gallon gallons', gal, DIMS.volume);
def('qt quart', gal / 4, DIMS.volume); def('pt pint', gal / 8, DIMS.volume); def('cup cups', gal / 16, DIMS.volume); def('floz', gal / 128, DIMS.volume);
def('acre acres', 4046.8564224, DIMS.area); def('ha hectare hectares', 1e4, DIMS.area);
def('mph', mi / 3600, DIMS.speed); def('kph', 1000 / 3600, DIMS.speed); def('knot knots kn', 1852 / 3600, DIMS.speed);
def('c_light', 299792458, DIMS.speed);
def('N newton newtons', 1, DIMS.force, true); def('lbf', lb * g0, DIMS.force); def('kgf', g0, DIMS.force); def('dyn', 1e-5, DIMS.force);
def('J joule joules', 1, DIMS.energy, true); def('eV', eV, DIMS.energy, true); def('cal calorie calories', cal, DIMS.energy, true);
def('Cal', 1000 * cal, DIMS.energy); def('Wh', 3600, DIMS.energy, true); def('BTU btu', 1055.05585262, DIMS.energy); def('erg', 1e-7, DIMS.energy);
def('W watt watts', 1, DIMS.power, true); def('hp horsepower', 745.69987158227022, DIMS.power);
def('Pa pascal', 1, DIMS.pressure, true); def('bar', 1e5, DIMS.pressure, true); def('atm', 101325, DIMS.pressure);
def('psi', lb * g0 / (inch * inch), DIMS.pressure); def('mmHg torr Torr', 101325 / 760, DIMS.pressure); def('inHg', 3386.389, DIMS.pressure);
def('Hz hertz', 1, DIMS.frequency, true); def('rpm', 1 / 60, DIMS.frequency);
def('C coulomb', 1, DIMS.charge, true); def('V volt volts', 1, DIMS.voltage, true); def('ohm Ω', 1, DIMS.resistance, true);
def('bit bits b', 1, DIMS.data, true); def('B byte bytes', 8, DIMS.data, true);
def('rad radian radians', 1, DIMS.angle, true); def('deg degree degrees °', Math.PI / 180, DIMS.angle);
def('rev turn turns', 2 * Math.PI, DIMS.angle); def('arcmin', Math.PI / 10800, DIMS.angle); def('arcsec', Math.PI / 648000, DIMS.angle);

const PREFIX = { Y: 1e24, Z: 1e21, E: 1e18, P: 1e15, T: 1e12, G: 1e9, M: 1e6, k: 1e3, h: 1e2, da: 10, d: 0.1, c: 1e-2, m: 1e-3, u: 1e-6, µ: 1e-6, μ: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, a: 1e-18 };
const BINARY = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50 };

function unit(name) {
  if (Object.prototype.hasOwnProperty.call(U, name)) return U[name];
  for (const [p, f] of Object.entries(BINARY)) {
    if (name.startsWith(p) && U[name.slice(p.length)]?.d === DIMS.data) return { ...U[name.slice(p.length)], f: f * U[name.slice(p.length)].f, off: 0 };
  }
  for (const [p, f] of Object.entries(PREFIX).sort((a, b) => b[0].length - a[0].length)) {
    const base = U[name.slice(p.length)];
    if (name.startsWith(p) && base && base.prefix) return { ...base, f: f * base.f, off: 0 };
  }
  return null;
}

function parse(text) {
  const src = String(text).trim().replace(/·/g, '*').replace(/²/g, '^2').replace(/³/g, '^3').replace(/\bper\b/g, '/').replace(/\s+/g, '');
  if (!src) throw new Error('Empty unit');
  const tokens = src.match(/[*/]|[^*/]+/g);
  let f = 1, d = D(), sign = 1, single = null, count = 0;
  for (const tk of tokens) {
    if (tk === '*') { sign = 1; continue; }
    if (tk === '/') { sign = -1; continue; }
    const m = /^(.+?)(?:\^(-?\d+))?$/.exec(tk);
    const u = unit(m[1]);
    if (!u) throw new Error(`Unknown unit "${m[1]}"`);
    const pow = (m[2] ? +m[2] : 1) * sign;
    f *= u.f ** pow;
    d = d.map((x, i) => x + u.d[i] * pow);
    single = count === 0 && pow === 1 ? u : null;
    count++; sign = 1;
  }
  return { f, d, off: count === 1 && single ? single.off : 0, text: String(text).trim() };
}

function dimName(d) {
  for (const [n, v] of Object.entries(DIMS)) if (v.every((x, i) => x === d[i])) return n;
  return 'other';
}

function convert(value, from, to) {
  const a = parse(from), b = parse(to);
  if (!a.d.every((x, i) => x === b.d[i])) throw new Error(`Cannot convert ${a.text} (${dimName(a.d)}) to ${b.text} (${dimName(b.d)})`);
  const si = Number(value) * a.f + a.off;
  return { value: (si - b.off) / b.f, from: a.text, to: b.text, kind: dimName(a.d) };
}

module.exports = { convert, parse };
