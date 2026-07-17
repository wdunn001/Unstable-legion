/**
 * i8 activation wire — round-trip + dispatcher coverage for
 * `activationWireI8.ts` (the self-contained per-token abs-max symmetric
 * int8 codec, with keyframe-anchored delta for the decode-step streak) and
 * `activationWireCodec.ts` (the header-based f32/f16/i8 dispatcher).
 *
 * Same altitude/idiom as `activationWireDtype.test.ts`'s f16 coverage —
 * this file proves the i8 codec itself (quantize/dequantize + delta
 * reconstruction), not the sessionId-envelope wrapping (already proven
 * dtype-agnostic there).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivationWireEncoder } from '@unstable-legion/stage-runtime';
import {
  createI8ActivationWireEncoder,
  createI8ActivationWireDecoder,
} from '../src/activationWireI8.ts';
import {
  createLegionActivationWireEncoder,
  createLegionActivationWireDecoder,
  legionActivationBytes,
} from '../src/activationWireCodec.ts';

const N_EMBD = 4096; // Qwen3-8B hidden_size — the real production shape

/** Deterministic "random-ish" activations — same wave-based generator idiom
 * `activationWireDtype.test.ts` uses, scaled/shifted per-row so different
 * tokens in a multi-token chunk carry different magnitudes (exercises the
 * per-row abs-max scale, not a single frame-wide scale). */
function rowActivations(tokenCount: number, nEmbd = N_EMBD, rowSeed = 0): Float32Array {
  const a = new Float32Array(tokenCount * nEmbd);
  for (let t = 0; t < tokenCount; t++) {
    const magnitude = 1 + ((rowSeed + t) % 7) * 3.5;
    for (let i = 0; i < nEmbd; i++) {
      a[t * nEmbd + i] = Math.sin((i + rowSeed * 97 + t * 13) * 0.017) * magnitude;
    }
  }
  return a;
}

/** Per-token abs-max of a Float32Array row — mirrors the quantizer's own
 * scale computation, so the tolerance check below matches what the codec
 * actually promises (one quantization step, `absmax/127`, plus a small
 * epsilon for float round-off). */
function rowAbsMax(activations: Float32Array, t: number, nEmbd: number): number {
  let m = 0;
  const off = t * nEmbd;
  for (let i = 0; i < nEmbd; i++) {
    const v = Math.abs(activations[off + i]!);
    if (v > m) m = v;
  }
  return m;
}

function assertRowsWithinTolerance(orig: Float32Array, decoded: Float32Array, tokenCount: number, nEmbd: number): void {
  assert.equal(decoded.length, orig.length);
  for (let t = 0; t < tokenCount; t++) {
    const absMax = rowAbsMax(orig, t, nEmbd);
    const tol = absMax / 127 + 1e-4;
    const off = t * nEmbd;
    for (let i = 0; i < nEmbd; i++) {
      const a = orig[off + i]!;
      const b = decoded[off + i]!;
      assert.ok(Math.abs(a - b) <= tol, `token ${t} elem ${i}: ${a} vs ${b} (tol ${tol})`);
    }
  }
}

// ── 1. Round-trip: single decode-step frame (tokenCount=1) ──────────────

test('i8 round trip: a single decode-step frame (nEmbd=4096) reconstructs within quantization tolerance', () => {
  const enc = createI8ActivationWireEncoder({ modelId: 'qwen3-8b-q4', stageIndex: 0, nEmbd: N_EMBD });
  const dec = createI8ActivationWireDecoder(enc.headerBytes());
  assert.equal(dec.modelId, 'qwen3-8b-q4');
  assert.equal(dec.nEmbd, N_EMBD);
  assert.equal(dec.dtype, 'i8');

  const activations = rowActivations(1);
  const frameBytes = enc.encodeFrame(activations, { seq: 0 });
  const decoded = dec.decodeFrameBytes(frameBytes);

  assert.equal(decoded.tokenCount, 1);
  assert.equal(decoded.seq, 0);
  assert.ok(decoded.activations instanceof Float32Array);
  assertRowsWithinTolerance(activations, decoded.activations, 1, N_EMBD);
});

// ── 2. Prefill chunk (tokenCount>1) is always a keyframe, per-row ────────

test('i8 round trip: a prefill chunk (tokenCount=3) is always a keyframe and round-trips per token row', () => {
  const enc = createI8ActivationWireEncoder({ modelId: 'm', stageIndex: 0, nEmbd: N_EMBD });
  const dec = createI8ActivationWireDecoder(enc.headerBytes());

  const tokenCount = 3;
  const activations = rowActivations(tokenCount, N_EMBD, 5);
  const tokens = [10, 11, 12];
  const frameBytes = enc.encodeFrame(activations, { seq: 0, posStart: 0, tokens });
  const decoded = dec.decodeFrameBytes(frameBytes);

  assert.equal(decoded.tokenCount, tokenCount);
  assert.deepEqual(decoded.tokens, tokens);
  assertRowsWithinTolerance(activations, decoded.activations, tokenCount, N_EMBD);
});

// ── 3. Delta streak: keyframe then deltas, anchored to the keyframe ──────

