import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchWakePhrase } from '../src/matchWakePhrase.ts';

test('not found: unrelated speech is not woken, no command', () => {
  const m = matchWakePhrase('what is the weather like today', 'hey legion');
  assert.equal(m.woken, false);
  assert.equal(m.command, '');
});

test('found at the start: remainder after the phrase is the command', () => {
  const m = matchWakePhrase('hey legion what is two plus two', 'hey legion');
  assert.equal(m.woken, true);
  assert.equal(m.command, 'what is two plus two');
});

test('phrase alone (no trailing words): woken, empty command', () => {
  const m = matchWakePhrase('hey legion', 'hey legion');
  assert.equal(m.woken, true);
  assert.equal(m.command, '');
});

test('contains, not just startswith: filler before the phrase still wakes it', () => {
  const m = matchWakePhrase('uh, hey legion, what time is it', 'hey legion');
  assert.equal(m.woken, true);
  assert.equal(m.command, 'what time is it');
});

test('normalization: punctuation, casing, and extra whitespace are ignored on both sides', () => {
  const m = matchWakePhrase('  HEY,   LEGION!!  what\'s   up?? ', 'Hey Legion');
  assert.equal(m.woken, true);
  assert.equal(m.command, 'what s up');
});

test('normalization: apostrophes/hyphens stripped from the transcript do not break matching', () => {
  const m = matchWakePhrase("Hey-Legion, what's 2+2", 'hey legion');
  assert.equal(m.woken, true);
  assert.equal(m.command, 'what s 2 2');
});

test('empty configured phrase: never locks the gate shut, whole transcript is the command', () => {
  const m = matchWakePhrase('anything at all', '   ');
  assert.equal(m.woken, true);
  assert.equal(m.command, 'anything at all');
});

test('case/punctuation-insensitive phrase match with mixed transcript case', () => {
  const m = matchWakePhrase('Hey Legion tell me a joke', 'hey legion');
  assert.equal(m.woken, true);
  assert.equal(m.command, 'tell me a joke');
});
