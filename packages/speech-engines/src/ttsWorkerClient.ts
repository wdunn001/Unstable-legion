/**
 * `TtsWorkerClient` — thin request/response wrapper over one
 * tts-worker `Worker`, mirroring `workerClient.ts`'s `SpeechWorkerClient`
 * (reqId-keyed pending map, one worker per client).
 *
 * The caller supplies the already-constructed `Worker` — this package
 * never constructs one itself, keeping it bundler-agnostic (host apps
 * build it via
 * `new Worker(new URL('./ttsWorker.ts', import.meta.url), { type: 'module' })`
 * so Vite's bundler sees a static worker entry point).
 */
import type { TtsSynthesizeArgs, TtsSynthesizeContent } from '@unstable-legion/core';
import type { TtsWorkerRequest, TtsWorkerResponse } from './ttsWorker.js';

export class TtsWorkerClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: TtsSynthesizeContent) => void; reject: (e: Error) => void }
  >();

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
    this.pending.delete(msg.id);
    if (msg.type === 'error') {
      pending.reject(new Error(msg.message));
      return;
    }
    pending.resolve(msg.content);
  }

  synthesize(args: TtsSynthesizeArgs): Promise<TtsSynthesizeContent> {
    const id = this.nextId++;
    const req: TtsWorkerRequest = {
      type: 'synthesize',
      id,
      text: args.text,
      voice: args.voice,
      speed: args.speed,
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
