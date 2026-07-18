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
 * MANIFEST WIRED: the per-layer package manifest for `qwen3-8b-q4` IS
 * deployed (/webllm/stages/qwen3-8b-q4/model-package.json — layer-package
 * format, 36 per-layer fragments + shared embeddings/output). `manifestUrl()`
 * returns it, so `useCommunalChat` + every communal host pull ONLY their
 * assigned layer fragments via `fragmentsForRange`. There is NO full.gguf
 * staged for 8B (it's 4.9GB — the whole point of per-layer artifacts is to
 * never fetch the monolith); requesting it 404s, which is why the fallback
 * path must not be used for the production model.
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

// ── Model channels ───────────────────────────────────────────────────────
//
// The app offers a small set of interchangeable communal MODELS ("channels").
// Each channel is its OWN mesh — peers only host for others sharing the same
// `modelId` — so switching channel means leaving one mesh, joining another,
// and pulling that model's layer fragments. Default stays Qwen3-8B (proven,
// phone-verified); Qwen3-14B is opt-in. Switching PERSISTS the choice and
// RELOADS the page: a model swap re-downloads GBs and re-inits every
// host/driver hook regardless, so a clean reload is safer than hot-swapping
// `modelId` through the live hook tree. `?testModel=1` still overrides
// everything (below) for e2e/dev.

export interface ChatModelChannelSpec {
  /** modelId — the mesh-coordination key every peer matches on. */
  id: string;
  displayName: string;
  quant: string;
  totalLayers: number;
  driverLayers: number;
  ctxSize: number;
  nEmbd: number;
  avgLayerBytes: number;
  /** Primary manifest source: the model's HF `model-package.json` (CORS-
   * enabled, RELATIVE fragment paths so the weights come from HF too). A
   * same-origin `/webllm/` mirror is appended as an independent fallback. */
  hfManifestUrl: string;
}

export const CHAT_CHANNELS: readonly ChatModelChannelSpec[] = [
  {
    id: CHAT_MODEL_ID, // 'qwen3-8b-q4'
    displayName: CHAT_MODEL_DISPLAY_NAME,
    quant: CHAT_MODEL_QUANT,
    totalLayers: CHAT_TOTAL_LAYERS,
    driverLayers: CHAT_DRIVER_LAYERS,
    ctxSize: CHAT_CTX_SIZE,
    nEmbd: CHAT_N_EMBD,
    avgLayerBytes: CHAT_AVG_LAYER_BYTES,
    hfManifestUrl: 'https://huggingface.co/wdunn001/legion-model-qwen3-8b/resolve/main/model-package.json',
  },
  {
    // Qwen3-14B (huggingface.co/Qwen/Qwen3-14B config.json): num_hidden_layers=40,
    // hidden_size=5120, num_key_value_heads=8, head_dim=128 → KV = 2*8*128*1 =
    // 2048 (same int8-KV constant as 8B). q4_K_M GGUF ~9GB / 40 layers ≈ 230MB
    // upper-bound per layer (layer-000 measured 216MB). Untied embeddings
    // (manifest shared.output.tensor_count=2); embeddings tensor ~437MB, so a
    // phone (128MB storage-buffer cap) is a THIN client here too and needs a
    // serving host — which the resident-stage-0 reuse path now provides.
    id: 'qwen3-14b-q4',
    displayName: 'Qwen3-14B',
    quant: 'Q4_K_M',
    totalLayers: 40,
    driverLayers: 2,
    ctxSize: 4096,
    nEmbd: 5120,
    avgLayerBytes: 230_000_000,
    hfManifestUrl: 'https://huggingface.co/wdunn001/legion-model-qwen3-14b/resolve/main/model-package.json',
  },
  {
    // Qwen3-32B (huggingface.co/Qwen/Qwen3-32B config.json): num_hidden_layers=64,
    // hidden_size=5120, num_key_value_heads=8, head_dim=128 → KV = 2*8*128*1 =
    // 2048 (same int8-KV constant). q4_K_M GGUF ~20GB / 64 layers ≈ 315MB per
    // layer (layer-000 measured 315MB → ~320MB upper bound). Untied embeddings
    // (manifest shared.output.tensor_count=2); embeddings tensor ~437MB (thin
    // phones need a serving host here too). Manifest + layer fragments
    // CORS-verified on HF (access-control-allow-origin:*). At ~20GB this is a
    // heavy model — expect to split it across several peers (or load from a
    // local folder, see useModelFolder); solo-on-one-tab is unproven.
    id: 'qwen3-32b-q4',
    displayName: 'Qwen3-32B',
    quant: 'Q4_K_M',
    totalLayers: 64,
    driverLayers: 2,
    ctxSize: 4096,
    nEmbd: 5120,
    avgLayerBytes: 320_000_000,
    hfManifestUrl: 'https://huggingface.co/wdunn001/legion-model-qwen3-32b/resolve/main/model-package.json',
  },
];

