/**
 * wireDtypeFromFrameBytes — byte-size-only dtype inference for the
 * pipeline-handoff UI (see wireDtypeGuess.ts's doc comment for why this
 * derives from bytes rather than trusting a plumbed-through hint).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { wireDtypeFromFrameBytes } from '../src/wireDtypeGuess.ts';

const N_EMBD = 4096; // Qwen3-8B hidden_size — the real production shape

test('wireDtypeFromFrameBytes: exact i8 byte count at nEmbd 4096', () => {
  assert.equal(wireDtypeFromFrameBytes(4096, N_EMBD), 'i8');
});

test('wireDtypeFromFrameBytes: exact f16 byte count at nEmbd 4096', () => {
  assert.equal(wireDtypeFromFrameBytes(8192, N_EMBD), 'f16');
});

test('wireDtypeFromFrameBytes: exact f32 byte count at nEmbd 4096', () => {
  assert.equal(wireDtypeFromFrameBytes(16384, N_EMBD), 'f32');
});

test('wireDtypeFromFrameBytes: 5120 nEmbd — i8/f16/f32 all resolve', () => {
  assert.equal(wireDtypeFromFrameBytes(5120, 5120), 'i8');
  assert.equal(wireDtypeFromFrameBytes(10240, 5120), 'f16');
  assert.equal(wireDtypeFromFrameBytes(20480, 5120), 'f32');
});

test('wireDtypeFromFrameBytes: msgpack/envelope overhead within tolerance still resolves', () => {
  // Real frames carry ~100-140 bytes of overhead on top of the raw
  // element bytes (activation-wire header keys + stageFrameEnvelope's
  // sessionId wrapper) — these should still classify correctly.
  assert.equal(wireDtypeFromFrameBytes(4096 + 120, N_EMBD), 'i8');
  assert.equal(wireDtypeFromFrameBytes(8192 + 130, N_EMBD), 'f16');
  assert.equal(wireDtypeFromFrameBytes(16384 + 110, N_EMBD), 'f32');
});

test('wireDtypeFromFrameBytes: junk byte counts resolve to "?"', () => {
  assert.equal(wireDtypeFromFrameBytes(1, N_EMBD), '?');
  assert.equal(wireDtypeFromFrameBytes(500, N_EMBD), '?');
  assert.equal(wireDtypeFromFrameBytes(999_999, N_EMBD), '?');
});

test('wireDtypeFromFrameBytes: non-positive bytes or nEmbd resolve to "?"', () => {
  assert.equal(wireDtypeFromFrameBytes(0, N_EMBD), '?');
  assert.equal(wireDtypeFromFrameBytes(-4096, N_EMBD), '?');
  assert.equal(wireDtypeFromFrameBytes(4096, 0), '?');
});
