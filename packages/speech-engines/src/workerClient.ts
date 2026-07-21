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
 */
import type { AsrTranscribeArgs, AsrTranscribeContent } from '@unstable-legion/core';
import type { SpeechWorkerRequest, SpeechWorkerResponse } from './worker.js';
import { decodeToPcm } from './audioDecode.js';

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class SpeechWorkerClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: AsrTranscribeContent) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly worker: Worker) {
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
    this.pending.delete(msg.id);
    if (msg.type === 'error') {
      pending.reject(new Error(msg.message));
      return;
    }
    pending.resolve(msg.content);
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
      };
      return await new Promise<AsrTranscribeContent>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage(req, [pcm.buffer]);
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
