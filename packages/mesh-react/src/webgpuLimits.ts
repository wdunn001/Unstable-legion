/**
 * One-shot WebGPU adapter probe shared by `useStageHost` (advertises
 * capacity) and `useStagePipeline` (weighs its own local stage-0 budget).
 * Kept tiny and side-effect-free (no React) so both call sites get the
 * same "what can this peer host" answer.
 *
 * ── GPU name detection (apps/chat's "Contribute more" panel) ────────────
 *
 * WebGPU deliberately never exposes total VRAM (fingerprinting surface —
 * see this module's `vramBytes` doc comments elsewhere in this package).
 * It DOES sometimes expose a renderer/vendor NAME via `adapter.info`
 * (newer spec surface) or the older `adapter.requestAdapterInfo()`
 * method — best-effort, often blank/generic in a fingerprinting-resistant
 * browser. When neither yields anything, a WebGL
 * `WEBGL_debug_renderer_info` extension query against a throwaway,
 * immediately-discarded canvas is the same best-effort fallback every
 * "detect my GPU" web tool uses; also often blank under fingerprinting
 * protection, never a crash either way.
 *
 * `gpuName`/`adapterInfo` are ONLY ever a display/pre-selection hint for
 * `apps/chat/src/gpuCatalog.ts`'s matcher — NEVER a source of truth for
 * `vramBytes`, which stays exactly what it always was (undefined, unless
 * an operator explicitly opts in via `contributionBudgetBytes`).
 */
import type { StageHostLimits } from './stagePipelinePlanning.js';

export interface WebGpuLimitsResult {
  ok: boolean;
  reason?: string;
  limits?: StageHostLimits;
}

const UNSUPPORTED_REASON =
  'this browser does not expose WebGPU. Chrome 113+ desktop with a discrete/integrated GPU is the floor.';

/** Best-effort `{ vendor, architecture, device, description }` from a
 * WebGPU adapter — tries the newer `adapter.info` property first, falls
 * back to the older `adapter.requestAdapterInfo()` method. Never throws;
 * returns `undefined` on any failure or when both surfaces are absent. */
async function readWebGpuAdapterInfo(
  adapter: unknown,
): Promise<{ vendor?: string; architecture?: string; device?: string; description?: string } | undefined> {
  try {
    const a = adapter as {
      info?: { vendor?: string; architecture?: string; device?: string; description?: string };
      requestAdapterInfo?: () => Promise<{ vendor?: string; architecture?: string; device?: string; description?: string }>;
    };
    const info = a.info ?? (typeof a.requestAdapterInfo === 'function' ? await a.requestAdapterInfo() : undefined);
    if (!info) return undefined;
    const { vendor, architecture, device, description } = info;
    if (!vendor && !architecture && !device && !description) return undefined;
    return { vendor, architecture, device, description };
  } catch {
    return undefined;
  }
}

/** Best-effort WebGL `UNMASKED_RENDERER_WEBGL` fallback — a throwaway
 * canvas that's never attached to the DOM and is discarded immediately
 * after the query (no lasting resource, no visible side effect). Never
 * throws; returns `undefined` when WebGL, the debug-info extension, or
 * fingerprinting protection blocks the read. */
function readWebglRendererName(): string | undefined {
  try {
    if (typeof document === 'undefined') return undefined;
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return undefined;
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (!ext) return undefined;
      const renderer = gl.getParameter((ext as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL);
      return typeof renderer === 'string' && renderer.length > 0 ? renderer : undefined;
    } finally {
      // Best-effort GPU resource release — `loseContext` isn't guaranteed
      // present, and losing it is purely a courtesy (the canvas itself
      // was never attached to the DOM and is GC-eligible either way).
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    return undefined;
  }
}

/** Derive the single "gpuName" display string from whichever source
 * succeeded — WebGPU adapter info (description, else device, else
 * vendor+architecture) takes priority over the WebGL fallback since it's
 * the more directly relevant surface (same API this peer actually hosts
 * over). */
function deriveGpuName(
  adapterInfo: { vendor?: string; architecture?: string; device?: string; description?: string } | undefined,
  webglRenderer: string | undefined,
): string | undefined {
  if (adapterInfo?.description) return adapterInfo.description;
  if (adapterInfo?.device) return adapterInfo.device;
  if (adapterInfo?.vendor || adapterInfo?.architecture) {
    return [adapterInfo.vendor, adapterInfo.architecture].filter(Boolean).join(' ');
  }
  return webglRenderer;
}

/**
 * OPTIONAL-STAGE0 — the minimum WebGPU `maxStorageBufferBindingSize` a
 * device needs before it can usefully host EVEN stage 0 (embeddings + the
 * first `driverLayers` layers of the smallest deployed model). Below this, a
 * device is a "thin driver": it can still tokenize/detokenize on the CPU
 * (wasm, no GPU) and drive a chat, but it must route its first stage to a
 * remote isFirst host. The floor is deliberately conservative — one storage
 * buffer binding must hold a stage-0 weight slab; ~128 MiB is the empirical
 * lower bound for the q8_0 demo model's stage-0 slice. See
 * `docs/OPTIONAL-STAGE0.md`. */
export const USABLE_STAGE_HOST_MIN_BYTES = 128 * 1024 * 1024;

/**
 * Classify a `detectWebGpuLimits()` result as a THIN driver (can't host any
 * stage) vs. a capable one. Thin iff WebGPU is absent/unusable OR the
 * adapter's `maxStorageBufferBindingSize` is below `USABLE_STAGE_HOST_MIN_BYTES`.
 * A thin driver hosts NO local stage-0 worker and relies on a remote isFirst
 * communal host (see `useCommunalChat`'s `thinDriver` mode). Pure — no probe,
 * so a caller can classify a cached result without re-hitting the adapter. */
export function isThinDriver(
  result: WebGpuLimitsResult,
  minBytes: number = USABLE_STAGE_HOST_MIN_BYTES,
): boolean {
  if (!result.ok || !result.limits) return true;
  return result.limits.maxStorageBufferBindingSize < minBytes;
}

export async function detectWebGpuLimits(): Promise<WebGpuLimitsResult> {
  if (typeof navigator === 'undefined') return { ok: false, reason: 'no navigator (non-browser context)' };
  // @ts-expect-error — navigator.gpu lib.dom coverage varies by TS lib target
  const gpu = navigator.gpu;
  if (!gpu) return { ok: false, reason: UNSUPPORTED_REASON };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'navigator.gpu.requestAdapter() returned null' };
    const adapterInfo = await readWebGpuAdapterInfo(adapter);
    const webglRenderer = adapterInfo ? undefined : readWebglRendererName();
    const gpuName = deriveGpuName(adapterInfo, webglRenderer);
    return {
      ok: true,
      limits: {
        maxStorageBufferBindingSize: Number(adapter.limits?.maxStorageBufferBindingSize ?? 0),
        ...(gpuName !== undefined ? { gpuName } : {}),
        ...(adapterInfo !== undefined ? { adapterInfo } : {}),
      },
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
