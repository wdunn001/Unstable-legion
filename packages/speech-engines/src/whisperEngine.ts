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
 * to `wasm` (CPU, works everywhere but slower and needs COOP/COEP headers
 * for the threaded build — see this package's README).
 */
import type { AsrTranscribeContent } from '@unstable-legion/core';
import type { SpeechEngine, SpeechEngineInput } from './types.js';

export interface WhisperEngineOptions {
  /** HF model id / repo. Default `Xenova/whisper-base`. */
  modelId?: string;
  /** Force a device instead of the webgpu-then-wasm probe. */
  device?: 'webgpu' | 'wasm';
  /** Explicit quantization override. Default: let transformers.js pick per-device. */
  dtype?: string;
}

type AsrPipeline = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<{
  text: string;
  chunks?: Array<{ text: string; timestamp: [number, number | null] }>;
}>;

/** Lazily imported so `@huggingface/transformers` (and its onnxruntime-web
 * payload) only hits the network/bundle when a speech engine is actually
 * constructed — most mesh peers never opt in to ASR hosting. */
async function loadPipelineFactory() {
  const mod = await import('@huggingface/transformers');
  return mod.pipeline;
}

export async function createWhisperEngine(opts: WhisperEngineOptions = {}): Promise<SpeechEngine> {
  const modelId = opts.modelId ?? 'Xenova/whisper-base';
  const pipeline = await loadPipelineFactory();

  let device = opts.device;
  let transcriber: AsrPipeline | undefined;
  let lastErr: unknown;

  const devicesToTry: Array<'webgpu' | 'wasm'> = device ? [device] : ['webgpu', 'wasm'];
  for (const candidate of devicesToTry) {
    try {
      const pipelineOpts: Record<string, unknown> = { device: candidate };
      if (opts.dtype) pipelineOpts.dtype = opts.dtype;
      transcriber = (await pipeline(
        'automatic-speech-recognition',
        modelId,
        pipelineOpts,
      )) as unknown as AsrPipeline;
      device = candidate;
      break;
    } catch (err) {
      lastErr = err;
      transcriber = undefined;
    }
  }

  if (!transcriber || !device) {
    throw new Error(
      `whisper engine: failed to initialize on any device (${devicesToTry.join(', ')}): ${
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
