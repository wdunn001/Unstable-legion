/**
 * OPTIONAL-STAGE0 — the thin-driver capability gate (`isThinDriver`).
 * Pure classification over a `detectWebGpuLimits()` result, so it's tested
 * directly without a WebGPU adapter (same "pull the pure logic out" precedent
 * as `economyWiring.test.ts`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isThinDriver,
  isThinDriverForModel,
  requiredStorageBufferBytesForManifest,
  USABLE_STAGE_HOST_MIN_BYTES,
} from '../src/webgpuLimits.ts';

test('isThinDriver: WebGPU absent -> thin', () => {
  assert.equal(isThinDriver({ ok: false, reason: 'no WebGPU' }), true);
});

test('isThinDriver: ok but no limits -> thin (can not size a stage)', () => {
  assert.equal(isThinDriver({ ok: true }), true);
});

test('isThinDriver: adapter below the usable floor -> thin', () => {
  assert.equal(
    isThinDriver({ ok: true, limits: { maxStorageBufferBindingSize: USABLE_STAGE_HOST_MIN_BYTES - 1 } }),
    true,
  );
});

test('isThinDriver: adapter at/above the floor -> capable', () => {
  assert.equal(
    isThinDriver({ ok: true, limits: { maxStorageBufferBindingSize: USABLE_STAGE_HOST_MIN_BYTES } }),
    false,
  );
  assert.equal(
    isThinDriver({ ok: true, limits: { maxStorageBufferBindingSize: 2 * 1024 * 1024 * 1024 } }),
    false,
  );
});

test('isThinDriver: custom threshold is honored', () => {
  const res = { ok: true as const, limits: { maxStorageBufferBindingSize: 100 } };
  assert.equal(isThinDriver(res, 50), false);
  assert.equal(isThinDriver(res, 200), true);
});

// ── OPTIONAL-STAGE0 Phase 2 — per-model capability classifier ────────────
// The flat 128MB `USABLE_STAGE_HOST_MIN_BYTES` was calibrated to the tiny
// 0.6B test model; production models need a per-model floor derived from
// their manifest's embeddings artifact — see `requiredStorageBufferBytesForManifest`
// / `isThinDriverForModel`'s doc comments.

const EIGHT_B_REQUIRED_BYTES = 350_060_544; // Qwen3-8B's shared embeddings tensor_bytes
const FOURTEEN_B_REQUIRED_BYTES = 430_000_000; // representative 14B-class figure

test('requiredStorageBufferBytesForManifest: derives the floor from shared.embeddings.tensor_bytes', () => {
  const manifest = { shared: { embeddings: { tensor_bytes: EIGHT_B_REQUIRED_BYTES } } };
  assert.equal(requiredStorageBufferBytesForManifest(manifest), EIGHT_B_REQUIRED_BYTES);

  const manifest14b = { shared: { embeddings: { tensor_bytes: FOURTEEN_B_REQUIRED_BYTES } } };
  assert.equal(requiredStorageBufferBytesForManifest(manifest14b), FOURTEEN_B_REQUIRED_BYTES);
});

test('isThinDriverForModel: a 128MB device is thin for an 8B channel requiring ~350MB (the phone-crash scenario the flat floor missed)', () => {
  const phone = { ok: true as const, limits: { maxStorageBufferBindingSize: USABLE_STAGE_HOST_MIN_BYTES } };
  // The OLD flat classifier would call this device capable...
  assert.equal(isThinDriver(phone), false, 'sanity: the flat 128MB floor clears this device');
  // ...but the per-model classifier correctly flags it thin for the real model.
  assert.equal(isThinDriverForModel(phone, EIGHT_B_REQUIRED_BYTES), true);
});

test('isThinDriverForModel: a 2GB device is capable for an 8B (or 14B) channel', () => {
  const desktop = { ok: true as const, limits: { maxStorageBufferBindingSize: 2 * 1024 * 1024 * 1024 } };
  assert.equal(isThinDriverForModel(desktop, EIGHT_B_REQUIRED_BYTES), false);
  assert.equal(isThinDriverForModel(desktop, FOURTEEN_B_REQUIRED_BYTES), false);
});

test('isThinDriverForModel: boundary — exactly at the requirement is capable, one byte under is thin', () => {
  const atFloor = { ok: true as const, limits: { maxStorageBufferBindingSize: EIGHT_B_REQUIRED_BYTES } };
  assert.equal(isThinDriverForModel(atFloor, EIGHT_B_REQUIRED_BYTES), false);

  const belowFloor = { ok: true as const, limits: { maxStorageBufferBindingSize: EIGHT_B_REQUIRED_BYTES - 1 } };
  assert.equal(isThinDriverForModel(belowFloor, EIGHT_B_REQUIRED_BYTES), true);
});

test('isThinDriverForModel: WebGPU absent/unusable is always thin, regardless of the requirement', () => {
  assert.equal(isThinDriverForModel({ ok: false, reason: 'no WebGPU' }, EIGHT_B_REQUIRED_BYTES), true);
  assert.equal(isThinDriverForModel({ ok: true }, EIGHT_B_REQUIRED_BYTES), true);
});
