/**
 * DedicatedWorker running one legion StageHandle (Phase C pipeline-split).
 * Owns exactly one stage for the lifetime of the worker — the driver's
 * local stage-0, or a remote peer's assigned stage, depending on who
 * constructs it (`useStagePipeline` / `useStageHost` in
 * `@unstable-legion/react`, which both speak the protocol defined in
 * that package's `stageWorkerProtocol.ts`).
 *
 * Reimplements the proven harness worker
 * (H:\dev\legion-stage-runtime\harness\src\stageWorker.ts) in this repo's
 * idiom: same request/response protocol (imported from the package, not
 * duplicated), same "dynamic-import the wasm glue from an absolute
 * same-origin URL" trick (emscripten-generated code Vite shouldn't try to
 * transform, and it locates its sibling .wasm via
 * `new URL('.', import.meta.url)`, which only resolves cleanly when both
 * files are fetched from the same public path — see
 * apps/demo/public/wasm/legion-stage.{js,wasm}, gitignored, copied from
 * legion-stage-runtime's build output).
 */
import {
  loadStage,
  createMemoryShardStore,
  type StageDescriptor,
  type StageHandle,
  type StageSessionHandle,
  type ActivationFrame,
} from '@unstable-legion/stage-runtime';
import {
  patchWebGpuDeviceLimits,
  type StageWorkerRequest,
  type StageWorkerResponse,
  type WireActivationFrame,
} from '@unstable-legion/react';

// FIX (live 8B-model load): GGML_WEBGPU's C++ init requests a WebGPU
// device with NO requiredLimits, so it gets the spec-default limits
// (maxBufferSize=256MB) even on an adapter that supports far more — every
// 512MB+ layer/output-tensor buffer allocation for Qwen3-8B then fails
// outright. Must run BEFORE `loadStage()` triggers wasm instantiation
// (see wasm-loader.ts's "wasm module: instantiating (incl. WebGPU
// adapter/device request)" phase) — module-top-level is the earliest
// point in this worker, and the patch is idempotent/feature-detected, so
// installing it unconditionally here is safe. See webgpuDevicePatch.ts's
// module doc for the full rationale.
patchWebGpuDeviceLimits();

let stage: StageHandle | undefined;
// M2: sessions opened via StageHandle.createSession() — each an
// independent KV lane on the SAME loaded `stage` above. Keyed by the
// mesh-core sessionId (stagesess-*) the host peer assigns, not the
// native lane index, so `useStageHost.ts` never needs to know how skippy
// numbers lanes internally.
const sessions = new Map<string, StageSessionHandle>();

function requireSession(sessionId: string): StageSessionHandle {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`no session ${sessionId} on this worker (never created, or already freed)`);
  return session;
}

function toWire(frame: ActivationFrame | undefined): WireActivationFrame | undefined {
  if (!frame) return undefined;
  return {
    dtype: frame.dtype,
    layout: frame.layout,
    tokenCount: frame.tokenCount,
    payload: frame.payload.buffer.slice(frame.payload.byteOffset, frame.payload.byteOffset + frame.payload.byteLength) as ArrayBuffer,
  };
}

function fromWire(frame: WireActivationFrame | undefined): ActivationFrame | undefined {
  if (!frame) return undefined;
  return {
    dtype: frame.dtype,
    layout: frame.layout,
    tokenCount: frame.tokenCount,
    payload: new Uint8Array(frame.payload),
  };
}

