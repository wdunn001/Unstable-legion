/**
 * gpuProbe.ts unit tests — the auto-detect probe's backoff/accumulation
 * logic, driven against a fake WebGPU device (never touches a real GPU).
 * Covers: normal growth, OOM-triggered backoff via error scope, drivers
 * lacking error-scope support (synchronous throw instead), every
 * allocated buffer destroyed regardless of outcome, and the hard cap.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  probeGpuAllocatableBytes,
  DEFAULT_PROBE_STEP_BYTES,
  PROBE_ABSOLUTE_MAX_BYTES,
  PROBE_HEADROOM_FRACTION,
  type MinimalGpu,
  type MinimalGpuDevice,
  type MinimalGpuBuffer,
} from '../src/gpuProbe.ts';

/** A fake buffer that records whether it was destroyed. */
function fakeBuffer(destroyedFlags: boolean[], index: number): MinimalGpuBuffer {
  return {
    destroy() {
      destroyedFlags[index] = true;
    },
  };
}

/**
 * Builds a fake device that OOMs once cumulative allocated bytes would
 * exceed `oomAtBytes` — reports it via the error-scope protocol when
 * `supportsErrorScope` is true, else throws synchronously from
 * `createBuffer` (simulating a driver without error-scope support).
 */
function makeFakeGpu(opts: { oomAtBytes: number; supportsErrorScope: boolean }): {
  gpu: MinimalGpu;
  destroyedFlags: boolean[];
  deviceDestroyed: { value: boolean };
} {
  const destroyedFlags: boolean[] = [];
  const deviceDestroyed = { value: false };
  let index = 0;
  let cumulative = 0;
  let lastCallOversized = false;

  const device: MinimalGpuDevice = {
    createBuffer(desc) {
      const nextTotal = cumulative + desc.size;
      if (nextTotal > opts.oomAtBytes) {
        if (!opts.supportsErrorScope) {
          throw new Error('simulated synchronous OOM (no error-scope support)');
        }
        // Error-scope path: `createBuffer` itself still returns a (later
        // destroyed, never actually "real") buffer object — the OOM is
        // reported via the FOLLOWING `popErrorScope()` call, matching the
        // real WebGPU error-scope protocol.
        lastCallOversized = true;
        return fakeBuffer(destroyedFlags, index++);
      }
      lastCallOversized = false;
      cumulative = nextTotal;
      return fakeBuffer(destroyedFlags, index++);
    },
    destroy() {
      deviceDestroyed.value = true;
    },
  };
  if (opts.supportsErrorScope) {
    device.pushErrorScope = () => undefined;
    device.popErrorScope = async () => (lastCallOversized ? { message: 'out of memory' } : null);
  }

  const gpu: MinimalGpu = {
    async requestAdapter() {
      return {
        async requestDevice() {
          return device;
        },
      };
    },
  };
  return { gpu, destroyedFlags, deviceDestroyed };
}

test('probeGpuAllocatableBytes: no WebGPU -> ok:false, never throws', async () => {
  const result = await probeGpuAllocatableBytes({ gpu: undefined });
  assert.equal(result.ok, false);
  assert.ok(result.reason);
});

test('probeGpuAllocatableBytes: adapter denied -> ok:false, never throws', async () => {
  const gpu: MinimalGpu = { async requestAdapter() { return null; } };
  const result = await probeGpuAllocatableBytes({ gpu });
  assert.equal(result.ok, false);
});

test('probeGpuAllocatableBytes: grows in steps until OOM (error-scope path), backs off, returns 75% of the accumulated total', async () => {
  const oomAtBytes = 2_000_000_000; // fails once cumulative would exceed 2GB
  const { gpu, destroyedFlags, deviceDestroyed } = makeFakeGpu({ oomAtBytes, supportsErrorScope: true });
  const stepBytes = 500_000_000;
  const result = await probeGpuAllocatableBytes({ gpu, stepBytes, maxBytes: 10_000_000_000 });
  assert.equal(result.ok, true);
  // 4 successful steps of 500MB = 2GB exactly fits; the 5th (2.5GB) would exceed 2GB and OOMs.
  const expectedCumulative = 2_000_000_000;
  assert.equal(result.vramBytes, Math.floor(expectedCumulative * PROBE_HEADROOM_FRACTION));
  // every allocated buffer (including the OOM'd one that got a buffer object back) was destroyed
  assert.ok(destroyedFlags.length > 0);
  assert.ok(destroyedFlags.every(Boolean), 'every allocated buffer must be destroyed');
  assert.equal(deviceDestroyed.value, true);
});

test('probeGpuAllocatableBytes: robust to drivers lacking error-scope support (synchronous throw backoff)', async () => {
  const oomAtBytes = 1_000_000_000;
  const { gpu, destroyedFlags } = makeFakeGpu({ oomAtBytes, supportsErrorScope: false });
  const stepBytes = 300_000_000;
  const result = await probeGpuAllocatableBytes({ gpu, stepBytes, maxBytes: 10_000_000_000 });
  assert.equal(result.ok, true);
  // 3 steps of 300MB = 900MB fits; 4th (1.2GB) throws synchronously and is caught.
  assert.equal(result.vramBytes, Math.floor(900_000_000 * PROBE_HEADROOM_FRACTION));
  assert.ok(destroyedFlags.every(Boolean));
});

test('probeGpuAllocatableBytes: first step already fails -> ok:false with a descriptive reason', async () => {
  const { gpu } = makeFakeGpu({ oomAtBytes: 0, supportsErrorScope: true });
  const result = await probeGpuAllocatableBytes({ gpu, stepBytes: 500_000_000 });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /could not allocate/);
});

test('probeGpuAllocatableBytes: never exceeds PROBE_ABSOLUTE_MAX_BYTES even if a caller passes a larger maxBytes', async () => {
  const { gpu } = makeFakeGpu({ oomAtBytes: 999_000_000_000, supportsErrorScope: true }); // effectively never OOMs
  const result = await probeGpuAllocatableBytes({ gpu, stepBytes: 4_000_000_000, maxBytes: 999_000_000_000 });
  assert.equal(result.ok, true);
  // vramBytes is 75% of accumulated total, and accumulated total itself must never exceed the absolute ceiling.
  const impliedTotal = (result.vramBytes ?? 0) / PROBE_HEADROOM_FRACTION;
  assert.ok(impliedTotal <= PROBE_ABSOLUTE_MAX_BYTES + 1, `implied cumulative ${impliedTotal} exceeded the absolute cap`);
});

test('probeGpuAllocatableBytes: onStep fires for every attempt with running progress', async () => {
  const { gpu } = makeFakeGpu({ oomAtBytes: 1_500_000_000, supportsErrorScope: true });
  const steps: { cumulativeBytes: number; ok: boolean }[] = [];
  await probeGpuAllocatableBytes({ gpu, stepBytes: 500_000_000, maxBytes: 5_000_000_000, onStep: (s) => steps.push(s) });
  assert.ok(steps.length >= 3);
  assert.equal(steps[steps.length - 1]!.ok, false); // ends on a failure (backed off)
  assert.equal(steps[0]!.ok, true);
});

test('probeGpuAllocatableBytes: default step size is a conservative fixed constant, not caller-required', () => {
  assert.ok(DEFAULT_PROBE_STEP_BYTES > 0 && DEFAULT_PROBE_STEP_BYTES < 1_000_000_000);
});
