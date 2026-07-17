/**
 * @unstable-legion/speech — browser speech-to-text mesh capability (PoC).
 *
 * A `SpeechEngine` interface + a transformers.js Whisper implementation,
 * WebAudio decode/resample helpers, a Web Worker host + request/response
 * client, and the `transcribe` mesh tool that bridges a `SpeechEngine`
 * (running in a worker) to the `asr.transcribe` skill defined in
 * `@unstable-legion/core`'s `speech.ts`.
 *
 * See README.md for the base64-over-`tc` framing decision and the
 * cross-origin isolation notes (not required — WebGPU needs none and the
 * wasm fallback runs single-threaded without it).
 */
export type { SpeechEngine, SpeechEngineInput, SpeechEngineFactory } from './types.js';
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
