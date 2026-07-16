/**
 * GPU auto-probe — "how much GPU storage-buffer capacity can this device
 * actually hold" for the "Contribute more" panel's auto-detect button.
 *
 * ── Why not just read a number from the adapter ──────────────────────────
 * WebGPU deliberately never exposes total VRAM (fingerprinting surface).
 * The only way to learn a real ceiling is to actually try allocating and
 * see where it breaks.
 *
 * ── Method ────────────────────────────────────────────────────────────
 * Repeatedly allocate `STORAGE`-usage buffers of a conservative fixed step
 * size (not one giant buffer — real hosting uses MANY separate per-layer
 * buffers summing to the total, and a single huge buffer would hit
 * `maxStorageBufferBindingSize` long before real capacity is exhausted),
 * keeping every successful allocation alive so the cumulative total
 * reflects "can this GPU actually hold this many bytes at once" rather
 * than "can it hold one buffer this big". Each attempt is wrapped in
 * `device.pushErrorScope('out-of-memory')` / `await device.popErrorScope()`
 * so an out-of-memory condition surfaces as a normal (non-throwing)
 * result the probe can back off from, instead of an uncaught exception or
 * (worst case) the device being lost. Stops at the first failed step, a
 * hard cap (default ~24GB, override via `opts.maxBytes` up to ~32GB), or
 * successfully reaching the cap. Every allocated buffer is destroyed in a
 * `finally` — success or failure, the probe leaves no lasting GPU
 * footprint. Returns ~75% of the total that succeeded (headroom for the
 * KV cache / activations / browser overhead / other tabs a real hosting
 * session will also need).
 *
 * ── CRASH RISK — read before wiring this to a UI button ──────────────────
 * `pushErrorScope`/`popErrorScope` are best-effort, not a hard guarantee:
 * some GPU drivers/browsers don't support the `'out-of-memory'` error
 * scope filter at all (this probe still runs — `supportsErrorScope` gates
 * it off cleanly) and some report OOM by losing the WHOLE GPUDevice
 * (`device.lost` resolves) rather than via the error scope, which this
 * probe cannot distinguish from "everything is fine" mid-loop. On a
 * fragile/shared/virtualized GPU (common in cheap VPS/CI/RDP sessions)
 * repeatedly allocating GPU memory can stress the system enough to
 * destabilize OTHER GPU-using processes, not just this tab. The UI MUST
 * warn the user before invoking this (see HostingConsentBanner's
 * "Contribute more" panel) — this is stress-testing real hardware, not a
 * side-effect-free read.
 */

export interface GpuProbeResult {
  ok: boolean;
  reason?: string;
  /** ~75% of the largest cumulative allocation that succeeded, bytes.
   * `undefined` when `ok` is false. */
  vramBytes?: number;
}

/** Minimal structural surface this module needs from a WebGPU device —
 * deliberately narrower than lib.dom's `GPUDevice` so tests can inject a
 * plain fake without pulling in real WebGPU types. The real
 * `navigator.gpu` satisfies this structurally at runtime. */
export interface MinimalGpuBuffer {
  destroy(): void;
}
export interface MinimalGpuDevice {
  createBuffer(desc: { size: number; usage: number; mappedAtCreation?: boolean }): MinimalGpuBuffer;
  pushErrorScope?: (filter: 'out-of-memory' | 'validation' | 'internal') => void;
  popErrorScope?: () => Promise<unknown>;
  destroy?: () => void;
}
export interface MinimalGpuAdapter {
  requestDevice(): Promise<MinimalGpuDevice>;
}
export interface MinimalGpu {
  requestAdapter(): Promise<MinimalGpuAdapter | null>;
}

export interface GpuProbeOptions {
  /** Injectable for tests — defaults to `navigator.gpu`. */
  gpu?: MinimalGpu;
  /** Bytes per allocation step. Default 512MB — conservative enough that
   * a failure is cheap to back off from and doesn't itself risk a huge
   * single allocation tripping a driver-specific ceiling unrelated to
   * total available memory. */
  stepBytes?: number;
  /** Hard cap — the probe NEVER attempts to accumulate past this
   * regardless of how much more the driver might allow. Default ~24GB
   * (conservative); the UI may raise it, but this module itself also
   * refuses to exceed `PROBE_ABSOLUTE_MAX_BYTES` (~32GB) no matter what
   * a caller passes. */
  maxBytes?: number;
  /** Called after every attempted step (success or failure) — lets a
   * caller show live progress without needing to poll. */
  onStep?: (info: { cumulativeBytes: number; ok: boolean }) => void;
}

