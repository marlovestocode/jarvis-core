const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, compile, format } = require('../src/core/brain/expr');

const near = (a, b, rel = 1e-12) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-15, `${a} != ${b}`);

test('expr: precedence, power right-assoc, unary minus below power', () => {
  assert.equal(evaluate('2 + 3 * 4').value, 14);
  assert.equal(evaluate('2 ^ 3 ^ 2').value, 512);
  assert.equal(evaluate('2 ** 3').value, 8);
  assert.equal(evaluate('-2 ^ 2').value, -4);
  assert.equal(evaluate('(1 + 2) * (3 - 5) / 4').value, -1.5);
  assert.equal(evaluate('10 % 4').value, 2);
});

test('expr: functions, constants, implicit multiplication, degrees', () => {
  near(evaluate('23.7 ^ 3.2').value, 25072.330688213402);
  near(evaluate('2pi').value, 2 * Math.PI);
  near(evaluate('3(1 + 1)').value, 6);
  near(evaluate('sin(30 deg)').value, 0.5);
  near(evaluate('sqrt(2) * sqrt(2)').value, 2);
  near(evaluate('ln(e) + log10(1000) + log(8, 2)').value, 7);
  near(evaluate('hypot(3, 4) + max(1, 9, 4) + min(2, -1)').value, 13);
  assert.equal(evaluate('5!').value, 120);
  assert.equal(evaluate('nCr(10, 3) + nPr(5, 2) + gcd(12, 18) + lcm(4, 6)').value, 120 + 20 + 6 + 12);
  near(evaluate('1.5e3 + .5').value, 1500.5);
});

test('expr: integer-only expressions are exact (BigInt)', () => {
  const r = evaluate('2^100');
  assert.equal(r.exact, '1267650600228229401496703205376');
  assert.equal(evaluate('30!').exact, '265252859812191058636308480000000');
  assert.equal(evaluate('(2^64 - 1) * 3').exact, '55340232221128654845');
  assert.equal(evaluate('7 / 2').exact, undefined, 'division leaves the exact path');
});

test('expr: variables via compile', () => {
  const f = compile('x^3 * sin(x)');
  near(f.eval({ x: 2 }), 8 * Math.sin(2));
  assert.deepEqual(f.vars, ['x']);
});

test('expr: errors are clear and nothing outside the grammar runs', () => {
  assert.throws(() => evaluate('2 +'), /Unexpected end/);
  assert.throws(() => evaluate('foo(2)'), /Unknown function "foo"/);
  assert.throws(() => evaluate('y + 1'), /Unknown name "y"/);
  assert.throws(() => evaluate('process.exit()'), /Unexpected|Unknown/);
  assert.throws(() => evaluate('constructor'), /Unknown name/);
  assert.throws(() => evaluate('1'.repeat(5) + '+'.repeat(3000)), /too long|Unexpected/);
  assert.equal(evaluate('171!').exact.length, 310);
  assert.throws(() => evaluate('100000!'), /too large/);
  assert.throws(() => evaluate('2^10000000'), /too large/);
  assert.throws(() => evaluate('1/0'), /not a finite number/);
});

test('format: 12 significant digits, no float noise', () => {
  assert.equal(format(0.1 + 0.2), '0.3');
  assert.equal(format(25072.330688213402), '25072.3306882');
  assert.equal(format(6.62607015e-34), '6.62607015e-34');
  assert.equal(format(1e21), '1e+21');
});
