/**
 * Single source of truth for "where do stage shard bytes come from."
 *
 * Phase C target state is manifest-based per-layer artifacts
 * (`StageLoadPayload.manifestUrl`, see `stageControl.ts`); today (and for
 * this demo) every stage — local or remote — loads the SAME full gguf and
 * lets `loadStage`'s runtime tensor filter slice out its own
 * [layerStart, layerEnd) range (see legion-stage-runtime's
 * `modelConfig.ts` doc comment on `splitDescriptors()` for why: "both
 * stages load full.gguf rather than a pre-sliced shard — skippy engine
 * gap, Phase A/B"). Centralizing the URL here means swapping to
 * manifest-based per-layer fetch later is a one-file change — nothing in
 * `useStageHost`/`useStagePipeline` hardcodes a path.
 */

export const STAGE_MODEL_ID = 'qwen3-0.6b-q8_0';
export const STAGE_TOTAL_LAYERS = 28;
/** Layers the DRIVER always hosts locally in the communal (M3/M4) pipeline —
 * the communal claim/coverage space every host and driver agrees on is
 * `[STAGE_DRIVER_LAYERS, STAGE_TOTAL_LAYERS)`. Centralized here (rather than
 * each communal call site hardcoding the same magic number) because a
 * mismatch between what a driver hosts locally and what
 * `communalHostClaim` anchors its ranges against would silently corrupt
 * coverage — see `communalTopology.ts`'s frontier-walk doc comment. */
export const STAGE_DRIVER_LAYERS = 2;
export const STAGE_CTX_SIZE = 512;
/** Approximate per-layer weight bytes for qwen3-0.6b-q8_0 (SLICING.md)  —
 * used by the planner when a real per-layer manifest isn't available. */
export const STAGE_AVG_LAYER_BYTES = 22_000_000;
export const STAGE_N_EMBD = 1024;

/** Public path (relative to a page's own origin) to the full gguf. */
export function stageShardPath(): string {
  return `/webllm/stages/${STAGE_MODEL_ID}/full.gguf`;
}

/** Resolve `stageShardPath()` against `baseUrl` — every stage in this demo
 * fetches from ITS OWN origin (same Vite/nginx serves all pages), so
 * callers normally omit `baseUrl` and get a page-relative URL. */
export function stageShardUrl(baseUrl?: string): string {
  return baseUrl ? new URL(stageShardPath(), baseUrl).toString() : stageShardPath();
}

export function stageShardUrls(baseUrl?: string): readonly string[] {
  return [stageShardUrl(baseUrl)];
}

/** Public path to the wasm glue module `stageWorker.ts` dynamic-imports. */
export function stageWasmGlueUrl(origin: string): string {
  return new URL('/wasm/legion-stage.js', origin).toString();
}
