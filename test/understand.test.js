const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/core/media/intent');
const { variants, near, wordNumber, digits } = require('../src/core/voice/understand');

const L = text => parse(text, { loose: true });
const same = (text, want) => {
  const got = L(text);
  assert.ok(got, `no intent for "${text}"`);
  for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k], v, `"${text}" → ${k}: ${JSON.stringify(got)}`);
};
const none = text => assert.equal(L(text), null, `"${text}" must not become a media command: ${JSON.stringify(L(text))}`);

test('strict phrases are untouched and need no loose pass', () => {
  assert.equal(parse('uh could you maybe skip this', { loose: false }), null);   // text mode keeps the strict grammar
  assert.equal(parse('skip', { loose: true }).via, undefined);
  assert.equal(parse('pause the music', { loose: true }).action, 'pause');
});

test('fillers, hedges and polite wrappers around a command', () => {
  same('Uh, Jarvis, could you maybe turn that up a little bit?', { action: 'volume' });
  same("I was wondering if you could skip this song, if you don't mind", { action: 'next' });
  same("so um I'd like you to pause the music for me", { action: 'pause' });
  same('well, just turn it down a bit, man', { action: 'volume', by: -0.05 });
  same('go ahead and mute it', { action: 'mute' });
  same('skip skip', { action: 'next' });
});

test('indirect asks: the complaint or wish means one control', () => {
  same("I can't hear it", { action: 'volume', by: 0.1 });
  same("I can barely hear the music", { action: 'volume', by: 0.1 });
  same("it's too quiet", { action: 'volume', by: 0.1 });
  same('the music is a bit too quiet', { action: 'volume', by: 0.1 });
  same("it's way too loud", { action: 'volume', by: -0.1 });
  same('this is hurting my ears', { action: 'volume', by: -0.1 });
  same('not so loud', { action: 'volume', by: -0.1 });
  same('this song sucks', { action: 'next' });
  same("I'm so sick of this song", { action: 'next' });
  same("I'm not feeling this", { action: 'next' });
  same('play something else', { action: 'next' });
  same('another one', { action: 'next' });
  same('change the song', { action: 'next' });
  same('play it again', { action: 'seek', to: 0 });   // not a search for a song called "it again"
  same('one more time', { action: 'seek', to: 0 });
  same('the song before this one', { action: 'prev' });
  same('shut it up', { action: 'mute' });
  same('what is that song called', { kind: 'query', what: 'now' });
  same("who's this guy", { kind: 'query', what: 'artist' });
});

test('misheard command words (real transcripts from the chat history)', () => {
  same('Skip this on.', { action: 'next' });
  same('skit this song', { action: 'next' });
  same('paws the music', { action: 'pause' });
  same('Turn down Chrome by 30%.', { action: 'volume', by: -0.3, app: 'Chrome' });
  same('Turn down current by 20%.', { action: 'volume', by: -0.2, app: 'Chrome' });
  same('Turn a Chrome application down to 20%.', { action: 'volume', set: 0.2, app: 'Chrome' });
  same('turn chrome application volume to 50%', { action: 'volume', set: 0.5, app: 'Chrome' });
  same('Turn Chrome to twenty percent', { action: 'volume', set: 0.2, app: 'Chrome' });
  same('turn Wallium to Max', { action: 'volume', set: 1 });
  same('Unshuffle.', { action: 'shuffle', on: false });
  same('Start Current Media.', { action: 'play' });
  same('can you cancel the current media?', { action: 'stop' });
  same('turn the song by down by 10%', { action: 'volume', by: -0.1 });
  same('shufle', { action: 'shuffle', on: true });
  same('resum the music', { action: 'play' });
});

test('hold on is a pause only while something plays (marked loose)', () => {
  same('hold on a second', { action: 'pause', loose: true });
  same('shh', { action: 'pause', loose: true });
});

test('ordinary talk and questions are never hijacked', () => {
  none('what is the weather like today');
  none('tell me about the Dallas Cowboys');
  none('what is my favorite color');
  none('I am sneezing so much');
  none('can you see now');
  none('give me my music statistics');
  none('turn off the lights');
  none('this is a really long explanation of how the song structure works in jazz');
  none('open youtube on chrome');
  assert.equal(L('play monochromatic by suicide boys').via, undefined);   // a strict find, never a rewrite
  none('close steam');
  none('move image 26 to desktop');
  none('what time is it');
});

test('a rewrite never reaches a free-text or destructive intent', () => {
  for (const t of ['clear the queue please', 'add this to my gym playlist uh', 'undo that', 'queue up stronger']) {
    const r = L(t);
    if (r) assert.notEqual(r.via, 'repaired', t);
  }
});

test('helpers', () => {
  assert.equal(near('shufle', 'shuffle'), true);
  assert.equal(near('shuffel', 'shuffle'), true);   // swap
  assert.equal(near('shuffle', 'shuffled'), true);
  assert.equal(near('text', 'next'), true);          // one substitution: that is why short words go through the curated list only
  assert.equal(wordNumber('twenty five'), 25);
  assert.equal(wordNumber('a hundred'), 100);
  assert.equal(digits('turn it to fifteen percent'), 'turn it to 15 percent');
  assert.equal(digits('one more time'), 'one more time');
  assert.deepEqual(variants(''), []);
  assert.ok(variants('uh turn it up').some(v => v.text === 'turn it up'));
});

test('a mis-transcribed short word is not repaired by edit distance (text ≠ next)', () => {
  none('text');
  none('mood');
  none('plan');
});
