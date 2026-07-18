/**
 * f16 wire-dtype integration tests — mesh-core's own layer on top of
 * `@unstable-legion/stage-runtime`'s `createActivationWireEncoder`/
 * `createActivationWireDecoder` (the codec-level f32/f16 round-trip is
 * already proven in legion-stage-runtime's `frames.test.ts` — read-only
 * reference, not duplicated here).
 *
 * What THIS file proves, at the altitude mesh-core actually owns:
 *
 *   1. An f16-dtype activation frame survives mesh-core's OWN wrapping —
 *      `encodeStageFrameEnvelope`/`decodeStageFrameEnvelope` (the sessionId
 *      envelope every real `sf` send/receive goes through, see
 *      `stageFrameEnvelope.ts`) — byte-for-byte round trip, decoding to a
 *      Float32Array of the correct length (never leaking f16-narrowed
 *      bytes past the envelope boundary).
 *   2. The header, sent once per stream and enveloped exactly like a real
 *      frame, round-trips too — this is the exact wire shape
 *      `stageOrchestrator.ts`'s `startSession`/`startCommunalSession` and
 *      `useStageHost.ts`'s `onStageFrame` handler exchange.
 *   3. f16 payload bytes on the wire are smaller than the f32 equivalent
 *      for the same activation — the whole point of this milestone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivationWireEncoder, createActivationWireDecoder } from '@unstable-legion/stage-runtime';
import { encodeStageFrameEnvelope, decodeStageFrameEnvelope } from '../src/stageFrameEnvelope.ts';

const N_EMBD = 4096; // Qwen3-8B hidden_size — the real production shape

function ramp(tokenCount: number, nEmbd = N_EMBD): Float32Array {
  const a = new Float32Array(tokenCount * nEmbd);
  for (let i = 0; i < a.length; i++) a[i] = Math.sin(i * 0.013) * (1 + (i % 11));
  return a;
}

test('f16 route: header + frame both survive the sessionId envelope round trip', () => {
  const sessionId = 'stagesess-f16-abc';
  const enc = createActivationWireEncoder({ modelId: 'qwen3-8b-q4', stageIndex: 0, nEmbd: N_EMBD, dtype: 'f16' });

  // Header — sent once before any frame (stageOrchestrator.ts's startSession).
  const envelopedHeader = encodeStageFrameEnvelope(sessionId, enc.headerBytes());
  const unwrappedHeader = decodeStageFrameEnvelope(envelopedHeader);
  assert.ok(unwrappedHeader);
  assert.equal(unwrappedHeader!.sessionId, sessionId);
  const dec = createActivationWireDecoder(unwrappedHeader!.payload);
  assert.equal(dec.dtype, 'f16');
  assert.equal(dec.nEmbd, N_EMBD);
  assert.equal(dec.modelId, 'qwen3-8b-q4');

  // A single decode-step frame (tokenCount=1, the hot path — one per token).
  const activations = ramp(1);
  const envelopedFrame = encodeStageFrameEnvelope(sessionId, enc.encodeFrame(activations, { seq: 0, posStart: 12 }));
  const unwrappedFrame = decodeStageFrameEnvelope(envelopedFrame);
  assert.ok(unwrappedFrame);
  assert.equal(unwrappedFrame!.sessionId, sessionId);

  const decoded = dec.decodeFrameBytes(unwrappedFrame!.payload);
  // The receiving side (useStageHost.ts) hands this straight to
  // StageWorkerClient.prefill/decode as an f32 buffer — the CRITICAL
  // constraint from the native wasm stage: it hard-requires f32 input
  // regardless of what crossed the wire.
  assert.ok(decoded.activations instanceof Float32Array);
  assert.equal(decoded.activations.length, N_EMBD);
  assert.equal(decoded.activations.byteLength, N_EMBD * 4); // f32 = 4 bytes/elem, NOT 2
  assert.equal(decoded.tokenCount, 1);
  assert.equal(decoded.posStart, 12);
});

test('f16 route: a prefill chunk (multi-token) round-trips through the envelope with tokens sideband intact', () => {
  const sessionId = 'stagesess-f16-prefill';
  const enc = createActivationWireEncoder({ modelId: 'm', stageIndex: 0, nEmbd: 32, dtype: 'f16' });
  const dec = createActivationWireDecoder(enc.headerBytes());

  const tokenCount = 17;
  const activations = ramp(tokenCount, 32);
  const tokens = Array.from({ length: tokenCount }, (_, i) => 100 + i);
  const enveloped = encodeStageFrameEnvelope(sessionId, enc.encodeFrame(activations, { seq: 0, posStart: 0, tokens }));
  const unwrapped = decodeStageFrameEnvelope(enveloped);
  assert.ok(unwrapped);
  const decoded = dec.decodeFrameBytes(unwrapped!.payload);

  assert.equal(decoded.tokenCount, tokenCount);
  assert.deepEqual(decoded.tokens, tokens);
  assert.equal(decoded.activations.length, tokenCount * 32);
  assert.equal(decoded.activations.byteLength, tokenCount * 32 * 4); // still f32 out
});

test('f16 wire bytes (post-envelope) are smaller than the f32 equivalent for the same activation', () => {
  const sessionId = 's';
  const enc32 = createActivationWireEncoder({ modelId: 'm', stageIndex: 0, nEmbd: N_EMBD, dtype: 'f32' });
  const enc16 = createActivationWireEncoder({ modelId: 'm', stageIndex: 0, nEmbd: N_EMBD, dtype: 'f16' });
  const activations = ramp(1);

  const b32 = encodeStageFrameEnvelope(sessionId, enc32.encodeFrame(activations, { seq: 0 })).byteLength;
  const b16 = encodeStageFrameEnvelope(sessionId, enc16.encodeFrame(activations, { seq: 0 })).byteLength;

  console.log(`[wire-dtype] decode-frame bytes (nEmbd=${N_EMBD}, post-envelope): f32=${b32}B f16=${b16}B`);
  // Payload halves; the sessionId envelope's fixed overhead is small and
  // identical for both, so the ratio still lands well under 0.55.
  assert.ok(b16 < b32 * 0.55, `f16 ${b16} vs f32 ${b32}`);
});

test('f16 round trip is lossy but bounded, matching legion-stage-runtime frames.test.ts tolerance', () => {
  const sessionId = 's';
  const enc = createActivationWireEncoder({ modelId: 'm', stageIndex: 0, nEmbd: N_EMBD, dtype: 'f16' });
  const dec = createActivationWireDecoder(enc.headerBytes());
  const activations = ramp(1);
  const enveloped = encodeStageFrameEnvelope(sessionId, enc.encodeFrame(activations, { seq: 0 }));
  const decoded = dec.decodeFrameBytes(decodeStageFrameEnvelope(enveloped)!.payload);
  for (let i = 0; i < activations.length; i++) {
    const a = activations[i]!;
    const b = decoded.activations[i]!;
    const tol = Math.max(Math.abs(a) * 2 ** -10, 1e-4);
    assert.ok(Math.abs(a - b) <= tol, `elem ${i}: ${a} vs ${b}`);
  }
});
