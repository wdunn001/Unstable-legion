/**
 * @unstable-legion/speech — browser speech mesh capability (ASR + TTS).
 *
 * ASR: a `SpeechEngine` interface + a transformers.js Whisper
 * implementation, WebAudio decode/resample helpers, a Web Worker host +
 * request/response client, and the `transcribe` mesh tool that bridges a
 * `SpeechEngine` (running in a worker) to the `asr.transcribe` skill
 * defined in `@unstable-legion/core`'s `speech.ts`.
 *
 * TTS: a `TtsEngine` interface + a `kokoro-js` (Kokoro-82M) implementation,
 * a pure WAV encoder, a SEPARATE Web Worker host + client (independent
 * lifecycle from the ASR worker — a peer may host only one), and the
 * `synthesize` mesh tool bridging a `TtsEngine` to the `tts.synthesize`
 * skill.
 *
 * See README.md for the base64-over-`tc` framing decision and the
 * cross-origin isolation notes (not required — WebGPU needs none and the
 * wasm fallback runs single-threaded without it).
 */
export type { SpeechEngine, SpeechEngineInput, SpeechEngineFactory } from './types.js';
export type { TtsEngine, TtsEngineInput, TtsEngineOutput, TtsEngineFactory } from './types.js';
export {
  createWhisperEngine,
  type WhisperEngineOptions,
  HF_MODEL_HOST,
  LEGION_MODEL_FALLBACK_HOST,
} from './whisperEngine.js';
export { createKokoroEngine, type KokoroEngineOptions, DEFAULT_KOKORO_VOICE } from './kokoroEngine.js';
export { decodeToPcm, type DecodedPcm } from './audioDecode.js';
export { encodeWav } from './wavEncode.js';
export {
  type SpeechWorkerRequest,
  type SpeechWorkerTranscribeRequest,
  type SpeechWorkerResponse,
  type SpeechWorkerResultResponse,
  type SpeechWorkerErrorResponse,
} from './worker.js';
export { SpeechWorkerClient } from './workerClient.js';
export { createAsrTranscribeTool, type AsrTranscribeClient } from './asrTool.js';
export {
  type TtsWorkerRequest,
  type TtsWorkerSynthesizeRequest,
  type TtsWorkerResponse,
  type TtsWorkerResultResponse,
  type TtsWorkerErrorResponse,
} from './ttsWorker.js';
export { TtsWorkerClient } from './ttsWorkerClient.js';
export { createTtsSynthesizeTool, type TtsSynthesizeClient } from './ttsTool.js';
