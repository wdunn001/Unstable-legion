/**
 * OPTIONAL-STAGE0 — the thin-driver capability gate (`isThinDriver`).
 * Pure classification over a `detectWebGpuLimits()` result, so it's tested
 * directly without a WebGPU adapter (same "pull the pure logic out" precedent
 * as `economyWiring.test.ts`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isThinDriver, USABLE_STAGE_HOST_MIN_BYTES } from '../src/webgpuLimits.ts';

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
