/**
 * chatModelSource — this product's ONE fixed communal model: Qwen3-8B
 * (not a picker — see the M5 brief's "fixed for v1" decision). Mirrors
 * `@unstable-legion/react`'s `stageModelSource.ts` (single source of
 * truth for "where do stage shard bytes come from"), scoped to this app.
 *
 * Architecture constants (layers, hidden size) are Qwen3-8B's real
 * published config (huggingface.co/Qwen/Qwen3-8B: num_hidden_layers=36,
 * hidden_size=4096, num_key_value_heads=8, head_dim=128 — the
 * `KV_BYTES_PER_TOKEN_PER_LAYER` below, 2 * 8 * 128 * 1 byte = 2048,
 * matches an int8-quantized KV cache). `DRIVER_LAYERS=2` matches the
 * protocol-wide convention every communal host/driver already agrees on
 * (`STAGE_DRIVER_LAYERS` in mesh-react) — a driver always hosts layers
 * [0, DRIVER_LAYERS) locally, communal hosts cover the rest.
 *
 * HONEST STATE (same gap `docs/COMMUNAL.md` already documents for
 * `qwen3-0.6b-q8_0`): no per-layer manifest is deployed for
 * `qwen3-8b-q4` yet — `manifestUrl()` is left unwired here, same as
 * `CommunalHostPanel.tsx`'s own comment on this, and
 * `resolveCommunalShardPlan` falls back to `fallbackShardUrls()`
 * (Phase A/B "every stage loads the same full.gguf, the runtime tensor
 * filter slices its own layer range out of it" convention) cleanly.
 * Wiring a real manifest is a one-line change (`manifestUrl` prop on
 * `useCommunalHost`) once one is deployed — not required for this
 * milestone (M5 builds the app; M6 deploys it).
 *
 * `AVG_LAYER_BYTES` is a planning-upper-bound ESTIMATE (same role as
 * `STAGE_AVG_LAYER_BYTES` in mesh-react's doc comment: "real models have
 * non-uniform layer sizes; this is the same planning-upper-bound
 * simplification `stagePlanner.ts` uses") — Qwen3-8B q4 GGUF quantized
 * weights run ~5GB total; divided across 36 transformer layers (ignoring
 * embedding/lm_head, which this estimate deliberately over-counts into
 * layer cost to stay a conservative upper bound) gives ~140MB/layer.
 *
 * ── e2e / local-dev escape hatch ─────────────────────────────────────
 * Qwen3-8B's real shard bytes are multiple gigabytes and aren't fetchable
 * from every dev/CI box (no manifest deployed yet either — see above).
 * `resolveChatModelConfig()` honors a `?testModel=1` query param (same
 * e2e-only-knob idiom as the demo's `?room=`/`?spreadWidth=`) that swaps
 * every constant below for `@unstable-legion/react`'s already-proven
 * `qwen3-0.6b-q8_0` test model + its already-fetched `full.gguf` — the
 * SAME asset `apps/demo`'s communal.spec.ts drives real WebGPU inference
 * against. Production (no query param) always targets Qwen3-8B.
 */
import {
  STAGE_MODEL_ID as TEST_MODEL_ID,
  STAGE_TOTAL_LAYERS as TEST_TOTAL_LAYERS,
  STAGE_DRIVER_LAYERS as TEST_DRIVER_LAYERS,
  STAGE_CTX_SIZE as TEST_CTX_SIZE,
  STAGE_N_EMBD as TEST_N_EMBD,
  STAGE_AVG_LAYER_BYTES as TEST_AVG_LAYER_BYTES,
  stageShardUrls as testShardUrls,
} from '@unstable-legion/react';

/** Qwen3-8B, q4 GGUF quantization — this product's ONE communal model. */
export const CHAT_MODEL_ID = 'qwen3-8b-q4';
/** Human-readable name + quant, shown prominently in the header and the
 * capacity meter (product UX requirement — the mesh's model identity
 * must never be hidden behind a bare percentage). Kept as named
 * constants here, not hardcoded into any component, so the ONE place
 * that changes when the target model changes is this file — see
 * `chatModelLabel()`, which is also the seam a future deployed manifest
 * would feed a real `format` string into instead of this constant (no
 * manifest exists yet — see this module's HONEST STATE note below). */
export const CHAT_MODEL_DISPLAY_NAME = 'Qwen3-8B';
export const CHAT_MODEL_QUANT = 'Q4_K_M';
/** Qwen3-8B: num_hidden_layers (huggingface.co/Qwen/Qwen3-8B config.json). */
export const CHAT_TOTAL_LAYERS = 36;
/** Protocol-wide driver-local-layers convention (matches `STAGE_DRIVER_LAYERS`). */
export const CHAT_DRIVER_LAYERS = 2;
/** Generous chat context — Qwen3-8B supports far more (40960), but KV
 * cost scales with ctxSize * layers hosted * KV_BYTES_PER_TOKEN_PER_LAYER,
 * and browser-tab hosts are memory-constrained; 4096 is a real, usable
 * multi-turn chat window without demanding desktop-class hosts only. */