export const DEFAULT_CHANNEL_ID = CHAT_MODEL_ID;

const CHANNEL_STORAGE_KEY = 'legion:model-channel';

/** The persisted channel selection (localStorage). Falls back to the default
 * (Qwen3-8B) for an unset / unknown / since-removed id, and outside a
 * browser. */
export function getStoredChannelId(): string {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(CHANNEL_STORAGE_KEY) : null;
    if (raw && CHAT_CHANNELS.some((c) => c.id === raw)) return raw;
  } catch {
    /* storage blocked (private mode / SSR) — fall through to default */
  }
  return DEFAULT_CHANNEL_ID;
}

/** Persist a channel selection (no-op for an unknown id or unavailable
 * storage). Does NOT reload — the caller (the picker) owns that. */
export function setStoredChannelId(id: string): void {
  if (!CHAT_CHANNELS.some((c) => c.id === id)) return;
  try {
    localStorage?.setItem(CHANNEL_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

/** Weight-distribution manifest sources for a channel, ORDERED by priority —
 * fed to `resolveCommunalShardPlan`, which takes the first source that
 * fetches + parses and resolves relative fragment paths against the WINNER:
 *   1. Hugging Face (the channel's `hfManifestUrl`) — primary. Free global
 *      CDN, CORS verified, LFS oids match the manifest sha256s; its manifest
 *      carries RELATIVE paths so the weights come from HF too.
 *   2. same-origin `/webllm/stages/<id>/model-package.json` (.198 mirror) —
 *      fallback, fully independent of HF (manifest AND weights same-origin).
 * Both describe byte-identical content-addressed artifacts, so OPFS-cached
 * fragments hit regardless of which source a session resolved through. */
function channelManifestUrls(ch: ChatModelChannelSpec): readonly string[] {
  const localPath = `/webllm/stages/${ch.id}/model-package.json`;
  // MUST be absolute: fragmentsForRange resolves each fragment via
  // `new URL(fragment.path, manifestUrl)`, which throws on a site-relative base.
  const local =
    typeof location !== 'undefined' && location.origin ? new URL(localPath, location.origin).toString() : localPath;
  return [ch.hfManifestUrl, local];
}

/** Fallback-only monolith path (never used in production — the per-layer
 * manifest is; a full.gguf isn't staged for these models). */
function channelShardUrls(ch: ChatModelChannelSpec): readonly string[] {
  return [`/webllm/stages/${ch.id}/full.gguf`];
}

/** Human-facing Hugging Face repo page for a channel — where a user can
 * download the model weights to load from a local folder (see
 * `useModelFolder` / `ModelFolderPanel`). Derived from the channel's
 * `hfManifestUrl` (`…/resolve/main/model-package.json` → `…/tree/main`) so
 * there's still ONE source of truth per channel. Returns undefined if the
 * manifest URL isn't an HF `/resolve/` URL (e.g. a future self-hosted-only
 * channel), so the panel simply omits the link rather than linking somewhere
 * wrong. */
export function channelDownloadUrl(ch: ChatModelChannelSpec): string | undefined {
  const marker = '/resolve/main/';
  const at = ch.hfManifestUrl.indexOf(marker);
  return at === -1 ? undefined : `${ch.hfManifestUrl.slice(0, at)}/tree/main`;
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
  manifestUrl: string | readonly string[] | undefined;
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
  /**
   * Wire dtype for the per-token activation frames crossing pipeline-stage
   * hops (see docs/WIRE-DTYPE.md) — how many bytes per nEmbd-wide
   * hidden-state vector travel the wire per hop. Default `'i8'` (quantized,
   * ~4x smaller than `'f32'`; see `activationWireI8.ts`). Overridable via
   * `?wireDtype=f16` / `?wireDtype=f32` (same e2e/local-dev query-param
   * idiom as `?testModel=1`) for A/B bandwidth testing without a rebuild —
   * see `wire-dtype.spec.ts`.
   */
  wireDtype: 'f32' | 'f16' | 'i8';
  /** Hugging Face repo page for this model's weights, for the local-folder
   * panel's "download the weights" link. Undefined for the test model (no
   * public repo) and any channel whose manifest isn't an HF `/resolve/` URL. */
  downloadUrl?: string;
}

const VALID_WIRE_DTYPES = new Set(['f32', 'f16', 'i8']);

/** Parse `?wireDtype=` from `location.search`. Falls back to `'i8'` for
 * anything unset/unrecognized — production default is the quantized wire
 * route; a typo'd/stale query param still yields a supported dtype. */
function resolveWireDtype(params: URLSearchParams | undefined): 'f32' | 'f16' | 'i8' {
  const raw = params?.get('wireDtype');
  return raw && VALID_WIRE_DTYPES.has(raw) ? (raw as 'f32' | 'f16' | 'i8') : 'i8';
}

/** Resolve the effective model config for the current page. `channelId`
 * defaults to the persisted selection (Qwen3-8B when unset). Reads
 * `?testModel=1` from `location.search`, which OVERRIDES the channel — see
 * module doc. Safe to call outside a browser (SSR/tests): falls back to the
 * default channel. Pass `channelId` explicitly in tests to avoid storage. */
export function resolveChatModelConfig(channelId: string = getStoredChannelId()): ChatModelConfig {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : undefined;
  const isTestModel = params?.get('testModel') === '1';
  // e2e resilience knob: point a host at a shard URL that 404s so the load
  // deterministically fails — exercises the backoff + error-surfacing path
  // (Part A) without depending on a flaky real fetch failure. Test-only,
  // same query-param idiom as `?testModel=1`; never affects production.
  const badShard = params?.get('badShard') === '1';
  const wireDtype = resolveWireDtype(params);

  if (isTestModel) {
    return {
      modelId: TEST_MODEL_ID,
      totalLayers: TEST_TOTAL_LAYERS,
      driverLayers: TEST_DRIVER_LAYERS,
      ctxSize: TEST_CTX_SIZE,
      nEmbd: TEST_N_EMBD,
      avgLayerBytes: TEST_AVG_LAYER_BYTES,
      manifestUrl: undefined,
      shardUrls: badShard
        ? () => [`/webllm/stages/${TEST_MODEL_ID}/does-not-exist-e2e.gguf`]
        : () => testShardUrls(),
      isTestModel: true,
      displayName: TEST_MODEL_DISPLAY_NAME,
      modelLabel: `${chatModelLabel(TEST_MODEL_DISPLAY_NAME, TEST_MODEL_QUANT)} (test model)`,
      wireDtype,
    };
  }

  const ch =
    CHAT_CHANNELS.find((c) => c.id === channelId) ??
    CHAT_CHANNELS.find((c) => c.id === DEFAULT_CHANNEL_ID) ??
    CHAT_CHANNELS[0]!;
  return {
    modelId: ch.id,
    totalLayers: ch.totalLayers,
    driverLayers: ch.driverLayers,
    ctxSize: ch.ctxSize,
    nEmbd: ch.nEmbd,
    avgLayerBytes: ch.avgLayerBytes,
    manifestUrl: channelManifestUrls(ch),
    shardUrls: () => channelShardUrls(ch),
    isTestModel: false,
    displayName: ch.displayName,
    modelLabel: chatModelLabel(ch.displayName, ch.quant),
    wireDtype,
    downloadUrl: channelDownloadUrl(ch),
  };
}
