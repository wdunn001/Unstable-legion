/**
 * `SpeechWorkerClient` — thin request/response wrapper over one
 * speech-worker `Worker`, mirroring `@unstable-legion/react`'s
 * `StageWorkerClient` (reqId-keyed pending map, one worker per client).
 *
 * The caller supplies the already-constructed `Worker` — this package
 * never constructs one itself, keeping it bundler-agnostic (host apps
 * build it via
 * `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`
 * so Vite's bundler sees a static worker entry point).
 *
 * `engine` (constructor option, default `'whisper'`) picks which
 * `SpeechEngine` kind every request from THIS client asks the worker for
 * — see `worker.ts`'s module doc. A caller wanting the local Moonshine
 * "wake-ear" (conversation mode's VAD — see `@unstable-legion/react`'s
 * `useMoonshineTranscriber`) constructs its OWN worker + client with
 * `{ engine: 'moonshine' }`; the manual push-to-talk / mesh ASR path
 * keeps constructing a plain `new SpeechWorkerClient(worker)` (Whisper,
 * unchanged).
 *
 * `warmup()` posts a `SpeechWorkerWarmupRequest` and resolves once the
 * worker replies `ready` (or rejects on `error`), forwarding any
 * `progress` messages to the caller along the way. It shares this
 * client's `pending` id-correlation map with `transcribe()` — a warmup
 * and a transcribe in flight at the same time never collide because each
 * gets its own `nextId`. Hosts (`useSpeechHost`/`useMoonshineTranscriber`)
 * call this right after construction so `ready` means "model loaded", not
 * just "worker constructed" — see those hooks' doc comments.
 */
import type { AsrTranscribeArgs, AsrTranscribeContent } from '@unstable-legion/core';
import type { SpeechWorkerEngineKind, SpeechWorkerRequest, SpeechWorkerResponse } from './worker.js';
import type { EngineLoadProgress } from './types.js';
import { decodeToPcm } from './audioDecode.js';

export interface SpeechWorkerClientOptions {
  /** Which `SpeechEngine` kind the worker should use for every request
   * from this client. Default `'whisper'` (back-compatible). */
  engine?: SpeechWorkerEngineKind;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type PendingEntry =
  | { kind: 'transcribe'; resolve: (v: AsrTranscribeContent) => void; reject: (e: Error) => void }
  | {
      kind: 'warmup';
      resolve: (engine: string) => void;
      reject: (e: Error) => void;
      onProgress?: (p: EngineLoadProgress) => void;
    };

export class SpeechWorkerClient {
  private nextId = 1;
  private readonly engine: SpeechWorkerEngineKind;
  private readonly pending = new Map<number, PendingEntry>();

  constructor(
    private readonly worker: Worker,
    opts: SpeechWorkerClientOptions = {},
  ) {
    this.engine = opts.engine ?? 'whisper';
    this.worker.addEventListener('message', (ev: MessageEvent<SpeechWorkerResponse>) => this.onMessage(ev.data));
    this.worker.addEventListener('error', (ev: ErrorEvent) => {
      const message = `speech worker error: ${ev.message}`;
      for (const [, p] of this.pending) p.reject(new Error(message));
      this.pending.clear();
    });
  }

  private onMessage(msg: SpeechWorkerResponse): void {
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
    if (msg.type === 'result' && pending.kind === 'transcribe') {
      pending.resolve(msg.content);
      return;
    }
    // Response type doesn't match the pending request's kind — a bug in
    // this client's id bookkeeping, not something a caller can act on.
    pending.reject(new Error(`speech worker: mismatched response type "${msg.type}" for pending "${pending.kind}" request`));
  }

  /**
   * Load this client's engine (`this.engine`, e.g. `'whisper'` or
   * `'moonshine'`) without transcribing anything — resolves once the
   * worker reports `ready`, rejects on `error`. `onProgress` is called for
   * every `progress` message in between (a Cache Storage hit may skip
   * straight to `ready` with none). See module doc.
   */
  warmup(onProgress?: (p: EngineLoadProgress) => void): Promise<void> {
    const id = this.nextId++;
    console.debug(`[legion-speech] client: warmup #${id} — engine=${this.engine}`);
    const req: SpeechWorkerRequest = { type: 'warmup', id, engine: this.engine };
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        kind: 'warmup',
        resolve: (engine) => {
          console.debug(`[legion-speech] client: warmup #${id} ready (${engine})`);
          resolve();
        },
        reject,
        onProgress,
      });
      this.worker.postMessage(req);
    });
  }

  transcribe(args: AsrTranscribeArgs): Promise<AsrTranscribeContent> {
    const id = this.nextId++;
    // Decode HERE, on the main thread — `AudioContext` (WebAudio's
    // decoder) is Window-only and absent in the worker. We hand the
    // worker already-decoded 16 kHz mono PCM, transferring the buffer so
    // there's no copy.
    return (async () => {
      const bytes = base64ToBytes(args.audioBase64);
      console.debug(`[legion-speech] client: decoding clip #${id} (${bytes.length} bytes, ${args.mimeType}) on main thread…`);
      const { pcm, sampleRate } = await decodeToPcm(bytes, args.mimeType);
      console.debug(`[legion-speech] client: decoded #${id} → ${pcm.length} samples @ ${sampleRate}Hz; posting to worker`);
      const req: SpeechWorkerRequest = {
        type: 'transcribe',
        id,
        pcm,
        sampleRate,
        language: args.language,
        engine: this.engine,
      };
      return await new Promise<AsrTranscribeContent>((resolve, reject) => {
        this.pending.set(id, { kind: 'transcribe', resolve, reject });
        // Structured-clone COPY (no transferable list): the pcm is ~160 KB
        // for a few seconds of audio — a copy is negligible and avoids any
        // transfer edge case leaving the worker's view detached/undefined.
        this.worker.postMessage(req);
      });
    })();
  }

  /** Terminate the underlying worker and reject any in-flight requests. */
  dispose(): void {
    for (const [, p] of this.pending) p.reject(new Error('speech worker client disposed'));
    this.pending.clear();
    this.worker.terminate();
  }
}
