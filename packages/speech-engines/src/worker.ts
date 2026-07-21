/**
 * Web Worker entry that owns one `SpeechEngine` instance (lazily created
 * on the first `transcribe` request) and answers `SpeechWorkerRequest`
 * messages. The host app constructs this via
 * `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`
 * (Vite static-worker convention, matching `apps/demo`'s existing
 * `stageWorker.ts` / `llmWorker.ts`) — `SpeechWorkerClient` below is the
 * request/response wrapper most callers should use instead of talking to
 * `postMessage` directly.
 *
 * Kept DOM-lib only (no `WebWorker` lib) to match this package's shared
 * tsconfig — `self` is cast through `Worker` at the postMessage boundary,
 * same idiom as `apps/demo/src/workers/stageWorker.ts`.
 */
import { createWhisperEngine } from './whisperEngine.js';
import type { SpeechEngine } from './types.js';
import type { AsrTranscribeContent } from '@unstable-legion/core';

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

let enginePromise: Promise<SpeechEngine> | undefined;

function getEngine(): Promise<SpeechEngine> {
  if (!enginePromise) enginePromise = createWhisperEngine();
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
      console.debug(`[legion-speech] worker: transcribe req #${req.id} — ${req.pcm.length} samples @ ${req.sampleRate}Hz; loading engine…`);
      const engine = await getEngine();
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
