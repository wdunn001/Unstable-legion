/**
 * `createKokoroEngine` — `kokoro-js` (Kokoro-82M, StyleTTS2, ONNX)
 * text-to-speech backend for the `TtsEngine` interface.
 *
 * Package/API verified against the real published `kokoro-js@1.2.1` on
 * npm (not guessed): `KokoroTTS.from_pretrained(model_id, { dtype,
 * device, progress_callback })` returns a `KokoroTTS`; `.generate(text,
 * { voice, speed })` returns a `RawAudio` (`@huggingface/transformers`'s
 * own class — `{ audio: Float32Array, sampling_rate: number, toWav(),
 * toBlob(), save() }`). `kokoro-js`'s `package.json` pins
 * `@huggingface/transformers: ^3.5.1`, which this repo's already-pinned
 * `^3.8.1` (`whisperEngine.ts`) satisfies — `kokoro-js` imports
 * `StyleTextToSpeech2Model`/`AutoTokenizer`/`RawAudio`/`env` from that
 * SAME package, so a single npm install dedupes both to one
 * `@huggingface/transformers` (and therefore one onnxruntime-web) copy;
 * no second ORT bundle ships. See this package's README for the measured
 * bundle-size delta.
 *
 * Model choice: `onnx-community/Kokoro-82M-v1.0-ONNX` — the ONNX
 * conversion `kokoro-js`'s own README uses, StyleTTS2-based, 82M params.
 * Graded materially better than Piper on sustained listening (A/A- vs
 * Piper's C+ per the `kokoro-js` README's voice table), which is why it
 * was picked over Piper for this phase.
 *
 * Quantization: unlike `whisperEngine.ts`'s transformers.js `pipeline()`
 * (which auto-picks a sane per-device dtype), `KokoroTTS.from_pretrained`
 * always defaults to `dtype: "fp32"` regardless of device — no
 * device-aware default of its own. Its own README explicitly recommends
 * `dtype: "q8"` on wasm and `dtype: "fp32"` on webgpu, so this engine
 * applies that same per-device split unless the caller overrides `dtype`
 * explicitly (mirrors the CONCLUSION of transformers.js's own per-device
 * default, just applied by hand since kokoro-js doesn't do it itself).
 *
 * Device selection: tries `webgpu` first, falls back to `wasm` — same
 * probe as `whisperEngine.ts`. No cross-origin isolation is required:
 * WebGPU needs none, and the wasm fallback (via onnxruntime-web) runs
 * single-threaded on a non-isolated page automatically, same posture the
 * ASR path and the LLM path already take.
 *
 * Weight sourcing — PARTIAL host override only (verified, not assumed):
 * the ONNX model + tokenizer both load via
 * `@huggingface/transformers`'s own `from_pretrained`, which obeys the
 * SAME global `env.remoteHost`/`env.allowRemoteModels` `whisperEngine.ts`
 * sets — so `modelSources`/`wasmPaths` below apply to those exactly like
 * the ASR engine's. BUT `kokoro-js`'s per-voice style-vector `.bin` files
 * (loaded lazily per `voice`, one vector per synthesize call) are fetched
 * by a **hardcoded** `fetch("https://huggingface.co/onnx-community/
 * Kokoro-82M-v1.0-ONNX/resolve/main/voices/<voice>.bin")` inside
 * `kokoro-js` itself (cached via the browser's Cache Storage under a
 * `"kokoro-voices"` cache name) — it does not consult `env.remoteHost` or
 * any option this engine can pass through. There is currently no way to
 * point voice-vector fetches at the Legion CDN fallback; if
 * `HF_MODEL_HOST` is ever unreachable, voice loading fails even though
 * the model itself loaded from the fallback. Flagged here rather than
 * faked — a real fix would require patching/forking `kokoro-js`, out of
 * scope for this pass.
 */
import type { TtsEngine, TtsEngineInput } from './types.js';
import { HF_MODEL_HOST, LEGION_MODEL_FALLBACK_HOST } from './whisperEngine.js';

