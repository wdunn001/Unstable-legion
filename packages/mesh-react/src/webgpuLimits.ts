/**
 * One-shot WebGPU adapter probe shared by `useStageHost` (advertises
 * capacity) and `useStagePipeline` (weighs its own local stage-0 budget).
 * Kept tiny and side-effect-free (no React) so both call sites get the
 * same "what can this peer host" answer.
 */
import type { StageHostLimits } from './stagePipelinePlanning.js';

export interface WebGpuLimitsResult {
  ok: boolean;
  reason?: string;
  limits?: StageHostLimits;
}

const UNSUPPORTED_REASON =
  'this browser does not expose WebGPU. Chrome 113+ desktop with a discrete/integrated GPU is the floor.';

export async function detectWebGpuLimits(): Promise<WebGpuLimitsResult> {
  if (typeof navigator === 'undefined') return { ok: false, reason: 'no navigator (non-browser context)' };
  // @ts-expect-error — navigator.gpu lib.dom coverage varies by TS lib target
  const gpu = navigator.gpu;
  if (!gpu) return { ok: false, reason: UNSUPPORTED_REASON };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'navigator.gpu.requestAdapter() returned null' };
    return {
      ok: true,
      limits: { maxStorageBufferBindingSize: Number(adapter.limits?.maxStorageBufferBindingSize ?? 0) },
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
