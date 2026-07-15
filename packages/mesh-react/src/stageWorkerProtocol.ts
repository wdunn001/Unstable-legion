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

export type StageWorkerRequest =
  | { type: 'load'; reqId: number; descriptor: StageDescriptor }
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
