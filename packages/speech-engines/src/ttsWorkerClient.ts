/**
 * `TtsWorkerClient` — thin request/response wrapper over one tts-worker
 * `Worker`, mirroring `SpeechWorkerClient` (ASR) exactly: reqId-keyed
 * pending map, one worker per client, the caller supplies the
 * already-constructed `Worker` (Vite static-worker convention — see
 * `ttsWorker.ts`'s module doc and `apps/chat/src/workers/ttsWorker.ts`).
 *
 * WAV-encoding happens HERE, on the main thread, from the raw Float32
 * PCM the worker returns (`encodeWavBase64`) — the worker itself never
 * touches WebAudio or a container format (see `ttsWorker.ts`'s module
 * doc). This class is the seam where PCM becomes a self-describing
 * `audio/wav` clip a peer can ship over `tc` and any consumer can
 * `decodeAudioData` without needing to know the engine's native sample
 * rate out of band.
 *
 * `warmup()` mirrors `SpeechWorkerClient.warmup()` exactly — posts a
 * `TtsWorkerWarmupRequest`, resolves once the worker replies `ready`,
 * rejects on `error`, forwards `progress` messages to the caller. See
 * that method's doc for the full rationale (`ready` = "model loaded").
 */
import type { TtsSynthesizeArgs, TtsSynthesizeContent } from '@unstable-legion/core';
import type { TtsWorkerRequest, TtsWorkerResponse } from './ttsWorker.js';
import type { EngineLoadProgress } from './types.js';
import { encodeWavBase64 } from './wavEncode.js';

type PendingEntry =
  | { kind: 'synthesize'; resolve: (v: TtsSynthesizeContent) => void; reject: (e: Error) => void }
  | { kind: 'voices'; resolve: (v: string[]) => void; reject: (e: Error) => void }
  | {
      kind: 'warmup';
      resolve: (engine: string) => void;
      reject: (e: Error) => void;
      onProgress?: (p: EngineLoadProgress) => void;
    };

export class TtsWorkerClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();

  constructor(private readonly worker: Worker) {
    this.worker.addEventListener('message', (ev: MessageEvent<TtsWorkerResponse>) => this.onMessage(ev.data));
    this.worker.addEventListener('error', (ev: ErrorEvent) => {
      const message = `tts worker error: ${ev.message}`;
      for (const [, p] of this.pending) p.reject(new Error(message));
      this.pending.clear();
    });
  }

  private onMessage(msg: TtsWorkerResponse): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    if (msg.type === 'progress') {
      // Non-terminal: a warmup can report many of these before its
      // matching `ready`/`error` — don't delete the pending entry.
      if (pending.kind === 'warmup') pending.onProgress?.(msg);
      return;
    }
    this.pending.delete(msg.id);

    if (msg.type === 'error') {
      pending.reject(new Error(msg.message));
      return;
    }
    if (msg.type === 'ready' && pending.kind === 'warmup') {
      pending.resolve(msg.engine);
      return;
    }
    if (msg.type === 'voices' && pending.kind === 'voices') {
      pending.resolve(msg.voices);
      return;
    }
    if (msg.type === 'result' && pending.kind === 'synthesize') {
      console.debug(`[legion-speech] tts client: encoding WAV for #${msg.id} on main thread (${msg.audio.length} samples @ ${msg.sampleRate}Hz)…`);
      const audioBase64 = encodeWavBase64(msg.audio, msg.sampleRate);
      pending.resolve({
        audioBase64,
        mimeType: 'audio/wav',
        sampleRate: msg.sampleRate,
        voice: msg.voice,
        engine: msg.engine,
        durationMs: msg.durationMs,
      });
      return;
    }
    // Response type doesn't match the pending request's kind — a bug in
    // this client's id bookkeeping, not something a caller can act on.
    pending.reject(new Error(`tts worker: mismatched response type "${msg.type}" for pending "${pending.kind}" request`));
  }

  synthesize(args: TtsSynthesizeArgs): Promise<TtsSynthesizeContent> {
    const id = this.nextId++;
    console.debug(`[legion-speech] tts client: synthesize #${id} — "${args.text.slice(0, 60)}"`);
    const req: TtsWorkerSynthesizeRequest = {
      type: 'synthesize',
      id,
      text: args.text,
      voice: args.voice,
      language: args.language,
    };
    return new Promise<TtsSynthesizeContent>((resolve, reject) => {
      this.pending.set(id, { kind: 'synthesize', resolve, reject });
      // Structured-clone COPY (no transferable list) — see ttsWorker.ts's
      // doc: the request itself carries no large payload (just text), so
      // there's nothing to transfer either way.
      this.worker.postMessage(req);
    });
  }

  /** List voice ids this peer's TTS engine supports. Resolves once the engine has loaded. */
  listVoices(): Promise<string[]> {
    const id = this.nextId++;
    const req: TtsWorkerRequest = { type: 'listVoices', id };
    return new Promise<string[]>((resolve, reject) => {
      this.pending.set(id, { kind: 'voices', resolve, reject });
      this.worker.postMessage(req);
    });
  }

  /**
   * Load the Kokoro engine without synthesizing anything — resolves once
   * the worker reports `ready`, rejects on `error`. `onProgress` is
   * called for every `progress` message in between (a Cache Storage hit
   * may skip straight to `ready` with none). See module doc.
   */
  warmup(onProgress?: (p: EngineLoadProgress) => void): Promise<void> {
    const id = this.nextId++;
    console.debug(`[legion-speech] tts client: warmup #${id}`);
    const req: TtsWorkerRequest = { type: 'warmup', id };
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        kind: 'warmup',
        resolve: (engine) => {
          console.debug(`[legion-speech] tts client: warmup #${id} ready (${engine})`);
          resolve();
        },
        reject,
        onProgress,
      });
      this.worker.postMessage(req);
    });
  }

  /** Terminate the underlying worker and reject any in-flight requests. */
  dispose(): void {
    for (const [, p] of this.pending) p.reject(new Error('tts worker client disposed'));
    this.pending.clear();
    this.worker.terminate();
  }
}

// Local alias so `synthesize`'s request literal can be typed precisely
// without re-importing the union member type at every call site.
type TtsWorkerSynthesizeRequest = Extract<TtsWorkerRequest, { type: 'synthesize' }>;
