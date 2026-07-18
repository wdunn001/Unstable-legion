/**
 * postMessage protocol between a stage-hosting consumer (this package's
 * `useStageHost`/`useStagePipeline`) and a DedicatedWorker that wraps
 * `@unstable-legion/stage-runtime`'s `loadStage` (the worker script itself
 * lives in the host app — see `apps/demo/src/workers/stageWorker.ts`).
 *
 * Ported from the proven Phase B harness protocol
 * (H:\dev\legion-stage-runtime\harness\src\stageWorkerProtocol.ts) — same
 * request/response shapes, same reqId correlation discipline. Kept in this
 * package (not the demo) so the hook and the worker script agree on one
 * source of truth regardless of which app embeds them.
 *
 * Activation payloads cross as transferable ArrayBuffers
 * (`WireActivationFrame` instead of stage-runtime's own `ActivationFrame`,
 * which holds a `Uint8Array` — views don't structured-clone/transfer,
 * their backing buffers do).
 */

import type { ActivationDtype, StageDescriptor } from '@unstable-legion/stage-runtime';

export interface WireActivationFrame {
  dtype: ActivationDtype;
  layout: 'token-major';
  tokenCount: number;
  payload: ArrayBuffer;
}

/** Per-shard download-progress snapshot for an in-flight `load` request —
 * mirrors stage-runtime's `StageLoadProgress` (see wasm-loader.ts), wired
 * worker -> `StageWorkerClient.load()`'s `onProgress` callback ->
 * `useStageHost.ts` (drives the stall watchdog + the UI download bar). */
export interface StageWorkerLoadProgress {
  shardsFetched: number;
  totalShards: number;
  bytesFetched: number;
  totalBytes?: number;
  /**
   * What the load is actually doing, straight from the runtime's loader
   * (`StageLoadProgress.phase`) — NOT inferred from shard counts. 'opening'
   * means every shard is resident and legion_stage_open is uploading weights
   * to VRAM, which on a cache-warm load is the entire wait; counts alone made
   * the UI report "Downloading model…" for all of it. Absent from an older
   * runtime — callers treat undefined as 'downloading'.
   */
  phase?: 'downloading' | 'opening';
  /**
   * 0..1 progress of the VRAM upload while `phase === 'opening'`, relayed from
   * llama.cpp's own byte accounting (skippy MODEL_OPEN_PROGRESS -> stage_glue
   * -> the loader). Undefined means the open is running but this host's wasm
   * predates the reporter — show an indeterminate state, never 0%.
   */
  openFraction?: number;
}

export type StageWorkerRequest =
  | {
      type: 'load';
      reqId: number;
      descriptor: StageDescriptor;
      /**
       * M3 — force the OPFS-cached shard store off for this load, using
       * an in-memory `ShardStore` instead (`shardCache.ts`'s
       * `createMemoryShardStore`). `useCommunalHost.ts` sets this when a
       * claimed layer range's fragment bytes would exceed the browser's
       * OPFS-origin quota (~3.3-3.5GB observed ceiling) — a stage that
       * can't fit OPFS still loads and serves fine, it just re-fetches on
       * every reload instead of caching. Absent/false = the normal OPFS
       * path (unchanged default for every existing caller).
       */
      useMemoryShardStore?: boolean;
      /**
       * LOCAL-MODEL-FOLDER — a `FileSystemDirectoryHandle` the user picked
       * via `showDirectoryPicker()` (see `apps/chat/src/hooks/
       * useModelFolder.ts`), pointing at a local clone of the model
       * package (the HF repo, or a `.88` slice). `FileSystemDirectoryHandle`
       * is structured-cloneable, so it crosses this postMessage boundary
       * with no transfer list needed. When present, the worker builds
       * `createLocalFolderFetch(handle)` (mesh-react's
       * `localFolderFetch.ts`) and passes it as `loadStage`'s
       * `opts.fetchImpl` — fragment BYTES come from the folder, but the
       * manifest/hashes this load verifies against still come from the
       * REMOTE source exactly as always (see that module's trust-model doc
       * comment). Absent/undefined = unchanged default behavior (fetch
       * from the network).
       */
      localFolderHandle?: FileSystemDirectoryHandle;
    }
  | {
      type: 'prefill';
      reqId: number;
      tokens: number[];
      positions: number[];
      input?: WireActivationFrame;
      /** M2: which session to run this on (StageHandle.createSession()'s
       * lane). Absent = the legacy fused single-session path (the
       * pre-M1 `stage.prefill`/`stage.decodeStep` byte-for-byte behavior)
       * — keeps every caller that never heard of sessions (the driver's
       * own local stage-0 worker, the pipeline-split/chaos/compat/
       * discovery e2e suites) on the exact same code path as before M2. */
      sessionId?: string;
    }
  | { type: 'decode'; reqId: number; token: number; input?: WireActivationFrame; sessionId?: string }
  | { type: 'tokenize'; reqId: number; text: string; addSpecial: boolean }
  | { type: 'detokenize'; reqId: number; tokens: number[] }
  | { type: 'tokenIsEog'; reqId: number; token: number }
  | { type: 'reset'; reqId: number; sessionId?: string }
  | { type: 'dispose'; reqId: number }
  /** M2: open/close one lane (StageSessionHandle) on the already-loaded
   * stage. `sessionCreate` fails if the stage isn't loaded yet or the
   * model's lane_count (StageDescriptor.maxSessions) is exhausted — the
   * worker surfaces that as a normal `{type:'error'}` response, same as
   * any other native-call failure. */
  | { type: 'sessionCreate'; reqId: number; sessionId: string }
  | { type: 'sessionFree'; reqId: number; sessionId: string };

export type StageWorkerResponse =
  | { type: 'ready'; reqId: number; isFirst: boolean; isFinal: boolean; nEmbd: number }
  /**
   * Zero or more of these precede the terminal `ready`/`error` response to
   * the SAME `reqId` a `load` request got — NOT itself a terminal
   * response (the caller keeps waiting for `ready`/`error` after
   * receiving one). See `StageWorkerClient.load()`'s `onProgress` param.
   */
  | ({ type: 'progress'; reqId: number } & StageWorkerLoadProgress)
  | {
      type: 'result';
      reqId: number;
      kind: 'prefill' | 'decode';
      activation?: WireActivationFrame;
      predictedToken?: number;
    }
  | { type: 'result'; reqId: number; kind: 'tokenize'; tokens: number[] }
  | { type: 'result'; reqId: number; kind: 'detokenize'; text: string }
  | { type: 'result'; reqId: number; kind: 'tokenIsEog'; isEog: boolean }
  | { type: 'result'; reqId: number; kind: 'reset' }
  | { type: 'result'; reqId: number; kind: 'dispose' }
  | { type: 'result'; reqId: number; kind: 'sessionCreate' }
  | { type: 'result'; reqId: number; kind: 'sessionFree' }
  | { type: 'error'; reqId: number; message: string };
