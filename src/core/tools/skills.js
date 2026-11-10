// Exact skills for the model: math, calculus, statistics, units, constants, dates,
// and a status report of this PC and JARVIS. Small models are bad at arithmetic;
// these tools make the answer exact and fast.
const { evaluate, format } = require('../brain/expr');
const { solve, integrate, differentiate } = require('../brain/numeric');
const { describeData, regression } = require('../brain/stats');
const { convert } = require('../brain/units');
const { lookup } = require('../brain/constants');
const { dateCalc } = require('../brain/dates');

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = description => ({ type: 'string', description });
const num = description => ({ type: 'number', description });
const f = format;

const calculate = {
  name: 'calculate',
  description: 'Evaluate a math expression exactly. Use it for ANY arithmetic instead of computing in your head. Supports + - * / % ^ !, parentheses, sqrt cbrt abs exp ln log10 log2 log(x, base), sin cos tan asin acos atan atan2 sinh cosh tanh (radians; write "30 deg" for degrees), floor ceil round(x, digits), min max hypot, nCr nPr gcd lcm factorial gamma, constants pi e tau phi. Whole-number math is exact for huge numbers.',
  params: obj({ expression: str('e.g. "23.7^3.2", "2^100", "sqrt(2*6.674e-11*5.972e24/6.371e6)"') }, ['expression']),
  async run({ expression }) {
    const r = evaluate(expression);
    return r.exact !== undefined ? `${expression} = ${r.exact} (exact)` : `${expression} = ${r.text}`;
  },
};

const solveTool = {
  name: 'solve_equation',
  description: 'Find all real roots of an equation in one variable numerically, e.g. "x^3 - 2x - 5 = 0" or "cos(t) = t". Searches from..to (default -100..100).',
  params: obj({ equation: str('equation with one "="'), variable: str('variable name, default x'), from: num('search start'), to: num('search end') }, ['equation']),
  async run(a) {
    const r = solve(a.equation, a);
    if (!r.roots.length) return `No real roots of ${a.equation} for ${r.variable} in [${r.range.join(', ')}]`;
    return `${a.equation}: ` + r.roots.map(x => `${r.variable} = ${f(x)}`).join(', ');
  },
};

const integrateTool = {
  name: 'integrate',
  description: 'Definite integral of an expression. Bounds may be numbers, expressions like "pi", or "inf"/"-inf".',
  params: obj({ expression: str('integrand, e.g. "x^2 * e^(-x)"'), variable: str('default x'), from: str('lower bound'), to: str('upper bound') }, ['expression', 'from', 'to']),
  async run(a) {
    const r = integrate(a.expression, a);
    return `integral of ${a.expression} d${r.variable} from ${a.from} to ${a.to} = ${f(r.value)}`;
  },
};

const diffTool = {
  name: 'differentiate',
  description: 'Numerical derivative (order 1 or 2) of an expression at a point.',
  params: obj({ expression: str('e.g. "x^3*sin(x)"'), variable: str('default x'), at: num('point'), order: { type: 'integer', enum: [1, 2] } }, ['expression', 'at']),
  async run(a) {
    const r = differentiate(a.expression, { ...a, order: a.order || 1 });
    return `d${r.order === 2 ? '²' : ''}/d${r.variable}${r.order === 2 ? '²' : ''} of ${a.expression} at ${r.variable} = ${a.at} is ${f(r.value)}`;
  },
};

