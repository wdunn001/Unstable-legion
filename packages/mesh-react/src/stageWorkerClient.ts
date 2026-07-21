/**
 * Thin request/response client over one stage-worker DedicatedWorker.
 * Ported from the proven Phase B harness client
 * (H:\dev\legion-stage-runtime\harness\src\stageWorkerClient.ts) — same
 * reqId-keyed pending-map, same method surface. Both `useStageHost`
 * (answers `stage.load` as a remote stage) and `useStagePipeline` (runs
 * the driver's own local stage-0) construct one of these per worker.
 *
 * The caller supplies the already-constructed `Worker` (host apps build
 * it via `new Worker(new URL('./workers/stageWorker.ts', import.meta.url),
 * { type: 'module' })` so Vite's bundler sees a static worker entry) —
 * this package never constructs a Worker itself, keeping it bundler-agnostic.
 */
import type { StageDescriptor } from '@unstable-legion/stage-runtime';
import type { StageWorkerLoadProgress, StageWorkerRequest, StageWorkerResponse, WireActivationFrame } from './stageWorkerProtocol.js';

export type StageWorkerLog = (line: string) => void;

/** `Omit` over a discriminated union collapses to the shared-keys-only
 * intersection (a well-known TS gotcha) — this distributes the omission
 * over each union member instead, so `send()` below still gets the
 * per-request-kind field set with `reqId` stripped. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class StageWorkerClient {
  private nextReqId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: StageWorkerResponse) => void; reject: (e: Error) => void }
  >();
  /** Keyed by the `load` request's own `reqId` — a `progress` response
   * shares that reqId (see stageWorkerProtocol.ts) but is NOT terminal,
   * so it's routed here instead of resolving/removing the pending entry. */
  private readonly progressHandlers = new Map<number, (progress: StageWorkerLoadProgress) => void>();
  isFirst = false;
  isFinal = false;
  nEmbd = 0;

  constructor(
    private readonly worker: Worker,
    private readonly label: string,
    private readonly log: StageWorkerLog = () => undefined,
    /** Called when the worker itself fires an `error` event — a genuine
     * worker-process crash (uncaught exception, OOM), distinct from a
     * normal `{type:'error'}` response message (e.g. a 404 shard fetch,
     * which resolves the request-reply and is NOT a crash). Lets
     * `useStageHost` surface a `stage_worker_crashed` signal without this
     * client needing to know about telemetry. */
    private readonly onWorkerError?: (message: string) => void,
  ) {
    this.worker.addEventListener('message', (ev: MessageEvent<StageWorkerResponse>) => this.onMessage(ev.data));
    this.worker.addEventListener('error', (ev: ErrorEvent) => {
      this.log(`[${label}] worker error: ${ev.message}`);
      for (const [, p] of this.pending) p.reject(new Error(`[${label}] worker error: ${ev.message}`));
      this.pending.clear();
      this.progressHandlers.clear();
      try {
        this.onWorkerError?.(ev.message || 'worker crashed');
      } catch {
        // best-effort — a throwing crash-reporter must not mask the crash
      }
    });
  }

  private onMessage(msg: StageWorkerResponse): void {
    if (msg.type === 'progress') {
      // Not terminal — the pending `load` entry stays open, waiting for
      // the real `ready`/`error` that follows.
      this.progressHandlers.get(msg.reqId)?.({
        shardsFetched: msg.shardsFetched,
        totalShards: msg.totalShards,
        bytesFetched: msg.bytesFetched,
        totalBytes: msg.totalBytes,
      });
      return;
    }
    const pending = this.pending.get(msg.reqId);
    if (!pending) return;
    this.pending.delete(msg.reqId);
    if (msg.type === 'error') {
      pending.reject(new Error(`[${this.label}] ${msg.message}`));
      return;
    }
    pending.resolve(msg);
  }

  private send(
    req: DistributiveOmit<StageWorkerRequest, 'reqId'>,
    transfer: Transferable[] = [],
    reqId: number = this.nextReqId++,
  ): Promise<StageWorkerResponse> {
    const full = { ...req, reqId } as StageWorkerRequest;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.worker.postMessage(full, transfer);
    });
  }

  /** `onProgress`, when supplied, is called once per shard as the worker
   * fetches it (see `StageWorkerLoadProgress` / stage-runtime's
   * `StageLoadProgress`) — lets a caller drive a download-progress UI and/
   * or a progress-based stall watchdog (see `useStageHost.ts`'s
   * `runWithStallWatchdog` usage) instead of only a flat total timeout. */
  async load(
    descriptor: StageDescriptor,
    opts: {
      useMemoryShardStore?: boolean;
      /** LOCAL-MODEL-FOLDER — see `StageWorkerRequest`'s `load.localFolderHandle`
       * doc comment (stageWorkerProtocol.ts). Forwarded verbatim into the
       * postMessage payload; `FileSystemDirectoryHandle` structured-clones
       * to a worker with no transfer list needed. Absent = unchanged
       * network-fetch behavior. */
      localFolderHandle?: FileSystemDirectoryHandle;
      /** INCREMENTAL LOAD (#47) — use the shard-by-shard begin/add_shard/finish
       * path (loadStageIncremental) instead of the monolithic loadStage. Needs
       * `descriptor.shardRoles`. See StageWorkerRequest's `load.incrementalLoad`. */
      incrementalLoad?: boolean;
    } = {},
    onProgress?: (progress: StageWorkerLoadProgress) => void,
  ): Promise<void> {
    const reqId = this.nextReqId++;
    if (onProgress) this.progressHandlers.set(reqId, onProgress);
    try {
      const res = await this.send(
        {
          type: 'load',
          descriptor,
          useMemoryShardStore: opts.useMemoryShardStore,
          localFolderHandle: opts.localFolderHandle,
          incrementalLoad: opts.incrementalLoad,
        },
        [],
        reqId,
      );
      if (res.type !== 'ready') throw new Error(`[${this.label}] unexpected response to load: ${res.type}`);
      this.isFirst = res.isFirst;
      this.isFinal = res.isFinal;
      this.nEmbd = res.nEmbd;
    } finally {
      this.progressHandlers.delete(reqId);
    }
  }

  /** `sessionId` absent = the legacy fused single-session path (unchanged
   * since before M2 — the driver's own local stage-0 worker and every
   * pre-M2 e2e suite never pass one). Present = M2's multi-session path:
   * routes to that session's own KV state on the same loaded worker. */
  async prefill(
    tokens: number[],
    positions: number[],
    input?: WireActivationFrame,
    sessionId?: string,
  ): Promise<{ activation?: WireActivationFrame; predictedToken?: number }> {
    const res = await this.send({ type: 'prefill', tokens, positions, input, sessionId }, input ? [input.payload] : []);
    if (res.type !== 'result' || res.kind !== 'prefill') throw new Error(`[${this.label}] unexpected prefill response`);
    return { activation: res.activation, predictedToken: res.predictedToken };
  }

  async decode(
    token: number,
    input?: WireActivationFrame,
    sessionId?: string,
  ): Promise<{ activation?: WireActivationFrame; predictedToken?: number }> {
    const res = await this.send({ type: 'decode', token, input, sessionId }, input ? [input.payload] : []);
    if (res.type !== 'result' || res.kind !== 'decode') throw new Error(`[${this.label}] unexpected decode response`);
    return { activation: res.activation, predictedToken: res.predictedToken };
  }

  async tokenize(text: string, addSpecial: boolean): Promise<number[]> {
    const res = await this.send({ type: 'tokenize', text, addSpecial });
    if (res.type !== 'result' || res.kind !== 'tokenize') throw new Error(`[${this.label}] unexpected tokenize response`);
    return res.tokens;
  }

  async detokenize(tokens: number[]): Promise<string> {
    const res = await this.send({ type: 'detokenize', tokens });
    if (res.type !== 'result' || res.kind !== 'detokenize') throw new Error(`[${this.label}] unexpected detokenize response`);
    return res.text;
  }

  async tokenIsEog(token: number): Promise<boolean> {
    const res = await this.send({ type: 'tokenIsEog', token });
    if (res.type !== 'result' || res.kind !== 'tokenIsEog') throw new Error(`[${this.label}] unexpected tokenIsEog response`);
    return res.isEog;
  }

  async reset(sessionId?: string): Promise<void> {
    await this.send({ type: 'reset', sessionId });
  }

  async dispose(): Promise<void> {
    await this.send({ type: 'dispose' }).catch(() => undefined);
    this.worker.terminate();
  }

  /** M2: open a new lane (StageSessionHandle) on this already-loaded
   * stage. Rejects if the worker hasn't loaded a stage yet or the
   * model's lane_count (maxSessions, fixed at load time) is exhausted. */
  async sessionCreate(sessionId: string): Promise<void> {
    const res = await this.send({ type: 'sessionCreate', sessionId });
    if (res.type !== 'result' || res.kind !== 'sessionCreate') {
      throw new Error(`[${this.label}] unexpected sessionCreate response`);
    }
  }

  /** M2: free a lane. Best-effort by design (mirrors `dispose()` — a
   * session teardown during host-side cleanup shouldn't throw and block
   * freeing the next queued session). */
  async sessionFree(sessionId: string): Promise<void> {
    await this.send({ type: 'sessionFree', sessionId }).catch(() => undefined);
  }
}

