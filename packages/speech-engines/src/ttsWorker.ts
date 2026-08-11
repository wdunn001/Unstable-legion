/**
 * Web Worker entry that owns one `TtsEngine` instance (lazily created on
 * the first `synthesize` request) and answers `TtsWorkerRequest`
 * messages. A SEPARATE worker from `worker.ts` (the ASR one) — a peer
 * may host TTS without hosting ASR, or vice versa, so the two need
 * independent lifecycles (`useTtsHost`/`useSpeechHost` each own their
 * own worker + registration).
 *
 * The host app constructs this via
 * `new Worker(new URL('./ttsWorker.ts', import.meta.url), { type: 'module' })`
 * (same Vite static-worker convention `worker.ts` uses) —
 * `TtsWorkerClient` below is the request/response wrapper most callers
 * should use instead of talking to `postMessage` directly.
 *
 * Kept DOM-lib only (no `WebWorker` lib), same idiom as `worker.ts`.
 */
import { createKokoroEngine } from './kokoroEngine.js';
import { encodeWav } from './wavEncode.js';
import type { TtsEngine } from './types.js';
import type { TtsSynthesizeContent } from '@unstable-legion/core';

export interface TtsWorkerSynthesizeRequest {
  type: 'synthesize';
  id: number;
  text: string;
  voice?: string;
  speed?: number;
}

export type TtsWorkerRequest = TtsWorkerSynthesizeRequest;

export interface TtsWorkerResultResponse {
  type: 'result';
  id: number;
  content: TtsSynthesizeContent;
}

export interface TtsWorkerErrorResponse {
  type: 'error';
  id: number;
  message: string;
}

export type TtsWorkerResponse = TtsWorkerResultResponse | TtsWorkerErrorResponse;

let enginePromise: Promise<TtsEngine> | undefined;

function getEngine(): Promise<TtsEngine> {
  if (!enginePromise) enginePromise = createKokoroEngine();
  return enginePromise;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}

function post(msg: TtsWorkerResponse): void {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = (ev: MessageEvent<TtsWorkerRequest>) => {
  const req = ev.data;
  if (req.type !== 'synthesize') return;
  void (async () => {
    try {
      const engine = await getEngine();
      const startedAt = Date.now();
      const { pcm, sampleRate } = await engine.synthesize({ text: req.text, voice: req.voice, speed: req.speed });
      const durationMs = Date.now() - startedAt;
      const wav = encodeWav(pcm, sampleRate);
      const content: TtsSynthesizeContent = {
        audioBase64: bytesToBase64(wav),
        mimeType: 'audio/wav',
        sampleRate,
        durationMs,
        engine: engine.id,
      };
      post({ type: 'result', id: req.id, content });
    } catch (err) {
      post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
    }
  })();
};
