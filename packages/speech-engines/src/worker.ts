/**
 * Web Worker entry that owns one `SpeechEngine` PER KIND (lazily created
 * on the first `transcribe`/`warmup` request that asks for it, then
 * memoized) and answers `SpeechWorkerRequest` messages. The host app
 * constructs this via `new Worker(new URL('./worker.ts', import.meta.url),
 * { type: 'module' })` (Vite static-worker convention, matching
 * `apps/demo`'s existing `stageWorker.ts` / `llmWorker.ts`) —
 * `SpeechWorkerClient` below is the request/response wrapper most callers
 * should use instead of talking to `postMessage` directly.
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
 * `warmup` — added so `ready` (in `@unstable-legion/react`'s
 * `useSpeechHost`/`useMoonshineTranscriber`) can mean "model loaded", not
 * just "worker constructed". Hosts call `warmup` right after constructing
 * the client instead of waiting for the first `transcribe`; this posts
 * `progress` messages as the model downloads and `ready`/`error` once
 * `getEngine` settles. `transcribe` itself is UNCHANGED — it still calls
 * `getEngine` (memoized, so a transcribe that arrives before warmup
 * finishes just piggybacks on the same in-flight load, and one that
 * arrives after warmup gets the already-resolved engine instantly).
 *
 * Kept DOM-lib only (no `WebWorker` lib) to match this package's shared
 * tsconfig — `self` is cast through `Worker` at the postMessage boundary,
 * same idiom as `apps/demo/src/workers/stageWorker.ts`.
 */
import { createWhisperEngine } from './whisperEngine.js';
import { createMoonshineEngine } from './moonshineEngine.js';
import type { EngineLoadProgress, SpeechEngine } from './types.js';
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

/**
 * Load (or wait for the in-flight load of) the engine of the given `kind`
 * and resolve once it's ready — no transcription. `SpeechWorkerClient.
 * warmup()` uses this to make `ready` mean "model loaded" instead of
 * "worker constructed"; see module doc.
 */
export interface SpeechWorkerWarmupRequest {
  type: 'warmup';
  id: number;
  /** Which `SpeechEngine` kind to warm. Default `'whisper'`, matching
   * `SpeechWorkerTranscribeRequest.engine`'s default. */
  engine?: SpeechWorkerEngineKind;
}

export type SpeechWorkerRequest = SpeechWorkerTranscribeRequest | SpeechWorkerWarmupRequest;

export interface SpeechWorkerResultResponse {
  type: 'result';
  id: number;
  content: AsrTranscribeContent;
}

/** Reply to a `warmup` request once `getEngine` resolves — the model is
 * loaded and a subsequent `transcribe` for this `engine` kind won't block
 * on a download. */
export interface SpeechWorkerReadyResponse {
  type: 'ready';
  id: number;
  /** The loaded engine's stable id, e.g. `whisper-base/webgpu`. */
  engine: string;
}

/** Forwarded from the engine factory's `onProgress` while a `warmup`
 * request's model load is in flight — see `EngineLoadProgress`'s doc. */
export interface SpeechWorkerProgressResponse extends EngineLoadProgress {
  type: 'progress';
  id: number;
}

export interface SpeechWorkerErrorResponse {
  type: 'error';
  id: number;
  message: string;
}

export type SpeechWorkerResponse =
  | SpeechWorkerResultResponse
  | SpeechWorkerReadyResponse
  | SpeechWorkerProgressResponse
  | SpeechWorkerErrorResponse;

const enginePromises = new Map<SpeechWorkerEngineKind, Promise<SpeechEngine>>();

function getEngine(kind: SpeechWorkerEngineKind, onProgress?: (p: EngineLoadProgress) => void): Promise<SpeechEngine> {
  let enginePromise = enginePromises.get(kind);
  if (!enginePromise) {
    enginePromise =
      kind === 'moonshine' ? createMoonshineEngine({ onProgress }) : createWhisperEngine({ onProgress });
    enginePromises.set(kind, enginePromise);
  }
  return enginePromise;
}

function post(msg: SpeechWorkerResponse): void {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = (ev: MessageEvent<SpeechWorkerRequest>) => {
  const req = ev.data;
  if (req.type === 'warmup') {
    void (async () => {
      try {
        const kind = req.engine ?? 'whisper';
        console.debug(`[legion-speech] worker: warmup req #${req.id} — loading engine (${kind})…`);
        const engine = await getEngine(kind, (p) => post({ type: 'progress', id: req.id, ...p }));
        console.debug(`[legion-speech] worker: warmup #${req.id} done — engine ready (${engine.id})`);
        post({ type: 'ready', id: req.id, engine: engine.id });
      } catch (err) {
        console.error(`[legion-speech] worker: warmup #${req.id} FAILED`, err);
        post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return;
  }
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
