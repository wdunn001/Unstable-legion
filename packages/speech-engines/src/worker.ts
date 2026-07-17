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
import { decodeToPcm } from './audioDecode.js';
import type { SpeechEngine } from './types.js';
import type { AsrTranscribeContent } from '@unstable-legion/core';

export interface SpeechWorkerTranscribeRequest {
  type: 'transcribe';
  id: number;
  audioBase64: string;
  mimeType: string;
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

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function post(msg: SpeechWorkerResponse): void {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = (ev: MessageEvent<SpeechWorkerRequest>) => {
  const req = ev.data;
  if (req.type !== 'transcribe') return;
  void (async () => {
    try {
      const engine = await getEngine();
      const bytes = base64ToBytes(req.audioBase64);
      const { pcm, sampleRate } = await decodeToPcm(bytes, req.mimeType);
      const content = await engine.transcribe({ pcm, sampleRate, language: req.language });
      post({ type: 'result', id: req.id, content });
    } catch (err) {
      post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
    }
  })();
};
