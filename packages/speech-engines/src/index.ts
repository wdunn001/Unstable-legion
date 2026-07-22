/**
 * @unstable-legion/speech — browser speech-to-text AND text-to-speech
 * mesh capabilities (PoC).
 *
 * ASR: a `SpeechEngine` interface + a transformers.js Whisper
 * implementation, WebAudio decode/resample helpers, a Web Worker host +
 * request/response client, and the `transcribe` mesh tool that bridges a
 * `SpeechEngine` (running in a worker) to the `asr.transcribe` skill
 * defined in `@unstable-legion/core`'s `speech.ts`.
 *
 * TTS: the reverse-direction twin — a `TtsEngine` interface + a
 * kokoro-js implementation (`kokoroEngine.ts`), a WAV-encode helper
 * (`wavEncode.ts`), a Web Worker host + request/response client
 * (`ttsWorker.ts` / `ttsWorkerClient.ts`), and the `synthesize` mesh
 * tool (`ttsTool.ts`) bridging a `TtsEngine` to the `tts.synthesize`
 * skill in the same `speech.ts` contract.
 *
 * See README.md for the base64-over-`tc` framing decision and the
 * cross-origin isolation notes (not required — WebGPU needs none and the
 * wasm fallback runs single-threaded without it).
 */
export type {
  SpeechEngine,
  SpeechEngineInput,
  SpeechEngineFactory,
  TtsEngine,
  TtsEngineInput,
  TtsEngineOutput,
  TtsEngineFactory,
} from './types.js';
export {
  createWhisperEngine,
  type WhisperEngineOptions,
  HF_MODEL_HOST,
  LEGION_MODEL_FALLBACK_HOST,
} from './whisperEngine.js';
export { decodeToPcm, type DecodedPcm } from './audioDecode.js';
export {
  type SpeechWorkerRequest,
  type SpeechWorkerTranscribeRequest,
  type SpeechWorkerResponse,
  type SpeechWorkerResultResponse,
  type SpeechWorkerErrorResponse,
} from './worker.js';
export { SpeechWorkerClient } from './workerClient.js';
export { createAsrTranscribeTool, type AsrTranscribeClient } from './asrTool.js';

// ── Text-to-speech (Kokoro) ──────────────────────────────────────────
export {
  createKokoroEngine,
  type KokoroEngineOptions,
  HF_MODEL_HOST as TTS_HF_MODEL_HOST,
  LEGION_MODEL_FALLBACK_HOST as TTS_LEGION_MODEL_FALLBACK_HOST,
} from './kokoroEngine.js';
export { encodeWavBase64 } from './wavEncode.js';
export {
  type TtsWorkerRequest,
  type TtsWorkerSynthesizeRequest,
  type TtsWorkerListVoicesRequest,
  type TtsWorkerResponse,
  type TtsWorkerResultResponse,
  type TtsWorkerVoicesResponse,
  type TtsWorkerErrorResponse,
} from './ttsWorker.js';
export { TtsWorkerClient } from './ttsWorkerClient.js';
export { createTtsSynthesizeTool, type TtsSynthesizeClient } from './ttsTool.js';
export { splitForTts } from './splitForTts.js';
