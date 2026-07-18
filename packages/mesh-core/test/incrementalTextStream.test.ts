/**
 * TEXT-RELAY — incremental UTF-8-safe text streaming (`incrementalTextStream.ts`).
 *
 * Simulates what `useStageHost.ts`'s final-stage token loop actually does:
 * call `detokenize(sampledTokensSoFar)` (a FULL redecode of the growing
 * token list) on every step and feed the result through
 * `extractIncrementalTextDelta`. The fake `detokenize` below reproduces the
 * real behavior this module is built to survive — a non-fatal `TextDecoder`
 * leaves a trailing U+FFFD when the growing byte sequence ends mid
 * multi-byte character, and resolves it once the completing token's bytes
 * are concatenated in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractIncrementalTextDelta, INITIAL_TEXT_CURSOR, type IncrementalTextCursor } from '../src/incrementalTextStream.ts';

// € (U+20AC) is E2 82 AC in UTF-8 — a 3-byte character. Split its bytes
// across two tokens: token A contributes "abc" + the first 2 bytes (E2 82),
// token B contributes the final byte (AC) + "def".
const EURO_BYTES = new TextEncoder().encode('abc€def');
const TOKEN_A_BYTES = EURO_BYTES.slice(0, 5); // "abc" + E2 82 (incomplete)
const TOKEN_B_BYTES = EURO_BYTES.slice(5); // AC + "def"

/** Mimics stage-runtime's `detokenize()`: concatenate every requested
 * token's raw bytes, THEN run one non-fatal TextDecoder pass. */
function fakeDetokenizeGrowing(tokensSoFar: readonly ('A' | 'B')[]): string {
  const parts = tokensSoFar.map((t) => (t === 'A' ? TOKEN_A_BYTES : TOKEN_B_BYTES));
  const totalLen = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    buf.set(p, offset);
    offset += p.length;
  }
  return new TextDecoder().decode(buf);
}

test('extractIncrementalTextDelta: a multi-byte char split across two tokens is never emitted broken', () => {
  // Step 1: only token A has arrived — the growing decode ends mid-€.
  const fullAfterA = fakeDetokenizeGrowing(['A']);
  assert.ok(fullAfterA.endsWith('�'), 'sanity: an incomplete trailing sequence decodes with a replacement char');

  const step1 = extractIncrementalTextDelta(fullAfterA, INITIAL_TEXT_CURSOR);
  // The incomplete tail must be held back entirely — nothing broken emitted.
  assert.equal(step1.delta, 'abc');
  assert.ok(!step1.delta.includes('�'), 'must never emit a replacement/broken character');

  // Step 2: token B arrives, completing the character.
  const fullAfterAB = fakeDetokenizeGrowing(['A', 'B']);
  assert.equal(fullAfterAB, 'abc€def');

  const step2 = extractIncrementalTextDelta(fullAfterAB, step1.cursor);
  assert.equal(step2.delta, '€def');
  assert.ok(!step2.delta.includes('�'));

  // Final concatenation of every delta equals the whole decoded string.
  assert.equal(step1.delta + step2.delta, 'abc€def');
});

test('extractIncrementalTextDelta: nothing new is emitted while still incomplete (delta stays "")', () => {
  const fullAfterA = fakeDetokenizeGrowing(['A']);
  const step1 = extractIncrementalTextDelta(fullAfterA, INITIAL_TEXT_CURSOR);

  // Redecoding the SAME still-incomplete prefix again (no new token yet)
  // must not re-emit or regress — delta is empty, cursor unchanged.
  const again = extractIncrementalTextDelta(fullAfterA, step1.cursor);
  assert.equal(again.delta, '');
  assert.deepEqual(again.cursor, step1.cursor);
});

test('extractIncrementalTextDelta: flush:true forces out a residual incomplete tail at generation end', () => {
  const fullAfterA = fakeDetokenizeGrowing(['A']);
  const step1 = extractIncrementalTextDelta(fullAfterA, INITIAL_TEXT_CURSOR);
  assert.equal(step1.delta, 'abc');

  // Generation ends here (eos) with the completing token B never sampled —
  // flush must surface the lossy tail rather than silently dropping it.
  const flushed = extractIncrementalTextDelta(fullAfterA, step1.cursor, { flush: true });
  assert.equal(flushed.delta, '�');
});

test('extractIncrementalTextDelta: plain ASCII streams one token at a time with no buffering needed', () => {
  let cursor: IncrementalTextCursor = INITIAL_TEXT_CURSOR;
  let acc = '';
  const words = ['Hello', 'Hello, ', 'Hello, world', 'Hello, world!'];
  for (const full of words) {
    const { delta, cursor: next } = extractIncrementalTextDelta(full, cursor);
    acc += delta;
    cursor = next;
  }
  assert.equal(acc, 'Hello, world!');
});

test('extractIncrementalTextDelta: a fresh cursor with no prior text emits the whole safe string', () => {
  const { delta } = extractIncrementalTextDelta('hi there', INITIAL_TEXT_CURSOR);
  assert.equal(delta, 'hi there');
});
