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
 * OPTIONAL-STAGE0 — the DEMO/TEST-MODEL floor: the minimum WebGPU
 * `maxStorageBufferBindingSize` the tiny `qwen3-0.6b-q8_0` test model needs
 * to host even stage 0. This is NOT a real per-model capability check — it
 * was calibrated to the 0.6B test model's ~128MB stage-0 weight slab, and a
 * production model's single largest storage-buffer allocation (the shared
 * embeddings tensor) can be several times bigger (350MB for the shipped
 * Qwen3-8B channel, ~430MB for a 14B one) — a phone whose adapter reports
 * 128MB `maxStorageBufferBindingSize` clears THIS floor and then crashes on
 * the real allocation. Kept as-is (some tests/callers still import it as a
 * flat constant) — a real app should classify with `isThinDriverForModel`
 * against `requiredStorageBufferBytesForManifest(manifest)` for the
 * CURRENT channel instead. See `docs/OPTIONAL-STAGE0.md`. */
export const USABLE_STAGE_HOST_MIN_BYTES = 128 * 1024 * 1024;

/**
 * Classify a `detectWebGpuLimits()` result as a THIN driver (can't host any
 * stage) vs. a capable one, against a FLAT byte floor. Thin iff WebGPU is
 * absent/unusable OR the adapter's `maxStorageBufferBindingSize` is below
 * `minBytes`. FALLBACK ONLY — `minBytes` defaults to
 * `USABLE_STAGE_HOST_MIN_BYTES` (the demo/test-model floor, see its doc
 * comment), which under-classifies a real production model on a
 * memory-constrained device. The real per-model decision is
 * `isThinDriverForModel` against `requiredStorageBufferBytesForManifest
 * (manifest)` for the channel actually in use. Kept for existing callers/
 * tests that don't (yet) have a manifest in hand. A thin driver hosts NO
 * local stage-0 worker and relies on a remote isFirst communal host (see
 * `useCommunalChat`'s `thinDriver`/`textRelay` modes). Pure — no probe, so
 * a caller can classify a cached result without re-hitting the adapter. */
export function isThinDriver(
  result: WebGpuLimitsResult,
  minBytes: number = USABLE_STAGE_HOST_MIN_BYTES,
): boolean {
  if (!result.ok || !result.limits) return true;
  return result.limits.maxStorageBufferBindingSize < minBytes;
}

/**
 * OPTIONAL-STAGE0 Phase 2 — derives the required single-storage-buffer
 * bytes to host stage 0 for a GIVEN model's parsed manifest: the shared
 * embeddings artifact's `tensor_bytes` (the largest single GPU buffer a
 * stage-0 host must bind in one `maxStorageBufferBindingSize`-limited
 * allocation — see `@unstable-legion/stage-runtime`'s `LayerPackageManifest`,
 * structurally compatible with the narrower shape accepted here so a caller
 * can pass either the full parsed manifest or a minimal test fixture).
 * Self-describing per model/channel — NOT a hardcoded constant, so a 14B (or
 * any future) channel classifies correctly without a code change. */
export function requiredStorageBufferBytesForManifest(manifest: { shared: { embeddings: { tensor_bytes: number } } }): number {
  return manifest.shared.embeddings.tensor_bytes;
}

/**
 * OPTIONAL-STAGE0 Phase 2 — the REAL, model-aware thin-driver classifier an
 * app should use instead of the flat `isThinDriver`/`USABLE_STAGE_HOST_MIN_BYTES`
 * floor (see that export's doc comment for why the flat floor under-classifies
 * a real production model). Thin iff WebGPU is absent/unusable OR the
 * adapter's `maxStorageBufferBindingSize` is below `requiredStorageBufferBytes`
 * — typically `requiredStorageBufferBytesForManifest(manifest)` for the
 * channel's CURRENT model. Pure — no probe, so a caller can classify a
 * cached `detectWebGpuLimits()` result once the manifest resolves. */
export function isThinDriverForModel(result: WebGpuLimitsResult, requiredStorageBufferBytes: number): boolean {
  if (!result.ok || !result.limits) return true;
  return result.limits.maxStorageBufferBindingSize < requiredStorageBufferBytes;
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
