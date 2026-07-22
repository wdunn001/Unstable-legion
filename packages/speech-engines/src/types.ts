/**
 * `SpeechEngine` — the interface every ASR backend implements. Kept
 * intentionally narrow (one method, PCM in / transcript content out) so
 * `whisperEngine.ts` (transformers.js Whisper, this PoC) can later sit
 * alongside a Parakeet.js or Piper-derived engine without either the
 * worker host (`worker.ts`) or the mesh tool (`asrTool.ts`) needing to
 * change — they only ever talk to this interface.
 *
 * `TtsEngine` is the reverse-direction twin: text in, raw Float32 PCM
 * out. Kept just as narrow so `kokoroEngine.ts` (kokoro-js, this PoC)
 * can later sit alongside another TTS backend without `ttsWorker.ts` /
 * `ttsTool.ts` needing to change.
 */
import type { AsrTranscribeContent } from '@unstable-legion/core';

/**
 * Model-load progress, shared by every engine factory's optional
 * `onProgress` — a deliberately loose shape (every field optional) so it
 * can carry transformers.js' `ProgressCallback` payload (`initiate` /
 * `download` / `progress` / `done` / `ready` stages, see
 * `@huggingface/transformers`' `utils/core.js`) AND kokoro-js'
 * `from_pretrained` progress callback (the same transformers.js type
 * under the hood) without importing either's internal type. Consumers
 * (the workers' `warmup` handlers) forward this straight through to the
 * main thread as a `progress` response — see `worker.ts`/`ttsWorker.ts`.
 */
export interface EngineLoadProgress {
  /** e.g. `'initiate'`, `'download'`, `'progress'`, `'done'`, `'ready'`. */
  status?: string;
  /** The file currently being fetched, when the engine reports one. */
  file?: string;
  /** 0-100. */
  progress?: number;
  loaded?: number;
  total?: number;
}

/** Decoded, mono, ready-to-transcribe audio. */
export interface SpeechEngineInput {
  /** Mono PCM samples in [-1, 1]. */
  pcm: Float32Array;
  /** Sample rate `pcm` was recorded/resampled at. */
  sampleRate: number;
  /** Optional ISO-639-1 language hint. Omit to auto-detect. */
  language?: string;
}

export interface SpeechEngine {
  /** Stable identifier for this engine instance, e.g. `whisper-base/webgpu`. */
  readonly id: string;
  /** Transcribe one clip of decoded PCM. */
  transcribe(input: SpeechEngineInput): Promise<AsrTranscribeContent>;
}

/** Factory shape a worker host or test double can construct/swap. */
export type SpeechEngineFactory = (opts?: Record<string, unknown>) => Promise<SpeechEngine>;

/** Text (+ optional voice/language hint) ready to synthesize. */
export interface TtsEngineInput {
  /** Text to synthesize. */
  text: string;
  /** Optional engine-specific voice id, e.g. `af_heart`. Omit for the engine's default. */
  voice?: string;
  /** Optional ISO-639-1 language hint. */
  language?: string;
}

/** Raw synthesis output — no WAV/container encoding here, see `wavEncode.ts`. */
export interface TtsEngineOutput {
  /** Mono PCM samples in [-1, 1] at `sampleRate`. */
  audio: Float32Array;
  /** Sample rate `audio` was generated at, e.g. `24000` for Kokoro. */
  sampleRate: number;
  /** The voice actually used (the requested voice, or the engine's default). */
  voice: string;
}

export interface TtsEngine {
  /** Stable identifier for this engine instance, e.g. `kokoro-82m/webgpu`. */
  readonly id: string;
  /** Synthesize one clip of raw PCM from text. */
  synthesize(input: TtsEngineInput): Promise<TtsEngineOutput>;
  /** Voice ids this engine instance supports. */
  listVoices(): string[];
}

/** Factory shape a worker host or test double can construct/swap. */
export type TtsEngineFactory = (opts?: Record<string, unknown>) => Promise<TtsEngine>;
