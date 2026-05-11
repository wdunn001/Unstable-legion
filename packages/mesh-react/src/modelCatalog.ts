/**
 * WebGPU model catalog — what the operator picks from in `PersonaForm`.
 *
 * Library-default catalog matches leet's `LEET_MESH_MODEL_CATALOG`
 * (mass-zero-fpv-saas/apps/leet/src/leetMeshPersona.ts) so a legion
 * peer and a leet peer can advertise overlapping `modelId`s in their
 * caps. Consumers can pass their own catalog into `PersonaForm` to
 * extend or trim the list.
 *
 * Every entry maps an MLC `model_id` to its tokenizer-map family in
 * codec-maps (`mapId`) so receiving peers know which detokenizer to
 * build. Adding a new entry means: (1) add the line here, (2) make
 * sure `cdn.jsdelivr.net/gh/wdunn001/codec-maps/maps/<family>.json`
 * exists, (3) optionally mirror the weights via
 * `scripts/mirror-webllm-models.sh` + add to the host's mirror
 * allow-list.
 */

export interface ModelCatalogEntry {
  /** MLC model_id, e.g. `Qwen2.5-0.5B-Instruct-q4f16_1-MLC`. */
  id: string;
  /** Operator-facing label shown in the picker. */
  label: string;
  /** Approximate download size in MB. Surfaced as a hint in the UI. */
  downloadMB: number;
  /** One-liner shown beneath the label. */
  tagline: string;
  /** codec-maps family id used to detokenize this model's output. */
  mapId: string;
  /** Suggested skill tags new operators pre-fill on this model. */
  defaultSkills?: readonly string[];
  /** Suggested system prompt new operators pre-fill on this model. */
  defaultSystemPrompt?: string;
}

/**
 * Default catalog. Each entry shipped here is in active use by the
 * leet AI mesh too. Order is download-size ascending — picker UIs
 * typically render top-down with the cheapest first.
 */
export const DEFAULT_MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: 'SmolLM2-360M-Instruct-q4f16_1-MLC',
    label: 'SmolLM2-360M',
    downloadMB: 200,
    tagline: 'Tiny — near-instant boot, weak coherence. Demo-only.',
    mapId: 'huggingfacetb/smollm2',
    defaultSkills: ['tinybot'],
    defaultSystemPrompt: 'You are a tiny chatbot. Keep answers under 20 words.',
  },
  {
    id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
    label: 'Qwen2.5-0.5B',
    downloadMB: 300,
    tagline: 'Fastest first-load, decent chat. Sensible default.',
    mapId: 'qwen/qwen2',
    defaultSkills: ['chat', 'summarize'],
    defaultSystemPrompt: 'You are a helpful assistant. Answer in 1-2 short sentences.',
  },
  {
    id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    label: 'Llama-3.2-1B',
    downloadMB: 600,
    tagline: 'Big quality jump from 0.5B. Still fits in <1 GB.',
    mapId: 'meta-llama/llama-3',
    defaultSkills: ['chat', 'summarize', 'translate'],
    defaultSystemPrompt: 'You are a helpful assistant. Be concise and direct.',
  },
  {
    id: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC',
    label: 'Qwen2.5-Coder-1.5B',
    downloadMB: 900,
    tagline: 'Coder-specialized. Best for code-review / completion peers.',
    mapId: 'qwen/qwen2',
    defaultSkills: ['code-review', 'code-completion', 'debugging'],
    defaultSystemPrompt:
      'You are a code reviewer. Identify bugs and suggest concrete fixes. Reply with diffs or annotated lines.',
  },
  {
    id: 'gemma-2-2b-jpn-it-q4f16_1-MLC',
    label: 'Gemma-2-2B-JPN (Japanese)',
    downloadMB: 1400,
    tagline: 'Japanese-tuned. Best for ja-translate / ja-chat peers.',
    mapId: 'google/gemma-2',
    defaultSkills: ['ja-translate', 'ja-chat'],
    defaultSystemPrompt: 'あなたは親切なアシスタントです。簡潔に答えてください。',
  },
  {
    id: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
    label: 'Hermes-3-Llama-3B (function-calling)',
    downloadMB: 1800,
    tagline:
      'Tuned for function-calling / tool use. Best fit for operating MCP tool calls in the mesh.',
    mapId: 'meta-llama/llama-3',
    defaultSkills: ['function-calling', 'tool-use', 'agent'],
    defaultSystemPrompt:
      'You are a tool-using agent. When a task can be solved with a tool the user has, call the tool. Keep narration brief.',
  },
  {
    id: 'Phi-3.5-mini-instruct-q4f16_1-MLC',
    label: 'Phi-3.5-mini',
    downloadMB: 2200,
    tagline: 'Strong reasoning for its size. ~2 GB; only worth it on broadband.',
    mapId: 'microsoft/phi-3',
    defaultSkills: ['reasoning', 'chat', 'qa'],
    defaultSystemPrompt:
      'You are a careful, thoughtful assistant. Show your reasoning briefly.',
  },
];

