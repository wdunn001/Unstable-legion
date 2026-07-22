/**
 * `createKokoroEngine` — kokoro-js (Kokoro-82M ONNX, running through
 * transformers.js under the hood) backend for the `TtsEngine` interface.
 *
 * Model choice: `onnx-community/Kokoro-82M-v1.0-ONNX` — kokoro-js's own
 * quick-start model id, an ONNX conversion of hexgrad/Kokoro-82M (an
 * 82M-param multi-voice TTS model). kokoro-js depends on
 * `@huggingface/transformers` ^3.5.1, satisfied by the ^3.8.1 already in
 * this monorepo's lockfile for `whisperEngine.ts` — no second
 * onnxruntime-web copy ships.
 *
 * Quantization/device: kokoro-js's own usage guide recommends
 * `dtype: 'fp32'` on WebGPU (the precision the model was tuned/exported
 * against) and a quantized `dtype: 'q8'` on wasm (smaller download,
 * because full fp32 decode on CPU is much slower). Device selection
 * mirrors `whisperEngine.ts`: try `webgpu` first, fall back to `wasm`.
 *
 * Weight sourcing: identical HF-primary / Legion-CDN-fallback policy as
 * `whisperEngine.ts` — `env.remoteHost` (on the SAME `@huggingface/
 * transformers` `env` object kokoro-js reads internally) is set per
 * attempt, first reachable device+host combo wins.
 *
 * `generate()` returns decoded Float32 PCM directly (no container, no
 * WebAudio decode step) — see `ttsWorker.ts`'s module doc for why that
 * matters for where this engine is allowed to run.
 */
import type { EngineLoadProgress, TtsEngine, TtsEngineInput, TtsEngineOutput } from './types.js';

/** Hugging Face Hub — primary weight source (HF-layout `{model}/resolve/{rev}/`). */
export const HF_MODEL_HOST = 'https://huggingface.co/';

/**
 * Self-hosted fallback mirror on the Legion CDN. Must mirror the HF
 * repo layout under this root (`<root>/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/…`)
 * so the default `remotePathTemplate` resolves unchanged. Same mirror
 * root `whisperEngine.ts` uses; populate with a matching
 * `scripts/mirror-kokoro-to-cdn.sh` follow-up. Override via
 * `modelSources` if it differs.
 */
export const LEGION_MODEL_FALLBACK_HOST = 'https://cdn.codecai.net/webllm/hf/';

/** kokoro-js's own recommended dtype per device (fp32 on WebGPU, q8 on wasm). */
const DEFAULT_DTYPE: Record<'webgpu' | 'wasm', string> = { webgpu: 'fp32', wasm: 'q8' };

/** Kokoro's default voice — a commonly-demoed American-English voice. */
const DEFAULT_VOICE = 'af_heart';

export interface KokoroEngineOptions {
  /** HF model id / repo. Default `onnx-community/Kokoro-82M-v1.0-ONNX`. */
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
  /**
   * Forwarded to kokoro-js' `KokoroTTS.from_pretrained(..., {
   * progress_callback })` — kokoro-js's own `.d.ts` (`node_modules/
   * kokoro-js/types/kokoro.d.ts`) documents this as an
   * `@huggingface/transformers` `ProgressCallback`, the SAME shape
   * `whisperEngine.ts`'s identical option forwards to `pipeline()` — see
   * that option's doc for the full rationale.
   */
  onProgress?: (p: EngineLoadProgress) => void;
}

interface KokoroGeneratedAudio {
  audio: Float32Array;
  sampling_rate: number;
}

interface KokoroTtsInstance {
  generate(text: string, options?: { voice?: string }): Promise<KokoroGeneratedAudio>;
  list_voices(): string[];
}

interface KokoroTtsCtor {
  from_pretrained(modelId: string, options: Record<string, unknown>): Promise<KokoroTtsInstance>;
}

/** Cheap WebGPU presence probe — avoids a doomed webgpu load attempt (and a
 * wasted fallback-source retry) on browsers without `navigator.gpu`. */
function hasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && !!(navigator as { gpu?: unknown }).gpu;
}

/** Lazily imported so kokoro-js (and its own @huggingface/transformers +
 * onnxruntime-web payload) only hits the network/bundle when a TTS
 * engine is actually constructed — most mesh peers never opt in to TTS
 * hosting. */
async function loadKokoro(): Promise<KokoroTtsCtor> {
  const mod = await import('kokoro-js');
  return mod.KokoroTTS as unknown as KokoroTtsCtor;
}

async function loadTransformersEnv() {
  const mod = await import('@huggingface/transformers');
  return mod.env;
}

export async function createKokoroEngine(opts: KokoroEngineOptions = {}): Promise<TtsEngine> {
  const modelId = opts.modelId ?? 'onnx-community/Kokoro-82M-v1.0-ONNX';
  const [KokoroTTS, env] = await Promise.all([loadKokoro(), loadTransformersEnv()]);

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
  let tts: KokoroTtsInstance | undefined;
  let lastErr: unknown;

  outer: for (const candidate of devicesToTry) {
    for (const host of sources) {
      try {
        env.allowRemoteModels = true;
        env.remoteHost = host;
        const dtype = opts.dtype ?? DEFAULT_DTYPE[candidate];
        console.debug(`[legion-speech] kokoro: loading ${modelId} device=${candidate} dtype=${dtype} from ${host} … (first load downloads the model)`);
        tts = await KokoroTTS.from_pretrained(modelId, {
          dtype,
          device: candidate,
          ...(opts.onProgress ? { progress_callback: opts.onProgress } : {}),
        });
        device = candidate;
        console.debug(`[legion-speech] kokoro: loaded ${modelId} on ${candidate} from ${host}`);
        break outer;
      } catch (err) {
        console.warn(`[legion-speech] kokoro: load failed device=${candidate} host=${host}:`, err instanceof Error ? err.message : err);
        lastErr = err;
        tts = undefined;
      }
    }
  }

  if (!tts || !device) {
    throw new Error(
      `kokoro engine: failed to initialize on any device (${devicesToTry.join(', ')}) ` +
        `from any source (${sources.join(', ')}): ${
          lastErr instanceof Error ? lastErr.message : String(lastErr)
        }`,
    );
  }

  const id = `kokoro-82m/${device}`;
  const resolvedTts = tts;

  return {
    id,
    listVoices(): string[] {
      return resolvedTts.list_voices();
    },
    async synthesize(input: TtsEngineInput): Promise<TtsEngineOutput> {
      // Guard: an empty/whitespace clip is a wasted model call at best
      // and an opaque engine error at worst (mirrors whisperEngine.ts's
      // empty-pcm guard on the ASR side).
      if (typeof input.text !== 'string' || input.text.trim().length === 0) {
        throw new Error('kokoro: no text to synthesize (empty/whitespace input)');
      }
      const voice = input.voice ?? DEFAULT_VOICE;
      console.debug(`[legion-speech] kokoro: synthesizing ${input.text.length} chars, voice=${voice}`);
      const result = await resolvedTts.generate(input.text, { voice });
      console.debug(`[legion-speech] kokoro: generated ${result.audio.length} samples @ ${result.sampling_rate}Hz`);
      return { audio: result.audio, sampleRate: result.sampling_rate, voice };
    },
  };
}
