/**
 * `splitForTts` unit tests — pure text-splitting logic, no engine/worker
 * involved (mirrors `ttsTool.test.ts`'s "no real engine" scope note).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitForTts } from '../src/splitForTts.ts';

test('empty/whitespace-only text → no chunks', () => {
  assert.deepEqual(splitForTts(''), []);
  assert.deepEqual(splitForTts('   \n\t  '), []);
});

test('single short text → one chunk', () => {
  const chunks = splitForTts('Hello there, how are you today?');
  assert.deepEqual(chunks, ['Hello there, how are you today?']);
});

test('multi-sentence text packs into few chunks, not one-per-sentence', () => {
  const text =
    'The sky is blue. The grass is green. Water is wet. Fire is hot. ' +
    'Ice is cold. The sun is bright. The moon is dim.';
  const chunks = splitForTts(text, 200);
  assert.ok(chunks.length >= 1 && chunks.length < 7, `expected packing, got ${chunks.length} chunks`);
  for (const c of chunks) assert.ok(c.length <= 200, `chunk exceeds maxChars: "${c}"`);
  // Sentence text is preserved (order + punctuation), just repacked.
  assert.equal(chunks.join(' '), text);
});

test('a sentence longer than maxChars splits on clause boundaries, staying under budget', () => {
  const longSentence =
    'This is a very long sentence, with several clauses, separated by commas, ' +
    'and it just keeps going, and going, and going, past the limit we set, ' +
    'so it must be split further, without ever cutting a word in half.';
  assert.ok(longSentence.length > 80);
  const chunks = splitForTts(longSentence, 80);
  assert.ok(chunks.length > 1, 'expected the oversized sentence to be split into multiple chunks');
  for (const c of chunks) {
    assert.ok(c.length <= 80, `chunk exceeds maxChars(80): "${c}" (${c.length})`);
  }
  // No mid-word cuts: every word in the original appears whole in the
  // reassembled text.
  const originalWords = longSentence.split(/\s+/).filter(Boolean);
  const rejoinedWords = chunks.join(' ').split(/\s+/).filter(Boolean);
  assert.deepEqual(rejoinedWords, originalWords);
});

test('a single clause-free word run longer than maxChars falls back to word boundaries, never mid-word', () => {
  const text =
    'supercalifragilisticexpialidocious is a word but the rest of these words are normal length';
  const chunks = splitForTts(text, 40);
  for (const c of chunks) {
    // Every chunk is built from whole words split on whitespace boundaries
    // — no chunk may end/begin with a fragment of a word that appears
    // whole elsewhere. Assert by checking the full reassembly matches the
    // original word sequence exactly.
    assert.ok(c.trim().length > 0);
  }
  const originalWords = text.split(/\s+/).filter(Boolean);
  const rejoinedWords = chunks.join(' ').split(/\s+/).filter(Boolean);
  assert.deepEqual(rejoinedWords, originalWords);
});

test('never exceeds maxChars across a mixed long multi-paragraph reply', () => {
  const text = [
    'Rolling TTS avoids the Kokoro context limit by chunking text client-side before synthesis.',
    'Here is a second paragraph with a mix of short sentences. And a longer one that goes on for quite a while, listing several items: apples, oranges, bananas, grapes, and a very long unbroken run of prose that has no punctuation anywhere in it at all so it must fall back to word splitting eventually to stay under budget.',
    'Final short line.',
  ].join('\n\n');
  const chunks = splitForTts(text, 200);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 200, `chunk exceeds maxChars: "${c}" (${c.length})`);
});
