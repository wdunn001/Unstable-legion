/**
 * Web Worker entry that owns one `SpeechEngine` PER KIND (lazily created
 * on the first `transcribe` request that asks for it, then memoized) and
 * answers `SpeechWorkerRequest` messages. The host app constructs this via
 * `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`
 * (Vite static-worker convention, matching `apps/demo`'s existing
 * `stageWorker.ts` / `llmWorker.ts`) — `SpeechWorkerClient` below is the
 * request/response wrapper most callers should use instead of talking to
 * `postMessage` directly.
 *
 * Two engines share this one worker file rather than forking it: Whisper
 * (`whisperEngine.ts` — manual push-to-talk, "🎙 Listen", and mesh-hosted
 * `asr.transcribe`) and Moonshine (`moonshineEngine.ts` — conversation
 * mode's local "wake-ear", see `@unstable-legion/react`'s
 * `useMoonshineTranscriber`). Each `SpeechWorkerRequest` carries an
 * optional `engine` field (default `'whisper'`, so pre-existing requests
 * from before this field existed behave identically); `getEngine` below
 * memoizes one `SpeechEngine` per kind, keyed in a `Map`, so a worker that
 * only ever serves one kind (the normal case — see
 * `SpeechWorkerClient`'s constructor `engine` option) never constructs the
 * other.
 *
 * Kept DOM-lib only (no `WebWorker` lib) to match this package's shared
 * tsconfig — `self` is cast through `Worker` at the postMessage boundary,
 * same idiom as `apps/demo/src/workers/stageWorker.ts`.
 */
import { createWhisperEngine } from './whisperEngine.js';
import { createMoonshineEngine } from './moonshineEngine.js';
import type { SpeechEngine } from './types.js';
import type { AsrTranscribeContent } from '@unstable-legion/core';

/** Which `SpeechEngine` backs a request/client. See module doc. */
export type SpeechWorkerEngineKind = 'whisper' | 'moonshine';

export interface SpeechWorkerTranscribeRequest {
  type: 'transcribe';
  id: number;
  /**
   * Mono PCM in [-1, 1], already decoded + resampled to `sampleRate` by
   * the CLIENT on the main thread. Decoding happens there, not here,
   * because `AudioContext` (WebAudio's decoder) is a Window-only API — it
   * does not exist in a DedicatedWorker, so decoding raw bytes in this
   * worker throws. See `SpeechWorkerClient.transcribe` + `audioDecode.ts`.
   */
  pcm: Float32Array;
  sampleRate: number;
  language?: string;
  /** Which `SpeechEngine` should serve this request. Default `'whisper'`
   * — back-compatible with requests sent before this field existed. See
   * module doc. */
  engine?: SpeechWorkerEngineKind;
}

export type SpeechWorkerRequest = SpeechWorkerTranscribeRequest;

export interface SpeechWorkerResultResponse {
  type: 'result';
  id: number;
  content: AsrTranscribeContent;
}

export interface SpeechWorkerErrorResponse {
  type: 'error';
  id: number;
  message: string;
}

export type SpeechWorkerResponse = SpeechWorkerResultResponse | SpeechWorkerErrorResponse;

const enginePromises = new Map<SpeechWorkerEngineKind, Promise<SpeechEngine>>();

function getEngine(kind: SpeechWorkerEngineKind): Promise<SpeechEngine> {
  let enginePromise = enginePromises.get(kind);
  if (!enginePromise) {
    enginePromise = kind === 'moonshine' ? createMoonshineEngine() : createWhisperEngine();
    enginePromises.set(kind, enginePromise);
  }
  return enginePromise;
}

function post(msg: SpeechWorkerResponse): void {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = (ev: MessageEvent<SpeechWorkerRequest>) => {
  const req = ev.data;
  if (req.type !== 'transcribe') return;
  void (async () => {
    try {
      const kind = req.engine ?? 'whisper';
      console.debug(`[legion-speech] worker: transcribe req #${req.id} — ${req.pcm.length} samples @ ${req.sampleRate}Hz; loading engine (${kind})…`);
      const engine = await getEngine(kind);
      console.debug(`[legion-speech] worker: engine ready (${engine.id}); transcribing #${req.id}…`);
      const content = await engine.transcribe({ pcm: req.pcm, sampleRate: req.sampleRate, language: req.language });
      console.debug(`[legion-speech] worker: transcribe #${req.id} done — "${content.text.slice(0, 60)}"`);
      post({ type: 'result', id: req.id, content });
    } catch (err) {
      console.error(`[legion-speech] worker: transcribe #${req.id} FAILED`, err);
      post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
    }
  })();
};
