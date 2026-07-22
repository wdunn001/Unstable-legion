/**
 * Web Worker entry that owns one `TtsEngine` instance (lazily created on
 * the first `synthesize`/`warmup` request) and answers `TtsWorkerRequest`
 * messages. Mirrors `worker.ts` (ASR) exactly — same "host app
 * constructs this via `new Worker(new URL('./ttsWorker.ts',
 * import.meta.url), { type: 'module' })`" convention, same
 * request/response idiom, same `warmup`/`ready`/`progress` protocol (see
 * `worker.ts`'s doc for the full rationale: `ready` should mean "model
 * loaded", not "worker constructed") — reverse direction: text in, raw
 * Float32 PCM out.
 *
 * Unlike ASR, there is NO decode step here: Kokoro's `generate()`
 * (`kokoroEngine.ts`) returns already-decoded Float32 samples directly,
 * so this worker never touches WebAudio at all — not even indirectly.
 * That said, the same rule ASR had to learn the hard way still applies
 * and is worth restating: `AudioContext`/`decodeAudioData` are
 * Window-only APIs that do not exist in a DedicatedWorker. WAV-encoding
 * the PCM this worker returns, and playing it back, both happen on the
 * MAIN thread (`ttsWorkerClient.ts` / `useAudioPlayback.ts`) — not
 * because this worker needs WebAudio, but because the consuming peer
 * needs a self-describing container and the browser's audio output is
 * main-thread-only regardless.
 *
 * Kept DOM-lib only (no `WebWorker` lib), same idiom as `worker.ts`.
 */
import { createKokoroEngine } from './kokoroEngine.js';
import type { EngineLoadProgress, TtsEngine } from './types.js';

export interface TtsWorkerSynthesizeRequest {
  type: 'synthesize';
  id: number;
  text: string;
  voice?: string;
  language?: string;
}

export interface TtsWorkerListVoicesRequest {
  type: 'listVoices';
  id: number;
}

/** Load (or wait for the in-flight load of) the Kokoro engine and resolve
 * once it's ready — no synthesis. `TtsWorkerClient.warmup()` uses this so
 * `ready` means "model loaded"; see `worker.ts`'s identical request for
 * the full rationale. */
export interface TtsWorkerWarmupRequest {
  type: 'warmup';
  id: number;
}

export type TtsWorkerRequest = TtsWorkerSynthesizeRequest | TtsWorkerListVoicesRequest | TtsWorkerWarmupRequest;

export interface TtsWorkerResultResponse {
  type: 'result';
  id: number;
  /**
   * Mono PCM in [-1, 1] at `sampleRate`, straight off `TtsEngine.synthesize`
   * — no container. `ttsWorkerClient.ts` WAV-encodes this on the main
   * thread. Sent via a plain structured-clone COPY (no transferable
   * list) — see `workerClient.ts`'s ASR fix note this mirrors: a copy of
   * a few seconds of f32 PCM (a few hundred KB) is negligible, and
   * avoids any transfer edge case leaving either side's view
   * detached/undefined.
   */
  audio: Float32Array;
  sampleRate: number;
  voice: string;
  engine: string;
  /** Wall-clock milliseconds this worker spent inside `engine.synthesize`. */
  durationMs: number;
}

export interface TtsWorkerVoicesResponse {
  type: 'voices';
  id: number;
  voices: string[];
}

/** Reply to a `warmup` request once `getEngine` resolves. */
export interface TtsWorkerReadyResponse {
  type: 'ready';
  id: number;
  /** The loaded engine's stable id, e.g. `kokoro-82m/webgpu`. */
  engine: string;
}

/** Forwarded from `createKokoroEngine`'s `onProgress` while a `warmup`
 * request's model load is in flight — see `EngineLoadProgress`'s doc. */
export interface TtsWorkerProgressResponse extends EngineLoadProgress {
  type: 'progress';
  id: number;
}

export interface TtsWorkerErrorResponse {
  type: 'error';
  id: number;
  message: string;
}

export type TtsWorkerResponse =
  | TtsWorkerResultResponse
  | TtsWorkerVoicesResponse
  | TtsWorkerReadyResponse
  | TtsWorkerProgressResponse
  | TtsWorkerErrorResponse;

let enginePromise: Promise<TtsEngine> | undefined;

function getEngine(onProgress?: (p: EngineLoadProgress) => void): Promise<TtsEngine> {
  if (!enginePromise) enginePromise = createKokoroEngine({ onProgress });
  return enginePromise;
}

function post(msg: TtsWorkerResponse): void {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = (ev: MessageEvent<TtsWorkerRequest>) => {
  const req = ev.data;
  if (req.type === 'warmup') {
    void (async () => {
      try {
        console.debug(`[legion-speech] tts worker: warmup req #${req.id} — loading engine…`);
        const engine = await getEngine((p) => post({ type: 'progress', id: req.id, ...p }));
        console.debug(`[legion-speech] tts worker: warmup #${req.id} done — engine ready (${engine.id})`);
        post({ type: 'ready', id: req.id, engine: engine.id });
      } catch (err) {
        console.error(`[legion-speech] tts worker: warmup #${req.id} FAILED`, err);
        post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return;
  }
  if (req.type === 'synthesize') {
    void (async () => {
      try {
        console.debug(`[legion-speech] tts worker: synthesize req #${req.id} — ${req.text.length} chars; loading engine…`);
        const engine = await getEngine();
        console.debug(`[legion-speech] tts worker: engine ready (${engine.id}); synthesizing #${req.id}…`);
        const startedAt = Date.now();
        const result = await engine.synthesize({ text: req.text, voice: req.voice, language: req.language });
        const durationMs = Date.now() - startedAt;
        console.debug(`[legion-speech] tts worker: synthesize #${req.id} done in ${durationMs}ms — ${result.audio.length} samples @ ${result.sampleRate}Hz`);
        post({
          type: 'result',
          id: req.id,
          audio: result.audio,
          sampleRate: result.sampleRate,
          voice: result.voice,
          engine: engine.id,
          durationMs,
        });
      } catch (err) {
        console.error(`[legion-speech] tts worker: synthesize #${req.id} FAILED`, err);
        post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return;
  }
  if (req.type === 'listVoices') {
    void (async () => {
      try {
        const engine = await getEngine();
        post({ type: 'voices', id: req.id, voices: engine.listVoices() });
      } catch (err) {
        console.error(`[legion-speech] tts worker: listVoices #${req.id} FAILED`, err);
        post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
      }
    })();
  }
};
