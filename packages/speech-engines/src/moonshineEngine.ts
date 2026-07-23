/**
 * `createMoonshineEngine` — transformers.js (`@huggingface/transformers`
 * 3.8.1, the SAME package `whisperEngine.ts` uses) Moonshine backend for
 * the `SpeechEngine` interface. Mirrors `whisperEngine.ts` structurally —
 * same device probe, same HF-primary/Legion-CDN-fallback weight sourcing,
 * same empty-pcm guard, same `[legion-speech]` logging shape — the two
 * files intentionally read almost identically so a future third ASR
 * engine has an obvious template to copy.
 *
 * Model choice: `onnx-community/moonshine-tiny-ONNX` — a 5.8M-param
 * Moonshine checkpoint built specifically for fast, low-latency voice
 * commands (vs. Whisper's general-purpose dictation focus). This is the
 * LOCAL "wake-ear" engine: conversation mode's continuous VAD routes its
 * utterances through this engine instead of `whisperEngine.ts` so
 * wake-phrase detection never needs a mesh round-trip (see
 * `@unstable-legion/react`'s `useMoonshineTranscriber` + `worker.ts`'s
 * per-request `engine` field). Manual push-to-talk and "🎙 Listen" are
 * untouched and keep using Whisper.
 *
 * Quantization: `fp32` on WebGPU, `q8` on wasm — same reasoning
 * `kokoroEngine.ts` documents (full fp32 decode on CPU is slower; the
 * moonshine-tiny-ONNX repo also ships int8/fp16 variants a future pass
 * could pin instead). Explicit `opts.dtype` always wins.
 *
 * Device selection: tries `webgpu` first, falls back to `wasm` — identical
 * probe to `whisperEngine.ts`/`kokoroEngine.ts`.
 *
 * Weight sourcing: same "public mirror primary, self-host fallback" policy
 * as the other two engines — HF Hub primary, Legion CDN fallback, with
 * `env.remoteHost` set per attempt since transformers.js has no native
 * failover.
 */
import type { AsrTranscribeContent } from '@unstable-legion/core';
import type { EngineLoadProgress, SpeechEngine, SpeechEngineInput } from './types.js';

/** Hugging Face Hub — primary weight source (HF-layout `{model}/resolve/{rev}/`). */
export const HF_MODEL_HOST = 'https://huggingface.co/';

/**
 * Self-hosted fallback mirror on the Legion CDN. Must mirror the HF repo
 * layout under this root (`<root>/onnx-community/moonshine-tiny-ONNX/resolve/main/…`)
 * so the default `remotePathTemplate` resolves unchanged. Same mirror root
 * `whisperEngine.ts`/`kokoroEngine.ts` use; populate with a matching
 * mirror script if/when this stops being a PoC. Override via
 * `modelSources` if it differs.
 */
export const LEGION_MODEL_FALLBACK_HOST = 'https://cdn.codecai.net/webllm/hf/';

/** Sane per-device default (fp32 on WebGPU, q8 on wasm) — see module doc. */
const DEFAULT_DTYPE: Record<'webgpu' | 'wasm', string> = { webgpu: 'fp32', wasm: 'q8' };

export interface MoonshineEngineOptions {
  /** HF model id / repo. Default `onnx-community/moonshine-tiny-ONNX`. */
  modelId?: string;
  /** Force a device instead of the webgpu-then-wasm probe. */
  device?: 'webgpu' | 'wasm';
  /** Explicit quantization override. Default: fp32 on webgpu, q8 on wasm. */
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
  /** Forwarded to transformers.js' `pipeline(..., { progress_callback })`
   * — see `whisperEngine.ts`'s identical option for the full rationale. */
  onProgress?: (p: EngineLoadProgress) => void;
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
 * constructed — most mesh peers never opt in to ASR hosting, and most
 * conversation-mode sessions never toggle it on either. */
async function loadTransformers() {
  const mod = await import('@huggingface/transformers');
  return { pipeline: mod.pipeline, env: mod.env };
}

export async function createMoonshineEngine(opts: MoonshineEngineOptions = {}): Promise<SpeechEngine> {
  const modelId = opts.modelId ?? 'onnx-community/moonshine-tiny-ONNX';
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
        const dtype = opts.dtype ?? DEFAULT_DTYPE[candidate];
        console.debug(`[legion-speech] moonshine: loading ${modelId} device=${candidate} dtype=${dtype} from ${host} … (first load downloads the model)`);
        const pipelineOpts: Record<string, unknown> = { device: candidate, dtype };
        if (opts.onProgress) pipelineOpts.progress_callback = opts.onProgress;
        transcriber = (await pipeline(
          'automatic-speech-recognition',
          modelId,
          pipelineOpts,
        )) as unknown as AsrPipeline;
        device = candidate;
        console.debug(`[legion-speech] moonshine: loaded ${modelId} on ${candidate} from ${host}`);
        break outer;
      } catch (err) {
        console.warn(`[legion-speech] moonshine: load failed device=${candidate} host=${host}:`, err instanceof Error ? err.message : err);
        lastErr = err;
        transcriber = undefined;
      }
    }
  }

  if (!transcriber || !device) {
    throw new Error(
      `moonshine engine: failed to initialize on any device (${devicesToTry.join(', ')}) ` +
        `from any source (${sources.join(', ')}): ${
          lastErr instanceof Error ? lastErr.message : String(lastErr)
        }`,
    );
  }

  const id = `moonshine-tiny/${device}`;
  const resolvedTranscriber = transcriber;

  return {
    id,
    async transcribe(input: SpeechEngineInput): Promise<AsrTranscribeContent> {
      // Guard: transformers.js reads `audio.length` internally, so an
      // undefined/empty PCM surfaces as an opaque "reading 'length'" error.
      // Fail loud + clear here instead (same guard as whisperEngine.ts).
      if (!(input.pcm instanceof Float32Array) || input.pcm.length === 0) {
        throw new Error(
          `moonshine: no audio samples to transcribe (pcm=${
            input.pcm instanceof Float32Array ? input.pcm.length : typeof input.pcm
          }) — clip may be empty/too short`,
        );
      }
      console.debug(`[legion-speech] moonshine: transcribing ${input.pcm.length} samples @ ${input.sampleRate}Hz`);
      const startedAt = Date.now();
      // Text only — no `return_timestamps`, same as whisperEngine.ts: voice
      // commands/wake-listening don't need segments, and timestamp decode
      // is the fragile part of these pipelines.
      const output = (await resolvedTranscriber(input.pcm, {
        ...(input.language ? { language: input.language } : {}),
      })) as { text?: string };
      const durationMs = Date.now() - startedAt;
      const text = typeof output?.text === 'string' ? output.text.trim() : '';
      console.debug(`[legion-speech] moonshine: done in ${durationMs}ms — "${text.slice(0, 80)}"`);
      return {
        text,
        language: input.language,
        durationMs,
        engine: id,
      };
    },
  };
}
