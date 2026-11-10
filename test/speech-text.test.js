const test = require('node:test');
const assert = require('node:assert/strict');
const { speakable, createSentenceSplitter } = require('../src/core/voice/speech-text');

test('speakable: markdown, code, LaTeX, symbols and units become plain speech', () => {
  assert.equal(speakable('**2.48 eV** is the *energy*.'), '2.48 electron volts is the energy.');
  assert.equal(speakable('# Result\n- one\n- two'), 'Result. one. two.');
  assert.equal(speakable('Run this:\n```js\nconsole.log(1)\n```\nDone.'), 'Run this: I put the code in the chat. Done.');
  assert.equal(speakable('Speed is 11.2 km/s, about 3 × 10⁸ m/s.'), 'Speed is 11.2 kilometers per second, about 3 times 10 to the 8 meters per second.');
  assert.equal(speakable('x² + √2 ≈ π'), 'x squared plus square root of 2 approximately pi');
  assert.equal(speakable('See [the docs](https://x.y) now'), 'See the docs now');
  assert.equal(speakable('It is 21°C, 45% load.'), 'It is 21 degrees Celsius, 45 percent load.');
  assert.equal(speakable(String.raw`$E = \frac{hc}{\lambda}$`), 'E equals hc over lambda');
});

test('splitter: whole sentences out as they complete; decimals and abbreviations are not breaks', () => {
  const s = createSentenceSplitter();
  assert.deepEqual(s.push('The energy is 2.'), []);
  assert.deepEqual(s.push('48 eV. That is gre'), ['The energy is 2.48 eV.']);
  assert.deepEqual(s.push('en light, e.g. a laser! Next'), ['That is green light, e.g. a laser!']);
  assert.deepEqual(s.push(' part?\nAnd'), ['Next part?']);
  assert.deepEqual(s.flush(), ['And']);
  assert.deepEqual(s.flush(), []);
});

test('splitter: a long run without a full stop is cut at a comma so speech starts early', () => {
  const s = createSentenceSplitter({ maxChars: 60 });
  const out = s.push('This is a long clause that keeps going and going, and then it continues more');
  assert.equal(out.length, 1);
  assert.match(out[0], /going,$/);
});