/**
 * A zero-filled placeholder activation frame of the given shape — used
 * anywhere a caller must hand the wire codec/worker protocol AN activation
 * even though the receiving stage is known to ignore its content (an isFirst
 * stage's embedding step, or `warmUpStageWorker`'s throwaway dispatch below).
 * Exported for `useStageHost.ts`'s TEXT-RELAY host-side prefill override
 * (see `stageControl.ts`'s `StageSessionOpenPayload.promptText` doc
 * comment): the host tokenizes `promptText` itself and must construct a
 * correctly-shaped (tokenCount === its own real token count) placeholder to
 * hand `client.prefill`, discarding the driver's own (differently-sized)
 * placeholder — the wire codec would otherwise reject a `tokens` sideband
 * whose length doesn't match the activation's derived tokenCount.
 */
export function dummyActivationFrame(tokenCount: number, nEmbd: number): WireActivationFrame {
  return { dtype: 'f32', layout: 'token-major', tokenCount, payload: new ArrayBuffer(tokenCount * nEmbd * 4) };
}

/**
 * Force WebGPU shader-pipeline compilation NOW (during an already-
 * generous caller-side timeout window — `stage.load` for a remote host,
 * or the local stage-0 setup before the driver session even starts)
 * instead of on the first REAL prefill/decode dispatch. Dawn/WebGPU
 * compiles compute pipelines lazily on first dispatch, and under
 * multi-tab GPU contention (several peers sharing one adapter) that
 * cold compile can take well past a minute — enough to blow a
 * decode-step timeout on an otherwise-healthy pipeline (observed
 * directly while building Phase C's e2e coverage: a real first
 * dispatch exceeded 90s under 3-tab contention). Exercises both shapes
 * a real session hits — a multi-token prefill dispatch and a
 * single-token decode dispatch — with throwaway dummy input, then
 * resets KV state.
 *
 * A FAILURE HERE IS FATAL, and deliberately so. This dispatch is the only
 * proof that the stage can actually run: it compiles every compute pipeline
 * and executes both real dispatch shapes. If it fails, the stage CANNOT
 * serve — full stop.
 *
 * This used to log "dispatch failed (non-fatal)" and return normally, on the
 * theory that a real bug would "surface on the real request". It did — as a
 * broken host advertised to the whole mesh. Observed live: a WGSL compile
 * error (`@builtin(num_subgroups)` unsupported on the device) killed the
 * pipeline, the failure was swallowed, `useStageHost` set `workerClient` and
 * published `loadedStages`, drivers routed real chats to it, and every
 * prefill trapped `unreachable` — a crash loop that reloaded the stage over
 * and over. "Surfacing on the real request" means breaking a stranger's chat.
 * A peer must never claim capacity it hasn't PROVEN it can serve; throwing
 * here routes the failure into the caller's normal load-failed/backoff path
 * and the stage is simply never advertised.
 */
export async function warmUpStageWorker(client: StageWorkerClient, log: StageWorkerLog = () => undefined): Promise<void> {
  try {
    const prefillInput = client.isFirst ? undefined : dummyActivationFrame(2, client.nEmbd);
    await client.prefill([0, 0], [0, 1], prefillInput);
    const decodeInput = client.isFirst ? undefined : dummyActivationFrame(1, client.nEmbd);
    await client.decode(0, decodeInput);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[stage-warmup] FAILED — refusing to report this stage ready: ${message}`);
    throw new Error(`stage warm-up dispatch failed (stage cannot serve): ${message}`);
  } finally {
    // A reset failure must never mask the real warm-up error above.
    await client.reset().catch(() => undefined);
  }
}