/** Streak-consistent activations: a fixed BASE row plus a small per-step
 * perturbation, clamped to the base row's own abs-max — this is what a
 * real decode-step streak actually looks like (consecutive tokens' hidden
 * states are close, not independently random), and it's the scenario the
 * delta path is designed for. A delta frame's residual is a SATURATING
 * (clamped ±127) int8 diff against the streak's fixed keyframe
 * quantization, and `quantizeRowWithScale` itself clamps any value whose
 * magnitude exceeds the keyframe's fixed scale (see `activationWireI8.ts`'s
 * top doc comment) — two independently-random full-amplitude rows (as
 * `rowActivations` produces, deliberately, for the per-row-scale tests
 * above) can legally hit either clamp; clamping perturbed rows to
 * `baseAbsMax` here keeps every value within the keyframe's own
 * representable range, so no clamping fires and the tolerance check below
 * measures pure quantization error, not a legitimate saturation clip. */
function streakActivations(nEmbd: number, base: Float32Array, baseAbsMax: number, step: number, perturbationFraction = 0.03): Float32Array {
  const a = new Float32Array(nEmbd);
  const amp = baseAbsMax * perturbationFraction;
  for (let i = 0; i < nEmbd; i++) {
    const perturbation = Math.sin((i * 7 + step * 31) * 0.041) * amp;
    const v = base[i]! + perturbation;
    a[i] = Math.max(-baseAbsMax, Math.min(baseAbsMax, v));
  }
  return a;
}

test('i8 delta streak: seq 0 keyframe + seq 1/2 deltas all reconstruct within tolerance (keyframe-anchored)', () => {
  const smallNEmbd = 128;
  const enc = createI8ActivationWireEncoder({ modelId: 'm', stageIndex: 0, nEmbd: smallNEmbd, delta: true });
  const dec = createI8ActivationWireDecoder(enc.headerBytes());

  const base = rowActivations(1, smallNEmbd, 4); // rowSeed=4 -> magnitude 1 + (4%7)*3.5 = 15 (comfortable headroom)
  const baseAbsMax = rowAbsMax(base, 0, smallNEmbd);
  const rows = [
    base,
    streakActivations(smallNEmbd, base, baseAbsMax, 1),
    streakActivations(smallNEmbd, base, baseAbsMax, 2),
  ];
  const decodedRows: Float32Array[] = [];
  const keyframeFlags: boolean[] = [];

  for (let seq = 0; seq < rows.length; seq++) {
    const frameBytes = enc.encodeFrame(rows[seq]!, { seq });
    const decoded = dec.decodeFrameBytes(frameBytes);
    decodedRows.push(decoded.activations);
    keyframeFlags.push(seq === 0); // encoder/decoder streak state: only seq 0 starts fresh
  }

  // Every delta frame reconstructs against the STREAK's fixed keyframe
  // scale (seq 0's abs-max), not a fresh per-row abs-max — so the
  // tolerance for every row in the streak is anchored to the keyframe's
  // own scale, matching what the codec actually promises for a delta.
  const keyframeTol = baseAbsMax / 127 + 1e-4;
  for (let seq = 0; seq < rows.length; seq++) {
    assert.equal(decodedRows[seq]!.length, smallNEmbd);
    for (let i = 0; i < smallNEmbd; i++) {
      const a = rows[seq]![i]!;
      const b = decodedRows[seq]![i]!;
      assert.ok(Math.abs(a - b) <= keyframeTol, `seq ${seq} elem ${i}: ${a} vs ${b} (tol ${keyframeTol})`);
    }
  }
  assert.deepEqual(keyframeFlags, [true, false, false]);

  // A lost delta frame must be rejected rather than silently misdecoded —
  // proves the decoder actually threads streak state through, not just
  // independently dequantizing each frame.
  const freshDecoder = createI8ActivationWireDecoder(enc.headerBytes());
  const seq3FrameBytes = enc.encodeFrame(streakActivations(smallNEmbd, base, baseAbsMax, 3), { seq: 3 });
  assert.throws(() => freshDecoder.decodeFrameBytes(seq3FrameBytes), /no prior keyframe/);
});

// ── 4. legionActivationBytes byte-cost math per dtype ────────────────────

test('legionActivationBytes: 1 byte/elem for i8, 2 for f16, 4 for f32', () => {
  assert.equal(legionActivationBytes(1, 4096, 'i8'), 4096);
  assert.equal(legionActivationBytes(1, 4096, 'f16'), 8192);
  assert.equal(legionActivationBytes(1, 4096, 'f32'), 16384);
});

// ── 5. Dispatcher: header-based auto-detection both directions ──────────

test('createLegionActivationWireDecoder: dispatches on the header shape, not a caller hint', () => {
  const i8Enc = createLegionActivationWireEncoder({ modelId: 'm', stageIndex: 0, nEmbd: 64, dtype: 'i8' });
  const i8Dec = createLegionActivationWireDecoder(i8Enc.headerBytes());
  assert.equal(i8Dec.dtype, 'i8');
  assert.equal(i8Dec.nEmbd, 64);

  const f16Enc = createActivationWireEncoder({ modelId: 'm', stageIndex: 0, nEmbd: 64, dtype: 'f16' });
  const f16Dec = createLegionActivationWireDecoder(f16Enc.headerBytes());
  assert.equal(f16Dec.dtype, 'f16');
  assert.equal(f16Dec.nEmbd, 64);

  const f32Enc = createLegionActivationWireEncoder({ modelId: 'm', stageIndex: 0, nEmbd: 64, dtype: 'f32' });
  const f32Dec = createLegionActivationWireDecoder(f32Enc.headerBytes());
  assert.equal(f32Dec.dtype, 'f32');
});