export const DEFAULT_PROBE_STEP_BYTES = 512_000_000;
export const DEFAULT_PROBE_MAX_BYTES = 24_000_000_000;
/** Absolute ceiling this module will never exceed, regardless of
 * `opts.maxBytes` — matches `CONTRIBUTION_BUDGET_CEILING_BYTES`
 * (`@unstable-legion/react`'s `stagePipelinePlanning.ts`), so a probe
 * result is always representable as a valid `contributionBudgetBytes`. */
export const PROBE_ABSOLUTE_MAX_BYTES = 32_000_000_000;
/** Fraction of the successfully-probed total actually offered as the
 * suggested budget — headroom for KV cache/activations/browser overhead/
 * other tabs, which a real hosting session also needs from the same GPU. */
export const PROBE_HEADROOM_FRACTION = 0.75;

// WebGPU's `GPUBufferUsage.STORAGE` bit — a stable spec value (0x0080).
// Inlined as a literal (rather than referencing the `GPUBufferUsage`
// global) so this module never depends on `@webgpu/types` being part of
// this project's `lib` set, and never throws a ReferenceError in a
// non-browser/test environment just from constructing the createBuffer
// descriptor.
const STORAGE_USAGE_FLAG = 0x0080;

function realGpu(): MinimalGpu | undefined {
  if (typeof navigator === 'undefined') return undefined;
  // @ts-expect-error — navigator.gpu lib.dom coverage varies by TS lib target
  return navigator.gpu as MinimalGpu | undefined;
}

/** One allocation attempt — returns `true`/pushes the buffer onto `out`
 * on success, `false` on any failure (error-scope-reported OOM, a
 * synchronous throw some drivers use instead, or `popErrorScope` itself
 * rejecting). Never throws. */
async function tryAllocateStep(device: MinimalGpuDevice, sizeBytes: number, out: MinimalGpuBuffer[]): Promise<boolean> {
  const supportsErrorScope = typeof device.pushErrorScope === 'function' && typeof device.popErrorScope === 'function';
  try {
    if (supportsErrorScope) device.pushErrorScope!('out-of-memory');
    const buffer = device.createBuffer({ size: sizeBytes, usage: STORAGE_USAGE_FLAG });
    if (supportsErrorScope) {
      const error = await device.popErrorScope!().catch(() => undefined);
      if (error) {
        try {
          buffer.destroy();
        } catch {
          /* best-effort */
        }
        return false;
      }
    }
    out.push(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the probe. Never throws — every failure mode (no WebGPU, adapter
 * denied, device request failed, first step already fails) comes back as
 * `{ ok: false, reason }`. See this module's doc comment for the CRASH
 * RISK caveat before wiring this to a UI button.
 */
export async function probeGpuAllocatableBytes(opts: GpuProbeOptions = {}): Promise<GpuProbeResult> {
  const gpu = opts.gpu ?? realGpu();
  if (!gpu) return { ok: false, reason: 'WebGPU is not available in this browser' };

  let device: MinimalGpuDevice;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'navigator.gpu.requestAdapter() returned null' };
    device = await adapter.requestDevice();
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  const stepBytes = Math.max(1, Math.floor(opts.stepBytes ?? DEFAULT_PROBE_STEP_BYTES));
  const maxBytes = Math.min(Math.max(stepBytes, opts.maxBytes ?? DEFAULT_PROBE_MAX_BYTES), PROBE_ABSOLUTE_MAX_BYTES);

  const buffers: MinimalGpuBuffer[] = [];
  let cumulativeBytes = 0;
  try {
    while (cumulativeBytes + stepBytes <= maxBytes) {
      const ok = await tryAllocateStep(device, stepBytes, buffers);
      if (ok) cumulativeBytes += stepBytes;
      opts.onStep?.({ cumulativeBytes, ok });
      if (!ok) break;
    }
  } finally {
    // ALWAYS destroy every allocated buffer — success, failure, or an
    // unexpected throw mid-loop — the probe must never leave a lasting
    // GPU-memory footprint behind.
    for (const buffer of buffers) {
      try {
        buffer.destroy();
      } catch {
        /* best-effort */
      }
    }
    try {
      device.destroy?.();
    } catch {
      /* best-effort */
    }
  }

  if (cumulativeBytes === 0) {
    return { ok: false, reason: 'could not allocate even the first probe step — this GPU may be out of free memory, or storage buffers are unsupported here' };
  }
  return { ok: true, vramBytes: Math.floor(cumulativeBytes * PROBE_HEADROOM_FRACTION) };
}