const statsTool = {
  name: 'statistics',
  description: 'Statistics of a list of numbers: count, sum, mean, median, mode, min, max, quartiles, sample and population variance/stdev. Give y too for a least-squares line (slope, intercept, r²).',
  params: obj({ values: { type: 'array', items: { type: 'number' } }, y: { type: 'array', items: { type: 'number' } } }, ['values']),
  async run({ values, y }) {
    if (y) {
      const r = regression(values, y);
      return `line y = ${f(r.slope)}x + ${f(r.intercept)}; slope ${f(r.slope)}, intercept ${f(r.intercept)}, r ${f(r.r)}, r² ${f(r.r2)}`;
    }
    const d = describeData(values);
    return [`count ${d.count}`, `sum ${f(d.sum)}`, `mean ${f(d.mean)}`, `median ${f(d.median)}`, d.mode.length ? `mode ${d.mode.map(f).join(', ')}` : 'no mode',
      `min ${f(d.min)}`, `max ${f(d.max)}`, `Q1 ${f(d.q1)}`, `Q3 ${f(d.q3)}`, `sample stdev ${f(d.stdevSample)}`, `sample variance ${f(d.varianceSample)}`,
      `population stdev ${f(d.stdevPopulation)}`, `population variance ${f(d.variancePopulation)}`].join('; ');
  },
};

const unitsTool = {
  name: 'convert_units',
  description: 'Convert a value between units of the same kind (length, mass, time, temperature, speed, area, volume, energy, power, pressure, force, frequency, data, angle, and compound units like "m/s^2", "kWh", "mi/h"). Temperatures: degC, degF, K.',
  params: obj({ value: num('amount'), from: str('unit, e.g. "mph"'), to: str('unit, e.g. "m/s"') }, ['value', 'from', 'to']),
  async run({ value, from, to }) {
    const r = convert(value, from, to);
    return `${value} ${r.from} = ${f(r.value)} ${r.to}`;
  },
};

const constTool = {
  name: 'physics_constant',
  description: 'Exact CODATA value of a physical constant by name or symbol (c, h, hbar, e, k_B, N_A, R, G, g, epsilon_0, mu_0, m_e, m_p, alpha, sigma, Earth mass, Sun mass, au, ...).',
  params: obj({ name: str('e.g. "Planck", "G", "electron mass"') }, ['name']),
  async run({ name }) {
    const c = lookup(name);
    if (!c) throw new Error(`No constant called "${name}"`);
    return `${c.name} (${c.symbols[0]}) = ${f(c.value)}${c.unit ? ' ' + c.unit : ''}${c.uncertainty ? ` ± ${f(c.uncertainty)}` : ' (exact)'}`;
  },
};

const dateTool = {
  name: 'date_calc',
  description: 'Calendar math: days between two dates, a date plus/minus "N days|weeks|months|years", and weekdays. Dates as YYYY-MM-DD (or "today").',
  params: obj({ from: str('start date'), to: str('end date'), add: str('e.g. "90 days", "-2 weeks"') }),
  async run(a) {
    const r = dateCalc(a);
    const parts = [`${r.from} is a ${r.weekday}`];
    if (r.days !== undefined) parts.push(`${r.days} days (${r.weeks} weeks) from ${r.from} to ${r.to} (a ${r.toWeekday})`);
    if (r.date) parts.push(`${r.from} + ${a.add} = ${r.date} (a ${r.dateWeekday})`);
    return parts.join('; ');
  },
};

function skillTools() {
  return [calculate, solveTool, integrateTool, diffTool, statsTool, unitsTool, constTool, dateTool];
}

// jarvis_status: this PC's hardware and the state of JARVIS parts. getStatus() is
// supplied by the app (hardware, model, sysmon, wallpaper link, voice, hotkeys).
function createStatusTool({ getStatus }) {
  return {
    name: 'jarvis_status',
    description: "Facts about this PC and JARVIS itself: CPU, RAM, GPU and VRAM, Windows version, the AI model in use, and whether sysmon, the wallpaper, voice and hotkeys are working. Use it for any question about the user's computer or JARVIS.",
    params: obj({}),
    async run() {
      const s = await getStatus();
      const label = { cpu: 'CPU', ramGB: 'RAM', gpu: 'GPU', os: 'OS', model: 'AI model', sysmon: 'sysmon', youtubeMusic: 'YouTube Music', wallpaper: 'wallpaper', voice: 'voice', hotkeys: 'hotkeys', uptime: 'uptime' };
      return Object.entries(s).filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${label[k] || k}: ${k === 'ramGB' ? v + ' GB' : v}`).join('; ') || 'No status available';
    },
  };
}

module.exports = { skillTools, createStatusTool };
