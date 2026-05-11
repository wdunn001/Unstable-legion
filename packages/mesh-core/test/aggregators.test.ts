/**
 * Aggregator unit tests — pure-function reducers used by ensemble().
 *
 * `llmSummarize` is intentionally NOT tested here — it requires a live
 * peer + tool dispatcher, which belongs in an integration test against
 * mesh-react / the demo, not a unit test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { majorityVote, concatJoin } from '../src/aggregators.ts';

test('majorityVote: most common response wins', () => {
  const r = ['yes', 'no', 'yes', 'maybe', 'yes'];
  assert.equal(majorityVote(r), 'yes');
});

test('majorityVote: tie → first occurrence in input order', () => {
  const r = ['a', 'b', 'a', 'b'];
  assert.equal(majorityVote(r), 'a');
});

test('majorityVote: case + whitespace insensitive', () => {
  const r = ['  Yes  ', 'YES', 'no'];
  // Canonical form preserved (the first raw match) but matching is normalized.
  assert.equal(majorityVote(r), '  Yes  ');
});

test('majorityVote: empty input → empty string', () => {
  assert.equal(majorityVote([]), '');
});

test('concatJoin: default separator', () => {
  const r = ['one', 'two', 'three'];
  const out = concatJoin()(r);
  assert.ok(out.includes('one'));
  assert.ok(out.includes('two'));
  assert.ok(out.includes('three'));
  // Default separator has a dash row in it.
  assert.ok(out.includes('— — —'));
});

test('concatJoin: custom separator', () => {
  assert.equal(concatJoin(' | ')(['a', 'b', 'c']), 'a | b | c');
});

test('concatJoin: single response returned verbatim (no trailing sep)', () => {
  assert.equal(concatJoin(' | ')(['only']), 'only');
});
