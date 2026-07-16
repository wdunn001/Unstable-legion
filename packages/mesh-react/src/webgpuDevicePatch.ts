/**
 * Monkeypatch installed in a stage-hosting worker (see stageWorker.ts in
 * apps/chat and apps/demo) BEFORE the legion-stage wasm module is
 * instantiated, fixing a WebGPU device buffer-limit bug that otherwise
 * makes 8B+ models unusable.
 *
 * ── Root cause ────────────────────────────────────────────────────────
 * `GGML_WEBGPU`'s C++ init (third_party/llama.cpp, vendored — not
 * something this repo can patch without a wasm rebuild) calls
 * `adapter.requestDevice()` with NO `requiredLimits`, so the spun-up
 * `GPUDevice` gets the WebGPU spec's DEFAULT limits (`maxBufferSize`
 * 256MB, `maxStorageBufferBindingSize` 128MB) even when the ADAPTER
 * itself reports far more. Observed live while loading Qwen3-8B's 34
 * communal layers, repeated hundreds of times:
 *
 *   "Buffer size (512000000) exceeds the max buffer size limit
 *    (268435456). This adapter supports a higher maxBufferSize of
 *    2147483648, which can be specified in requiredLimits when calling
 *    requestDevice()."
 *
 * ── Fix ───────────────────────────────────────────────────────────────
 * Intercept every `GPUAdapter.requestDevice()` call in this worker/tab
 * and merge the CALLING ADAPTER'S OWN reported limits into
 * `requiredLimits` (only for keys the caller didn't already specify).
 * Requesting exactly what the adapter already advertises can never
 * exceed what it supports — this is safe by construction, no guessing
 * or hardcoded numbers.
 *
 * Installed at module load in the worker entry point, ahead of the
 * `loadStage()` call that triggers wasm instantiation (see
 * `wasm-loader.ts`'s "wasm module: instantiating (incl. WebGPU
 * adapter/device request)" phase). Idempotent (a second `loadStage()`
 * call, or a second stage loaded in the same worker/tab, must not
 * double-wrap) and feature-detected (`GPUAdapter` absent in Node test
 * hosts / browsers without WebGPU at all — never throws either way).
 */

const PATCH_FLAG = '__legionWebGpuDeviceLimitsPatched__';

/** The limit keys GGML_WEBGPU's largest allocations exceed at spec
 * defaults — kept to exactly what's needed rather than mirroring the
 * adapter's entire `GPUSupportedLimits` (a device request only
 * recognizes specific limit names; forwarding an unknown one risks a
 * validation error on some implementations). */
const RELEVANT_LIMIT_KEYS = ['maxBufferSize', 'maxStorageBufferBindingSize', 'maxComputeWorkgroupStorageSize'] as const;

export type WebGpuLimitKey = (typeof RELEVANT_LIMIT_KEYS)[number];
export type WebGpuLimitsSource = Partial<Record<WebGpuLimitKey, number>>;

/**
 * Pure merge: caller-supplied `requiredLimits` values always win (this
 * patch only ADDS what the caller didn't already ask for); an adapter
 * limit that's missing/zero/non-numeric/non-finite is skipped rather
 * than written as e.g. 0 (a 0 buffer-size limit would be actively worse
 * than the spec default). Exported standalone so it's unit-testable
 * against a fake adapter's `.limits` without touching a real
 * GPUAdapter/GPUDevice.
 */
export function mergeAdapterLimitsIntoRequiredLimits(
  requiredLimits: Record<string, number> | undefined,
  adapterLimits: WebGpuLimitsSource,
): Record<string, number> {
  const merged: Record<string, number> = { ...(requiredLimits ?? {}) };
  for (const key of RELEVANT_LIMIT_KEYS) {
    if (merged[key] !== undefined) continue; // caller already specified this one — never override it
    const value = adapterLimits[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) merged[key] = value;
  }
  return merged;
}

interface PatchableGpuAdapterCtor {
  prototype: {
    requestDevice?: (this: { limits?: WebGpuLimitsSource }, descriptor?: Record<string, unknown>) => Promise<unknown>;
  };
}

/**
 * Install the patch on `GPUAdapter.prototype.requestDevice` in the
 * current global scope. Safe to call multiple times / from multiple call
 * sites — a no-op after the first successful install, and a no-op
 * (never throws) when `GPUAdapter` isn't present at all.
 */
export function patchWebGpuDeviceLimits(target: typeof globalThis = globalThis): void {
  const g = target as unknown as { GPUAdapter?: PatchableGpuAdapterCtor; [PATCH_FLAG]?: boolean };
  if (g[PATCH_FLAG]) return;
  const proto = g.GPUAdapter?.prototype;
  const original = proto?.requestDevice;
  if (!proto || typeof original !== 'function') return; // no WebGPU here (Node test host, unsupported browser)

  proto.requestDevice = function patchedRequestDevice(
    this: { limits?: WebGpuLimitsSource },
    descriptor?: Record<string, unknown>,
  ) {
    const requiredLimits = mergeAdapterLimitsIntoRequiredLimits(
      descriptor?.requiredLimits as Record<string, number> | undefined,
      this.limits ?? {},
    );
    return original.call(this, { ...(descriptor ?? {}), requiredLimits });
  };
  g[PATCH_FLAG] = true;
}
