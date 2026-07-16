import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAdapterLimitsIntoRequiredLimits, patchWebGpuDeviceLimits } from '../src/webgpuDevicePatch.ts';

test('mergeAdapterLimitsIntoRequiredLimits: fills in the relevant keys from the adapter when the caller specified none', () => {
  const merged = mergeAdapterLimitsIntoRequiredLimits(undefined, {
    maxBufferSize: 2147483648,
    maxStorageBufferBindingSize: 2147483644,
    maxComputeWorkgroupStorageSize: 32768,
  });
  assert.deepEqual(merged, {
    maxBufferSize: 2147483648,
    maxStorageBufferBindingSize: 2147483644,
    maxComputeWorkgroupStorageSize: 32768,
  });
});

test('mergeAdapterLimitsIntoRequiredLimits: never overrides a value the caller already specified', () => {
  const merged = mergeAdapterLimitsIntoRequiredLimits(
    { maxBufferSize: 999 },
    { maxBufferSize: 2147483648, maxStorageBufferBindingSize: 2147483644 },
  );
  assert.equal(merged.maxBufferSize, 999);
  assert.equal(merged.maxStorageBufferBindingSize, 2147483644);
});

test('mergeAdapterLimitsIntoRequiredLimits: preserves unrelated caller-supplied keys untouched', () => {
  const merged = mergeAdapterLimitsIntoRequiredLimits({ maxBindGroups: 4 }, { maxBufferSize: 2147483648 });
  assert.equal(merged.maxBindGroups, 4);
  assert.equal(merged.maxBufferSize, 2147483648);
});

test('mergeAdapterLimitsIntoRequiredLimits: skips missing/zero/negative/non-finite adapter values instead of writing a worse-than-default limit', () => {
  const merged = mergeAdapterLimitsIntoRequiredLimits(undefined, {
    maxBufferSize: 0,
    maxStorageBufferBindingSize: Number.NaN,
    // maxComputeWorkgroupStorageSize omitted entirely
  });
  assert.deepEqual(merged, {});
});

test('mergeAdapterLimitsIntoRequiredLimits: real-world numbers from the live bug report resolve correctly', () => {
  // The adapter that reported "This adapter supports a higher maxBufferSize
  // of 2147483648" in the live console log this fix was written against.
  const merged = mergeAdapterLimitsIntoRequiredLimits(undefined, {
    maxBufferSize: 2147483648,
    maxStorageBufferBindingSize: 2147483644,
  });
  // The failing allocation (512000000 bytes) now fits comfortably under
  // the requested device limit, unlike the spec default (268435456).
  assert.ok(merged.maxBufferSize! > 512_000_000);
  assert.ok(merged.maxStorageBufferBindingSize! > 512_000_000);
});

// ── patchWebGpuDeviceLimits: install behavior against a fake global ──────

function fakeGpuGlobal(limits: Record<string, number>, calls: { descriptors: unknown[] }) {
  class FakeGpuAdapter {
    limits = limits;
    async requestDevice(descriptor?: Record<string, unknown>) {
      calls.descriptors.push(descriptor);
      return { __fakeDevice: true, descriptor };
    }
  }
  return { GPUAdapter: FakeGpuAdapter } as unknown as typeof globalThis;
}

test('patchWebGpuDeviceLimits: wraps requestDevice so it forwards the adapter-derived requiredLimits', async () => {
  const calls = { descriptors: [] as unknown[] };
  const fakeGlobal = fakeGpuGlobal({ maxBufferSize: 2147483648, maxStorageBufferBindingSize: 2147483644 }, calls);
  patchWebGpuDeviceLimits(fakeGlobal);

  const adapter = new (fakeGlobal as unknown as { GPUAdapter: new () => { requestDevice: (d?: Record<string, unknown>) => Promise<unknown> } }).GPUAdapter();
  await adapter.requestDevice();

  assert.equal(calls.descriptors.length, 1);
  const forwarded = calls.descriptors[0] as { requiredLimits: Record<string, number> };
  assert.equal(forwarded.requiredLimits.maxBufferSize, 2147483648);
  assert.equal(forwarded.requiredLimits.maxStorageBufferBindingSize, 2147483644);
});

test('patchWebGpuDeviceLimits: idempotent — a second install call does not double-wrap', async () => {
  const calls = { descriptors: [] as unknown[] };
  const fakeGlobal = fakeGpuGlobal({ maxBufferSize: 2147483648 }, calls);
  patchWebGpuDeviceLimits(fakeGlobal);
  const wrappedOnce = (fakeGlobal as unknown as { GPUAdapter: { prototype: { requestDevice: unknown } } }).GPUAdapter.prototype.requestDevice;
  patchWebGpuDeviceLimits(fakeGlobal);
  const wrappedTwice = (fakeGlobal as unknown as { GPUAdapter: { prototype: { requestDevice: unknown } } }).GPUAdapter.prototype.requestDevice;
  assert.equal(wrappedOnce, wrappedTwice, 'requestDevice must be wrapped exactly once');
});

test('patchWebGpuDeviceLimits: a caller-supplied requiredLimits value survives the patch untouched', async () => {
  const calls = { descriptors: [] as unknown[] };
  const fakeGlobal = fakeGpuGlobal({ maxBufferSize: 2147483648 }, calls);
  patchWebGpuDeviceLimits(fakeGlobal);
  const adapter = new (fakeGlobal as unknown as { GPUAdapter: new () => { requestDevice: (d?: Record<string, unknown>) => Promise<unknown> } }).GPUAdapter();
  await adapter.requestDevice({ requiredLimits: { maxBufferSize: 42 } });
  const forwarded = calls.descriptors[0] as { requiredLimits: Record<string, number> };
  assert.equal(forwarded.requiredLimits.maxBufferSize, 42);
});

test('patchWebGpuDeviceLimits: no-op (never throws) when GPUAdapter is absent — e.g. a Node test host', () => {
  assert.doesNotThrow(() => patchWebGpuDeviceLimits({} as unknown as typeof globalThis));
});
