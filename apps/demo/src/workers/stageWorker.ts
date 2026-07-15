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
import { loadStage, type StageDescriptor, type StageHandle, type ActivationFrame } from '@unstable-legion/stage-runtime';
import type {
  StageWorkerRequest,
  StageWorkerResponse,
  WireActivationFrame,
} from '@unstable-legion/react';

let stage: StageHandle | undefined;

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
        stage = await loadStage(descriptor, {
          createModule: createLegionStageModule,
          baseUrl: self.location.origin,
          onProgress: (phase: string) => console.log(`[stage-worker] ${phase} ${mem()}`),
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
        const result = await stage.prefill(req.tokens, req.positions, input);
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
        const result = await stage.decodeStep(req.token, input);
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
        await stage.reset();
        post({ type: 'result', reqId: req.reqId, kind: 'reset' });
        return;
      }
      case 'dispose': {
        if (stage) await stage.dispose();
        stage = undefined;
        post({ type: 'result', reqId: req.reqId, kind: 'dispose' });
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

self.onmessage = (ev: MessageEvent<StageWorkerRequest>) => {
  void handle(ev.data);
};