/** Look up a catalog entry by `modelId`. Returns undefined if not in the catalog. */
export function findModelEntry(
  catalog: readonly ModelCatalogEntry[],
  modelId: string,
): ModelCatalogEntry | undefined {
  return catalog.find((m) => m.id === modelId);
}

/**
 * Mobile-safe catalog. Same models as the default catalog but using the
 * `q4f32_1` quantization (4-bit weights, fp32 compute) instead of
 * `q4f16_1` (fp16 compute).
 *
 * **Why**: MLC web-llm on mobile WebGPU fails silently when the device's
 * `shader-f16` support is incomplete — the model "runs" but produces
 * mostly byte-level token IDs that don't form valid UTF-8, rendering
 * as a wall of U+FFFD replacement characters. fp32 compute is mandatory
 * in the WebGPU spec, so it works on any device that exposes WebGPU
 * at all.
 *
 * Trade-off: ~2× the download size for the same quality. Slower per-
 * token but works.
 */
export const MOBILE_MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: 'SmolLM2-360M-Instruct-q4f32_1-MLC',
    label: 'SmolLM2-360M (fp32)',
    downloadMB: 400,
    tagline: 'Mobile-safe smallest model. fp32 compute = works without shader-f16.',
    mapId: 'huggingfacetb/smollm2',
    defaultSkills: ['tinybot'],
    defaultSystemPrompt: 'You are a tiny chatbot. Keep answers under 20 words.',
  },
  {
    id: 'Qwen2.5-0.5B-Instruct-q4f32_1-MLC',
    label: 'Qwen2.5-0.5B (fp32)',
    downloadMB: 600,
    tagline: 'Mobile-safe default. fp32 compute = works without shader-f16.',
    mapId: 'qwen/qwen2',
    defaultSkills: ['chat', 'summarize'],
    defaultSystemPrompt: 'You are a helpful assistant. Answer in 1-2 short sentences.',
  },
  {
    id: 'Llama-3.2-1B-Instruct-q4f32_1-MLC',
    label: 'Llama-3.2-1B (fp32)',
    downloadMB: 1200,
    tagline: 'Mobile-safe bigger model. fp32 compute, more capable than 0.5B.',
    mapId: 'meta-llama/llama-3',
    defaultSkills: ['chat', 'summarize', 'translate'],
    defaultSystemPrompt: 'You are a helpful assistant. Be concise and direct.',
  },
];

/**
 * Heuristic mobile detection. WebGPU `shader-f16` issues correlate
 * strongly with Android Chrome / Edge — same population picked up
 * by a UA-string mobile match. iPhone Safari doesn't have WebGPU at
 * all yet (Safari 18+ partial), so this catches the right userbase.
 *
 * Override possible at App level — read this for the default, then
 * let the operator force a catalog via the persona's `bootMode`.
 */
export function detectMobileLikelyNeedsFp32(): boolean {
  if (typeof navigator === 'undefined') return false;
  // navigator.userAgentData is the modern API but Safari + Firefox
  // don't ship it; fall back to the UA string for those.
  const uaData = (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData && typeof uaData.mobile === 'boolean') return uaData.mobile;
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}