export const CHAT_CTX_SIZE = 4096;
/** Qwen3-8B: hidden_size. */
export const CHAT_N_EMBD = 4096;
/** Qwen3-8B: 2 (K+V) * num_key_value_heads(8) * head_dim(128) * 1 byte
 * (int8-quantized KV cache) — informational protocol constant matching
 * the target manifest's `kv_bytes_per_token_per_layer` field. */
export const CHAT_KV_BYTES_PER_TOKEN_PER_LAYER = 2048;
/** Planning-upper-bound per-layer weight-byte estimate — see module doc. */
export const CHAT_AVG_LAYER_BYTES = 140_000_000;

export function chatShardPath(): string {
  return `/webllm/stages/${CHAT_MODEL_ID}/full.gguf`;
}
export function chatShardUrls(baseUrl?: string): readonly string[] {
  const path = chatShardPath();
  return [baseUrl ? new URL(path, baseUrl).toString() : path];
}
/** No manifest deployed yet — see module doc's HONEST STATE note. Kept
 * as a named function (rather than a bare `undefined` export) so wiring
 * it later is a one-line body change, not a call-site hunt. */
export function chatManifestUrl(): string | undefined {
  return undefined;
}

/** "Qwen3-8B · Q4_K_M" — the exact "name + quant" pairing the product UI
 * surfaces (header pill, capacity meter, topology map). A pure,
 * unit-tested formatter rather than a string baked into a component, so
 * every surface that shows the model identity reads it from the same
 * place. */
export function chatModelLabel(displayName: string, quant: string): string {
  return `${displayName} · ${quant}`;
}

/** The `?testModel=1` swap's own display identity — see module doc's
 * "e2e / local-dev escape hatch". Qwen3-0.6B-Instruct, q8_0 GGUF
 * quantization (`@unstable-legion/react`'s `STAGE_MODEL_ID`). */
const TEST_MODEL_DISPLAY_NAME = 'Qwen3-0.6B';
const TEST_MODEL_QUANT = 'Q8_0';

export interface ChatModelConfig {
  modelId: string;
  totalLayers: number;
  driverLayers: number;
  ctxSize: number;
  nEmbd: number;
  avgLayerBytes: number;
  manifestUrl: string | undefined;
  shardUrls: () => readonly string[];
  /** True when this is the e2e/local-dev test-model swap, not the real
   * production target — surfaced so UI can (optionally) show a subtle
   * "test model" indicator instead of silently claiming Qwen3-8B. */
  isTestModel: boolean;
  /** "Qwen3-8B" / "Qwen3-0.6B" — name only, no quant. */
  displayName: string;
  /** "Qwen3-8B · Q4_K_M" — what the UI actually renders. Always includes
   * an explicit "(test model)" suffix when `isTestModel` so nobody
   * mistakes the e2e swap for the production target. */
  modelLabel: string;
}

/** Resolve the effective model config for the current page. Reads
 * `?testModel=1` from `location.search` — see module doc. Safe to call
 * outside a browser (SSR/tests): falls back to production Qwen3-8B. */
export function resolveChatModelConfig(): ChatModelConfig {
  const isTestModel =
    typeof location !== 'undefined' && new URLSearchParams(location.search).get('testModel') === '1';

  if (isTestModel) {
    return {
      modelId: TEST_MODEL_ID,
      totalLayers: TEST_TOTAL_LAYERS,
      driverLayers: TEST_DRIVER_LAYERS,
      ctxSize: TEST_CTX_SIZE,
      nEmbd: TEST_N_EMBD,
      avgLayerBytes: TEST_AVG_LAYER_BYTES,
      manifestUrl: undefined,
      shardUrls: () => testShardUrls(),
      isTestModel: true,
      displayName: TEST_MODEL_DISPLAY_NAME,
      modelLabel: `${chatModelLabel(TEST_MODEL_DISPLAY_NAME, TEST_MODEL_QUANT)} (test model)`,
    };
  }

  return {
    modelId: CHAT_MODEL_ID,
    totalLayers: CHAT_TOTAL_LAYERS,
    driverLayers: CHAT_DRIVER_LAYERS,
    ctxSize: CHAT_CTX_SIZE,
    nEmbd: CHAT_N_EMBD,
    avgLayerBytes: CHAT_AVG_LAYER_BYTES,
    manifestUrl: chatManifestUrl(),
    shardUrls: () => chatShardUrls(),
    isTestModel: false,
    displayName: CHAT_MODEL_DISPLAY_NAME,
    modelLabel: chatModelLabel(CHAT_MODEL_DISPLAY_NAME, CHAT_MODEL_QUANT),
  };
}