function post(msg: StageWorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

async function handle(req: StageWorkerRequest): Promise<void> {
  try {
    switch (req.type) {
      case 'load': {
        const descriptor = req.descriptor as StageDescriptor;
        // Checkpoint logging: a worker the browser kills (OOM/GPU) dies with
        // NO ErrorEvent — the last checkpoint printed localizes the death.
        const mem = () => {
          const m = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
          return m ? `heap=${(m.usedJSHeapSize / 1048576).toFixed(0)}MB/${(m.jsHeapSizeLimit / 1048576).toFixed(0)}MB` : 'heap=n/a';
        };
        console.log(`[stage-worker] load start layers=[${descriptor.layerStart},${descriptor.layerEnd}) ${mem()}`);
        const { default: createLegionStageModule } = await import(
          /* @vite-ignore */ new URL('/wasm/legion-stage.js', self.location.origin).toString()
        );
        console.log(`[stage-worker] glue module imported ${mem()}`);
        // M3: in-memory shard store when the caller says the claimed
        // range would exceed the OPFS-origin quota — see
        // stageWorkerProtocol.ts's `useMemoryShardStore` doc comment.
        stage = await loadStage(descriptor, {
          createModule: createLegionStageModule,
          baseUrl: self.location.origin,
          // Per-shard structured progress -> relayed to the caller as a
          // `progress` response (same reqId as this `load`) so
          // `StageWorkerClient.load()`'s `onProgress` can drive a real
          // download-progress UI and the stall watchdog (see
          // useStageHost.ts) instead of only this console.log.
          onProgress: (progress) => {
            console.log(
              `[stage-worker] shard ${progress.shardsFetched}/${progress.totalShards} ${mem()}`,
            );
            post({
              type: 'progress',
              reqId: req.reqId,
              shardsFetched: progress.shardsFetched,
              totalShards: progress.totalShards,
              bytesFetched: progress.bytesFetched,
              totalBytes: progress.totalBytes,
            });
          },
          ...(req.useMemoryShardStore ? { shardStore: createMemoryShardStore() } : {}),
        } as Parameters<typeof loadStage>[1]);
        console.log(`[stage-worker] stage loaded ${mem()}`);
        post({
          type: 'ready',
          reqId: req.reqId,
          isFirst: stage.isFirst,
          isFinal: stage.isFinal,
          nEmbd: stage.nEmbd,
        });
        return;
      }
      case 'prefill': {
        if (!stage) throw new Error('stage not loaded');
        const input = fromWire(req.input);
        // M2: sessionId present -> route to that session's own KV lane;
        // absent -> the legacy fused single-session path (byte-for-byte
        // unchanged from before M2 — this is what the driver's own local
        // stage-0 worker and every pre-M2 e2e suite still exercise).
        const result = req.sessionId
          ? await requireSession(req.sessionId).prefill(req.tokens, req.positions, input)
          : await stage.prefill(req.tokens, req.positions, input);
        const activation = toWire(result.activation);
        post(
          {
            type: 'result',
            reqId: req.reqId,
            kind: 'prefill',
            activation,
            predictedToken: result.predictedToken,
          },
          activation ? [activation.payload] : [],
        );
        return;
      }
      case 'decode': {
        if (!stage) throw new Error('stage not loaded');
        const input = fromWire(req.input);
        const result = req.sessionId
          ? await requireSession(req.sessionId).decodeStep(req.token, input)
          : await stage.decodeStep(req.token, input);
        const activation = toWire(result.activation);
        post(
          {
            type: 'result',
            reqId: req.reqId,
            kind: 'decode',
            activation,
            predictedToken: result.predictedToken,
          },
          activation ? [activation.payload] : [],
        );
        return;
      }
      case 'tokenize': {
        if (!stage) throw new Error('stage not loaded');
        const tokens = await stage.tokenize(req.text, req.addSpecial);
        post({ type: 'result', reqId: req.reqId, kind: 'tokenize', tokens });
        return;
      }
      case 'detokenize': {
        if (!stage) throw new Error('stage not loaded');
        const text = await stage.detokenize(req.tokens);
        post({ type: 'result', reqId: req.reqId, kind: 'detokenize', text });
        return;
      }
      case 'tokenIsEog': {
        if (!stage) throw new Error('stage not loaded');
        const isEog = await stage.tokenIsEog(req.token);
        post({ type: 'result', reqId: req.reqId, kind: 'tokenIsEog', isEog });
        return;
      }
      case 'reset': {
        if (!stage) throw new Error('stage not loaded');
        if (req.sessionId) await requireSession(req.sessionId).reset();
        else await stage.reset();
        post({ type: 'result', reqId: req.reqId, kind: 'reset' });
        return;
      }
      case 'dispose': {
        for (const [, session] of sessions) await session.free().catch(() => undefined);
        sessions.clear();
        if (stage) await stage.dispose();
        stage = undefined;
        post({ type: 'result', reqId: req.reqId, kind: 'dispose' });
        return;
      }
      case 'sessionCreate': {
        if (!stage) throw new Error('stage not loaded');
        const session = await stage.createSession();
        sessions.set(req.sessionId, session);
        post({ type: 'result', reqId: req.reqId, kind: 'sessionCreate' });
        return;
      }
      case 'sessionFree': {
        const session = sessions.get(req.sessionId);
        sessions.delete(req.sessionId);
        if (session) await session.free();
        post({ type: 'result', reqId: req.reqId, kind: 'sessionFree' });
        return;
      }
    }
  } catch (err) {
    post({
      type: 'error',
      reqId: req.reqId,
      message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err),
    });
  }
}

// M2: serialize every native/wasm dispatch through one chain, even though
// several sessions are logically concurrent from the host's point of
// view. `self.onmessage` fires per inbound postMessage regardless of
// whether the PREVIOUS request's `await` chain (prefill/decode etc., each
// a real async yield point — WebGPU dispatch + readback, not a
// synchronous stub) has settled yet, so two sessions' requests arriving
// close together would otherwise start two independently-progressing
// `handle()` calls with overlapping `await`s into the SAME wasm instance
// / GPU device. Caught empirically during M2 e2e hardening: two real
// driver tabs streaming concurrently against one host intermittently hit
// a wasm-level `RuntimeError: unreachable` under genuine load (not
// reproduced by legion-stage-runtime's M1 harness gate, which alternates
// session A/session B one FULLY-AWAITED step at a time rather than
// letting two steps' async work genuinely overlap). Every session still
// gets its own independent KV state (that's M1's proven guarantee, and
// stays true here — this queue only orders WHEN each session's native
// call executes, not which memory it touches); this just removes
// wasm-instance-level concurrent-dispatch as a variable, which is a
// legitimate simplification (the underlying resource is one wasm module
// + one GPU queue regardless of session count) rather than a workaround
// for a design flaw.
let callChain: Promise<unknown> = Promise.resolve();
function serialize(req: StageWorkerRequest): Promise<void> {
  const run = callChain.then(
    () => handle(req),
    () => handle(req),
  );
  callChain = run.catch(() => undefined);
  return run;
}

self.onmessage = (ev: MessageEvent<StageWorkerRequest>) => {
  void serialize(ev.data);
};