export { HF_MODEL_HOST, LEGION_MODEL_FALLBACK_HOST };

/** Grade-A English voice (per the `kokoro-js` README's voice table) — the default. */
export const DEFAULT_KOKORO_VOICE = 'af_heart';

export interface KokoroEngineOptions {
  /** HF model id / repo. Default `onnx-community/Kokoro-82M-v1.0-ONNX`. */
  modelId?: string;
  /** Force a device instead of the webgpu-then-wasm probe. */
  device?: 'webgpu' | 'wasm';
  /**
   * Explicit quantization override. Default: `fp32` on webgpu, `q8` on
   * wasm (kokoro-js's own README-recommended split — see module doc for
   * why this engine applies it explicitly rather than trusting a library
   * default).
   */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';
  /** Default voice id when a synthesize call doesn't specify one. Default `af_heart`. */
  voice?: string;
  /**
   * Ordered remote hosts to try for the ONNX model weights; first
   * reachable wins. Default: `[HF_MODEL_HOST, LEGION_MODEL_FALLBACK_HOST]`.
   * Does NOT affect per-voice style-vector fetches — see module doc.
   */
  modelSources?: string[];
  /** Override the onnxruntime-web wasm binary location. Default: transformers.js' own public CDN. */
  wasmPaths?: string;
}

/** Cheap WebGPU presence probe — same idiom as `whisperEngine.ts`'s `hasWebGpu`. */
function hasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && !!(navigator as { gpu?: unknown }).gpu;
}

/** Lazily imported so `kokoro-js` (and its `@huggingface/transformers` +
 * `phonemizer` payload) only hits the network/bundle when a TTS engine is
 * actually constructed — most mesh peers never opt in to TTS hosting. */
async function loadKokoro() {
  const [{ KokoroTTS }, { env }] = await Promise.all([import('kokoro-js'), import('@huggingface/transformers')]);
  return { KokoroTTS, env };
}

type KokoroTtsInstance = {
  generate(text: string, opts: { voice: string; speed: number }): Promise<{ audio: Float32Array; sampling_rate: number }>;
};

export async function createKokoroEngine(opts: KokoroEngineOptions = {}): Promise<TtsEngine> {
  const modelId = opts.modelId ?? 'onnx-community/Kokoro-82M-v1.0-ONNX';
  const defaultVoice = opts.voice ?? DEFAULT_KOKORO_VOICE;
  const { KokoroTTS, env } = await loadKokoro();

  if (opts.wasmPaths && env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = opts.wasmPaths;
  }

  const sources =
    opts.modelSources && opts.modelSources.length > 0
      ? opts.modelSources
      : [HF_MODEL_HOST, LEGION_MODEL_FALLBACK_HOST];
  const devicesToTry: Array<'webgpu' | 'wasm'> = opts.device
    ? [opts.device]
    : hasWebGpu()
      ? ['webgpu', 'wasm']
      : ['wasm'];

  let device: 'webgpu' | 'wasm' | undefined;
  let tts: KokoroTtsInstance | undefined;
  let lastErr: unknown;

  outer: for (const candidate of devicesToTry) {
    // kokoro-js has no per-device smart default (see module doc) — apply
    // the README-recommended split ourselves unless the caller pinned one.
    const dtype = opts.dtype ?? (candidate === 'webgpu' ? 'fp32' : 'q8');
    for (const host of sources) {
      try {
        env.allowRemoteModels = true;
        env.remoteHost = host;
        tts = (await KokoroTTS.from_pretrained(modelId, { dtype, device: candidate })) as unknown as KokoroTtsInstance;
        device = candidate;
        break outer;
      } catch (err) {
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
    async synthesize(input: TtsEngineInput) {
      const audio = await resolvedTts.generate(input.text, {
        voice: input.voice ?? defaultVoice,
        speed: input.speed ?? 1,
      });
      return { pcm: audio.audio, sampleRate: audio.sampling_rate };
    },
  };
}
