const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../extension/prompts.js');

const d = (text, ...labels) => ({ text, buttons: labels.map(label => ({ label })) });

test('prompts: "Continue watching?" is confirmed with its Yes button', () => {
  assert.deepEqual(decide([d('Video paused. Continue watching?', 'Yes')]), { kind: 'still-listening', index: 0, label: 'Yes' });
  assert.deepEqual(decide([d('Are you still listening?', 'No', 'Yes, continue')]), { kind: 'still-listening', index: 1, label: 'Yes, continue' });
  assert.deepEqual(decide([d('Still watching? Playback will pause soon.', 'Continue watching')]), { kind: 'still-listening', index: 0, label: 'Continue watching' });
});

test('prompts: a content warning the account may accept is confirmed', () => {
  assert.equal(decide([d('This video may be inappropriate for some users. Viewer discretion is advised.', 'I understand and wish to proceed')]).kind, 'age-confirm');
  assert.equal(decide([d('Content warning', 'Cancel', 'Continue')]).index, 1);
});

test('prompts: anything that needs the account is never clicked', () => {
  for (const text of [
    'Sign in to confirm your age. This video may be inappropriate for some users.',
    'Verify your age to watch. We need a credit card or government ID.',
    'This video is age-restricted and is not available for your account.',
    'Enter your date of birth to continue. Viewer discretion is advised.',
  ]) {
    const r = decide([d(text, 'Continue', 'Sign in', 'I understand')]);
    assert.ok(r === null || (r.skip === 'needs the account' && r.index === undefined), `${text} -> ${JSON.stringify(r)}`);   // not recognised at all, or recognised and skipped: never clicked
  }
});

test('prompts: never picks a No/Cancel/Sign-in button, and ignores unrelated dialogs', () => {
  assert.deepEqual(decide([d('Video paused. Continue watching?', 'No', 'Cancel')]), { skip: 'no safe button', kind: 'still-listening' });
  assert.equal(decide([d('Add to playlist', 'Save', 'Cancel')]), null);
  assert.equal(decide([d('Rate your experience', 'Yes', 'No')]), null);
  assert.equal(decide([]), null);
  assert.equal(decide([d('x'.repeat(2000) + ' Continue watching?', 'Yes')]), null, 'a whole page is not a dialog');
});

test('prompts: a real prompt later in the list is found after an unrelated one', () => {
  const r = decide([d('Cookies', 'Accept'), d('Are you still there?', "I'm still here")]);
  assert.equal(r.kind, 'still-listening');
  assert.equal(r.index, 0);
});
