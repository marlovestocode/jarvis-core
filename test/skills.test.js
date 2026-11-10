const test = require('node:test');
const assert = require('node:assert/strict');
const { solve, integrate, differentiate } = require('../src/core/brain/numeric');
const { describeData, regression } = require('../src/core/brain/stats');
const { convert } = require('../src/core/brain/units');
const { lookup, CONSTANTS } = require('../src/core/brain/constants');
const { dateCalc } = require('../src/core/brain/dates');

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test('solve: real roots of an equation in a range', () => {
  near(solve('x^3 - 2x - 5 = 0').roots[0], 2.0945514815423265, 1e-10);
  const r = solve('x^2 = 2', { from: -10, to: 10 }).roots;
  assert.equal(r.length, 2);
  near(r[0], -Math.SQRT2, 1e-10); near(r[1], Math.SQRT2, 1e-10);
  near(solve('cos(t) = t', { variable: 't' }).roots[0], 0.7390851332151607, 1e-10);
  assert.deepEqual(solve('x^2 + 1 = 0').roots, []);
});

test('integrate: finite and infinite bounds', () => {
  near(integrate('x^2 * e^(-x)', { from: 0, to: 'inf' }).value, 2, 1e-7);
  near(integrate('sin(x)', { from: 0, to: 'pi' }).value, 2, 1e-9);
  near(integrate('e^(-x^2)', { from: '-inf', to: 'inf' }).value, Math.sqrt(Math.PI), 1e-7);
  near(integrate('1/x', { from: 1, to: 'e' }).value, 1, 1e-9);
});

test('differentiate: first and second derivative at a point', () => {
  near(differentiate('x^3 * sin(x)', { at: 2 }).value, 7.582394429531041, 1e-6);
  near(differentiate('x^3', { at: 2, order: 2 }).value, 12, 1e-4);
});

test('stats: describe sample, population, quartiles, regression', () => {
  const d = describeData([4, 8, 15, 16, 23, 42]);
  assert.equal(d.count, 6); assert.equal(d.mean, 18); assert.equal(d.median, 15.5);
  near(d.stdevSample, 13.490737563232042, 1e-12);
  near(d.stdevPopulation, Math.sqrt(910 / 6), 1e-12);
  assert.equal(d.sum, 108); assert.equal(d.min, 4); assert.equal(d.max, 42);
  const r = regression([1, 2, 3, 4], [2, 4.1, 5.9, 8.1]);
  near(r.slope, 2.01, 1e-9); near(r.intercept, 0, 1e-9); assert.ok(r.r2 > 0.99);
  assert.throws(() => describeData([]), /at least one/);
});

test('units: simple, compound, prefixes, temperature, data, errors', () => {
  near(convert(65, 'mph', 'm/s').value, 29.0576, 1e-9);
  near(convert(65, 'mi/h', 'km/h').value, 104.60736, 1e-9);
  near(convert(100, 'degC', 'degF').value, 212, 1e-9);
  near(convert(0, '°F', 'K').value, 255.37222222222223, 1e-9);
  near(convert(1, 'kWh', 'MJ').value, 3.6, 1e-12);
  near(convert(1, 'eV', 'J').value, 1.602176634e-19, 1e-30);
  near(convert(1, 'atm', 'psi').value, 14.6959487755, 1e-8);
  near(convert(1, 'GiB', 'MB').value, 1073.741824, 1e-9);
  near(convert(9.81, 'm/s^2', 'ft/s^2').value, 32.1850393700787, 1e-9);
  near(convert(1, 'lightyear', 'au').value, 63241.07708426628, 1e-6);
  near(convert(3000, 'rpm', 'Hz').value, 50, 1e-9);
  near(convert(1, 'hp', 'W').value, 745.69987158227022, 1e-9);
  assert.throws(() => convert(1, 'kg', 'm'), /Cannot convert kg \(mass\) to m \(length\)/);
  assert.throws(() => convert(1, 'florp', 'm'), /Unknown unit "florp"/);
});

test('constants: CODATA values by name or symbol', () => {
  assert.equal(lookup('speed of light').value, 299792458);
  assert.equal(lookup('h').value, 6.62607015e-34);
  near(lookup('gravitational constant').value, 6.6743e-11, 1e-20);
  assert.equal(lookup('k_B').unit, 'J/K');
  assert.match(lookup('electron mass').name, /electron mass/i);
  assert.equal(lookup('nonsense constant'), null);
  assert.ok(CONSTANTS.length >= 25);
});

test('dates: difference, add, weekday', () => {
  assert.equal(dateCalc({ from: '2024-03-03', to: '2026-11-09' }).days, 981);
  assert.equal(dateCalc({ from: 'March 3, 2024', to: 'November 9, 2026' }).days, 981);
  assert.equal(dateCalc({ from: '2026-01-31', add: '1 month' }).date, '2026-02-28');
  assert.equal(dateCalc({ from: '2026-11-09', add: '-10 days' }).date, '2026-10-30');
  assert.equal(dateCalc({ from: '2026-11-09' }).weekday, 'Monday');
  assert.throws(() => dateCalc({ from: 'not a date' }), /Cannot read date/);
});
