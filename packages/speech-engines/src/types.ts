/**
 * `SpeechEngine` — the interface every ASR backend implements. Kept
 * intentionally narrow (one method, PCM in / transcript content out) so
 * `whisperEngine.ts` (transformers.js Whisper, this PoC) can later sit
 * alongside a Parakeet.js or Piper-derived engine without either the
 * worker host (`worker.ts`) or the mesh tool (`asrTool.ts`) needing to
 * change — they only ever talk to this interface.
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
