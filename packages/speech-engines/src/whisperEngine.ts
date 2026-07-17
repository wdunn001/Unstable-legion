/**
 * `createWhisperEngine` — transformers.js (`@huggingface/transformers`
 * 3.8.1) Whisper backend for the `SpeechEngine` interface.
 *
 * Model choice: `Xenova/whisper-base` — a small (~74M param), multilingual
 * Whisper checkpoint with a pre-converted ONNX repo that transformers.js
 * v3's pipeline loads out of the box (the `Xenova/*` mirror namespace is
 * still first-class in v3; `onnx-community/*` is the newer re-conversion
 * namespace used in the v3 WebGPU guide, either works — `Xenova/whisper-base`
 * was picked because it's the exact model transformers.js's own docs use
 * for a full ASR-with-segments example, and `-base` is a reasonable
 * quality/size tradeoff for a mesh-hosted PoC vs. `-tiny`).
 *
 * Quantization: no explicit `dtype` override. transformers.js v3 already
 * picks a sane per-device default (`fp32` on WebGPU, `q8` on wasm) — see
 * the "Using quantized models (dtypes)" guide. A future pass could pin
 * `dtype: 'q4'` to shrink the WebGPU download once this is more than a
 * PoC.
 *
 * Device selection: tries `webgpu` first (fast, GPU-resident), falls back
 * to `wasm` (CPU, works everywhere but slower). No cross-origin isolation
 * is required: WebGPU needs none, and onnxruntime-web's wasm backend
 * detects a non-isolated page and runs single-threaded automatically —
 * the same posture the LLM path already takes. See this package's README.
 *
 * Weight sourcing: model weights are fetched from an ordered list of
 * remote hosts (`modelSources`), first reachable wins. The default is
 * Hugging Face Hub PRIMARY (where the ONNX repo already lives — no infra
 * of ours to maintain) with the self-hosted Legion CDN as FALLBACK for
 * offline / HF-down resilience — the same "public mirror primary,
 * self-host fallback" policy the LLM model layers use. transformers.js
 * has no native failover, so we set `env.remoteHost` per attempt and
 * retry. The onnxruntime-web `.wasm` binary location is `wasmPaths`
 * (transformers.js' own public CDN by default; point it at the Legion
 * CDN to self-host).
 */
import type { AsrTranscribeContent } from '@unstable-legion/core';
import type { SpeechEngine, SpeechEngineInput } from './types.js';

/** Hugging Face Hub — primary weight source (HF-layout `{model}/resolve/{rev}/`). */
export const HF_MODEL_HOST = 'https://huggingface.co/';

/**
 * Self-hosted fallback mirror on the Legion CDN. Must mirror the HF
 * repo layout under this root (`<root>/Xenova/whisper-base/resolve/main/…`)
 * so the default `remotePathTemplate` resolves unchanged. Populate with
 * `scripts/mirror-whisper-to-cdn.sh`. The exact path must match the CDN
 * deploy; override via `modelSources` if it differs.
 */
export const LEGION_MODEL_FALLBACK_HOST = 'https://cdn.codecai.net/webllm/hf/';

export interface WhisperEngineOptions {
  /** HF model id / repo. Default `Xenova/whisper-base`. */
  modelId?: string;
  /** Force a device instead of the webgpu-then-wasm probe. */
  device?: 'webgpu' | 'wasm';
  /** Explicit quantization override. Default: let transformers.js pick per-device. */
  dtype?: string;
  /**
   * Ordered remote hosts to try for model weights; first reachable wins.
   * Default: `[HF_MODEL_HOST, LEGION_MODEL_FALLBACK_HOST]` (HF primary,
   * Legion CDN fallback).
   */
  modelSources?: string[];
  /**
   * Override the onnxruntime-web wasm binary location
   * (`env.backends.onnx.wasm.wasmPaths`). Default: transformers.js' own
   * public CDN. Set to the Legion CDN wasm mirror to self-host.
   */
  wasmPaths?: string;
}

type AsrPipeline = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<{
  text: string;
  chunks?: Array<{ text: string; timestamp: [number, number | null] }>;
}>;

/** Cheap WebGPU presence probe — avoids a doomed webgpu load attempt (and a
 * wasted fallback-source retry) on browsers without `navigator.gpu`. */
function hasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && !!(navigator as { gpu?: unknown }).gpu;
}

/** Lazily imported so `@huggingface/transformers` (and its onnxruntime-web
 * payload) only hits the network/bundle when a speech engine is actually
 * constructed — most mesh peers never opt in to ASR hosting. */
async function loadTransformers() {
  const mod = await import('@huggingface/transformers');
  return { pipeline: mod.pipeline, env: mod.env };
}

export async function createWhisperEngine(opts: WhisperEngineOptions = {}): Promise<SpeechEngine> {
  const modelId = opts.modelId ?? 'Xenova/whisper-base';
  const { pipeline, env } = await loadTransformers();

  if (opts.wasmPaths && env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = opts.wasmPaths;
  }

  const sources =
    opts.modelSources && opts.modelSources.length > 0
      ? opts.modelSources
      : [HF_MODEL_HOST, LEGION_MODEL_FALLBACK_HOST];
  // Device dominates ordering (GPU speed matters more than which host
  // serves identical bytes): webgpu@source0, webgpu@source1, wasm@source0…
  const devicesToTry: Array<'webgpu' | 'wasm'> = opts.device
    ? [opts.device]
    : hasWebGpu()
      ? ['webgpu', 'wasm']
      : ['wasm'];

  let device: 'webgpu' | 'wasm' | undefined;
  let transcriber: AsrPipeline | undefined;
  let lastErr: unknown;

  outer: for (const candidate of devicesToTry) {
    for (const host of sources) {
      try {
        env.allowRemoteModels = true;
        env.remoteHost = host;
        const pipelineOpts: Record<string, unknown> = { device: candidate };
        if (opts.dtype) pipelineOpts.dtype = opts.dtype;
        transcriber = (await pipeline(
          'automatic-speech-recognition',
          modelId,
          pipelineOpts,
        )) as unknown as AsrPipeline;
        device = candidate;
        break outer;
      } catch (err) {
        lastErr = err;
        transcriber = undefined;
      }
    }
  }

  if (!transcriber || !device) {
    throw new Error(
      `whisper engine: failed to initialize on any device (${devicesToTry.join(', ')}) ` +
        `from any source (${sources.join(', ')}): ${
          lastErr instanceof Error ? lastErr.message : String(lastErr)
        }`,
    );
  }

  const id = `${modelId.replace(/^.*\//, '')}/${device}`;
  const resolvedTranscriber = transcriber;

  return {
    id,
    async transcribe(input: SpeechEngineInput): Promise<AsrTranscribeContent> {
      const startedAt = Date.now();
      const output = await resolvedTranscriber(input.pcm, {
        return_timestamps: true,
        ...(input.language ? { language: input.language } : {}),
      });
      const durationMs = Date.now() - startedAt;
      const segments = output.chunks?.map((c) => ({
        text: c.text,
        start: c.timestamp[0],
        end: c.timestamp[1] ?? c.timestamp[0],
      }));
      return {
        text: output.text.trim(),
        language: input.language,
        durationMs,
        engine: id,
        ...(segments && segments.length > 0 ? { segments } : {}),
      };
    },
  };
}
