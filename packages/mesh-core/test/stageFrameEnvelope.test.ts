/**
 * stageFrameEnvelope unit tests — encode/decode round-trip + malformed-
 * input tolerance for the M2 `sf` sessionId envelope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeStageFrameEnvelope, decodeStageFrameEnvelope } from '../src/stageFrameEnvelope.ts';

test('encode/decode round-trip: short sessionId + small payload', () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const enveloped = encodeStageFrameEnvelope('stagesess-abc123', payload);
  const decoded = decodeStageFrameEnvelope(enveloped);
  assert.ok(decoded);
  assert.equal(decoded!.sessionId, 'stagesess-abc123');
  assert.deepEqual(Array.from(decoded!.payload), Array.from(payload));
});

test('encode/decode round-trip: empty payload (e.g. a degenerate frame)', () => {
  const enveloped = encodeStageFrameEnvelope('s1', new Uint8Array(0));
  const decoded = decodeStageFrameEnvelope(enveloped);
  assert.ok(decoded);
  assert.equal(decoded!.sessionId, 's1');
  assert.equal(decoded!.payload.byteLength, 0);
});

test('encode/decode round-trip: large payload (simulated activation frame)', () => {
  const payload = new Uint8Array(4096);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 256;
  const enveloped = encodeStageFrameEnvelope('stagesess-large', payload);
  const decoded = decodeStageFrameEnvelope(enveloped);
  assert.ok(decoded);
  assert.deepEqual(Array.from(decoded!.payload), Array.from(payload));
});

test('two different sessionIds never collide byte-for-byte', () => {
  const a = encodeStageFrameEnvelope('session-A', new Uint8Array([9, 9]));
  const b = encodeStageFrameEnvelope('session-B', new Uint8Array([9, 9]));
  assert.notDeepEqual(Array.from(a), Array.from(b));
  const da = decodeStageFrameEnvelope(a)!;
  const db = decodeStageFrameEnvelope(b)!;
  assert.equal(da.sessionId, 'session-A');
  assert.equal(db.sessionId, 'session-B');
});

test('encodeStageFrameEnvelope rejects an empty sessionId', () => {
  assert.throws(() => encodeStageFrameEnvelope('', new Uint8Array([1])), RangeError);
});

test('decodeStageFrameEnvelope rejects malformed input without throwing', () => {
  assert.equal(decodeStageFrameEnvelope(new Uint8Array(0)), null);
  assert.equal(decodeStageFrameEnvelope(new Uint8Array([1])), null); // too short for the length prefix
  // Claims a 100-byte sessionId but the buffer is much shorter.
  const truncated = new Uint8Array(10);
  new DataView(truncated.buffer).setUint16(0, 100, true);
  assert.equal(decodeStageFrameEnvelope(truncated), null);
  // Zero-length sessionId is rejected (would decode to '', which the
  // encoder itself refuses to produce).
  const zeroLen = new Uint8Array(4);
  new DataView(zeroLen.buffer).setUint16(0, 0, true);
  assert.equal(decodeStageFrameEnvelope(zeroLen), null);
});

test('decodeStageFrameEnvelope tolerates a payload-only slice view (subarray offsets)', () => {
  const enveloped = encodeStageFrameEnvelope('s-offset', new Uint8Array([7, 8, 9]));
  // Simulate what Trystero hands back — a Uint8Array that may be a view
  // into a larger ArrayBuffer with a non-zero byteOffset.
  const wrapper = new Uint8Array(enveloped.byteLength + 16);
  wrapper.set(enveloped, 16);
  const view = wrapper.subarray(16);
  const decoded = decodeStageFrameEnvelope(view);
  assert.ok(decoded);
  assert.equal(decoded!.sessionId, 's-offset');
  assert.deepEqual(Array.from(decoded!.payload), [7, 8, 9]);
});
