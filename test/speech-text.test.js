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

test('articulation: times, dates, money, ranges, abbreviations, acronyms, pauses', () => {
  const { speakable } = require('../src/core/voice/speech-text');
  assert.equal(speakable('Meeting at 3:05 PM, or 15:00, or 9am.'), 'Meeting at 3 oh 5 P M, or fifteen hundred, or 9 A M.');
  assert.equal(speakable('Released 2026-11-10 for $5.99, not $1.5 million.'), 'Released November 10, twenty twenty-six for 5 dollars 99 cents, not 1.5 million dollars.');
  assert.equal(speakable('Takes 10-20 ms on the GPU (about 4 GB); e.g. Chrome vs. Edge — fine.'),
    'Takes 10 to 20 milliseconds on the G P U, about 4 gigabytes. for example Chrome versus Edge, fine.');
  assert.equal(speakable('Song by Scrim feat. Ghostemane, #1 hit.'), 'Song by Scrim featuring Ghostemane, number 1 hit.');
  assert.equal(speakable('5 - 3 = 2'), '5 minus 3 equals 2');
});

test('humanize: contractions, no filler closers, no emoji; stressed forms are left alone', () => {
  const { humanize, speakable } = require('../src/core/voice/speech-text');
  assert.equal(humanize('I am unable to open it. Please let me know if you need anything else.'), "I'm unable to open it.");
  assert.equal(humanize('I cannot do that, and it does not work.'), "I can't do that, and it doesn't work.");
  assert.equal(humanize('Do not worry. You are right and we will not stop.'), "Don't worry. You're right and we won't stop.");
  assert.equal(humanize('I have been here. I have no timers. They have not replied.'), "I've been here. I have no timers. They haven't replied.");
  assert.equal(humanize('The volume is not muted. Is there anything else I can help with?'), "The volume isn't muted.");
  assert.equal(humanize('Hello 🙂 there.'), 'Hello there.');
  assert.equal(humanize('It is 21 degrees.'), 'It is 21 degrees.');
  assert.equal(speakable('I am sorry, I cannot. I hope this helps!'), "I'm sorry, I can't.");
});

test('years are read as years, slang is lifted to a formal register, and numbers that are not years are left alone', () => {
  const { speakable, humanize } = require('../src/core/voice/speech-text');
  assert.equal(speakable('Founded in 1999 and renewed in 2026.'), 'Founded in nineteen ninety-nine and renewed in twenty twenty-six.');
  assert.equal(speakable('Back in 2005 it opened.'), 'Back in two thousand and five it opened.');
  assert.equal(speakable('The war of 1812 ended in 1815.'), 'The war of eighteen twelve ended in eighteen fifteen.');
  assert.equal(speakable('You have 2026 files and 1500 meters. By 1500 meters it ends.'), 'You have 2026 files and 1500 meters. By 1500 meters it ends.');
  assert.equal(humanize('Yeah, okay, I am gonna do it. Nope.'), "Yes, very well, I'm going to do it. No.");
  assert.equal(humanize('Awesome, no worries.'), 'Excellent, not at all.');
});

// ---- Phase 5: dialect and number style ----
const { resolve: dialectOf } = require('../src/core/voice/dialect');
const say = (t, speech) => speakable(t, { dialect: dialectOf(speech) });

test('speech: big numbers, ordinals and glued units are read as a person says them', () => {
  assert.equal(say('It cost 1,234,567 dollars.'), 'It cost one million two hundred and thirty-four thousand five hundred and sixty-seven dollars.');
  assert.equal(say('About 2,500 files.', { dialect: 'neutral' }), 'About two thousand five hundred files.', 'no British "and" in the neutral dialect');
  assert.equal(say('The 3rd, the 21st and the 12th.'), 'The third, the twenty-first and the twelfth.');
  assert.equal(say('It is 5km away and uses 2.5GB in 30ms.'), 'It is 5 kilometers away and uses 2.5 gigabytes in 30 milliseconds.');
  assert.equal(say('Only 1 km and 1 hr left.'), 'Only 1 kilometer and 1 hour left.');
  assert.equal(say('Version 1,5 and 12,34 stay.'), 'Version 1,5 and 12,34 stay.', 'not a thousands group');
  assert.equal(say('That is 1,234.5 metres.'), 'That is 1,234.5 metres.', 'decimals are left to the voice');
});

test('speech: 24-hour times are spoken as words, 12-hour ones as before', () => {
  assert.equal(say('At 14:30 and 09:05 pm and 15:00 and 7:45.'), 'At fourteen thirty and 9 oh 5 P M and fifteen hundred and 7 45.');
  assert.equal(say('Back at 18:07.'), 'Back at eighteen oh seven.');
});

test('speech: date order follows the setting, month first by default', () => {
  assert.equal(say('On 2026-11-12.'), 'On November 12, twenty twenty-six.');
  assert.equal(say('On 2026-11-12.', { dateOrder: 'dmy' }), 'On 12 November twenty twenty-six.');
});

test('speech: the dialect decides the register; formal rewrites casual words, neutral and casual leave them', () => {
  assert.equal(say('Yeah, okay. Gonna do it.'), 'Yes, very well. Going to do it.');
  assert.equal(say('Yeah, okay. Gonna do it.', { dialect: 'casual' }), "Yeah, okay. Gonna do it.");
  assert.equal(say('Okay, I am on it.', { dialect: 'neutral' }), "Okay, I'm on it.");
  assert.equal(say('I am sure it is not here.', { contractions: false }), 'I am sure it is not here.');
  assert.equal(say('I am sure it is not here.'), "I'm sure it isn't here.");
  assert.equal(say('Yeah.', { dialect: 'does-not-exist' }), 'Yes.', 'an unknown dialect falls back to the default');
});

test('speech: a long sentence gets a breath before its first joining word, a number never does, and it can be turned off', () => {
  const long = 'The meeting with the design team was moved to Thursday afternoon and the room is now on the second floor near the lifts.';
  assert.match(say(long), /Thursday afternoon, and the room/);
  assert.equal(say(long, { pauses: false }), long);
  assert.doesNotMatch(say('It costs 1,234,567 dollars on the third of March and it is on sale for the whole week.'), /five hundred, and sixty/);
  assert.equal(say('Short and sweet.'), 'Short and sweet.');
});
