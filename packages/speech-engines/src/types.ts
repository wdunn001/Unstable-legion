/**
 * `SpeechEngine` — the interface every ASR backend implements. Kept
 * intentionally narrow (one method, PCM in / transcript content out) so
 * `whisperEngine.ts` (transformers.js Whisper, this PoC) can later sit
 * alongside a Parakeet.js or Piper-derived engine without either the
 * worker host (`worker.ts`) or the mesh tool (`asrTool.ts`) needing to
 * change — they only ever talk to this interface.
 *
 * `TtsEngine` is its symmetric twin for the synthesis direction: one
 * method, text in / PCM out. `kokoroEngine.ts` is the only implementation
 * so far; `ttsWorker.ts` and `ttsTool.ts` only ever talk to this
 * interface, the same way `worker.ts`/`asrTool.ts` only talk to
 * `SpeechEngine`.
 */
import type { AsrTranscribeContent } from '@unstable-legion/core';

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

/** Text (+ optional voice/speed hint) ready to synthesize. */
export interface TtsEngineInput {
  /** Text to synthesize. */
  text: string;
  /** Optional engine-specific voice id. Omit for the engine's default. */
  voice?: string;
  /** Optional speaking-speed multiplier (1.0 = normal). Omit for the engine's default. */
  speed?: number;
}

/** Raw synthesized audio — not yet container-encoded (see `wavEncode.ts`). */
export interface TtsEngineOutput {
  /** Mono PCM samples in [-1, 1]. */
  pcm: Float32Array;
  /** Sample rate `pcm` was generated at. */
  sampleRate: number;
}

export interface TtsEngine {
  /** Stable identifier for this engine instance, e.g. `kokoro-82m/webgpu`. */
  readonly id: string;
  /** Synthesize one clip of raw PCM from text. */
  synthesize(input: TtsEngineInput): Promise<TtsEngineOutput>;
}

/** Factory shape a worker host or test double can construct/swap. */
export type TtsEngineFactory = (opts?: Record<string, unknown>) => Promise<TtsEngine>;
