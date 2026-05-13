/**
 * llmWorker — runs the @codecai/web-llm engine off the main thread.
 *
 * Why: when the user backgrounds the page tab, Chromium throttles
 * main-thread JS (setTimeout ~1/min, intensive throttling after 5
 * min). WebGPU compute dispatched from the throttled main thread
 * inherits that delay: a /ai request mid-stream stalls until the tab
 * is refocused. By hosting the engine in a DedicatedWorker, the
 * forward-pass dispatch and token read-back happen in a worker
 * context whose timer throttling is less aggressive, and incoming
 * WebRTC chat events on the main thread can fire the worker via
 * postMessage without the main thread itself needing to do compute.
 *
 * The `useLocalLlm` hook on the main side proxies load + streamFrames
 * through this worker. Messages are intentionally hand-rolled (not
 * MLC's WebWorkerMLCEngineHandler) because we wrap the engine via
 * `@codecai/web-llm`'s `wrapEngine()` to get Codec-frame streaming
 * — that wrapper expects to live in the same context as the engine.
 *
 * Protocol — see `useLocalLlm.ts` for the matching client side.
 *   in  : { kind: 'load', modelId, mapId, mirror?, defaultMaxTokens? }
 *   out : { kind: 'progress', pct, text }
 *   out : { kind: 'loaded' }
 *   out : { kind: 'error', error }
 *   in  : { kind: 'streamFrames', streamId, prompt, max_tokens }
 *   out : { kind: 'frame', streamId, frame }
 *   out : { kind: 'streamDone', streamId, ok, error? }
 *   in  : { kind: 'detectSupport' }
 *   out : { kind: 'support', status: LlmStatus }
 */
import {
  CreateMLCEngine,
  wrapEngine,
  prebuiltAppConfig,
  type CodecEngine,
  type MLCEngineInterface,
} from '@codecai/web-llm';
import {
  isMirroredModelId,
  mirroredModelUrl,
  type MirroredModelConfig,
} from '@unstable-legion/core';

interface LoadMsg {
  kind: 'load';
  modelId: string;
  mapId: string;
  mirror?: MirroredModelConfig;
  defaultMaxTokens?: number;
}

interface StreamMsg {
  kind: 'streamFrames';
  streamId: string;
  prompt: string;
  max_tokens?: number;
}

interface DetectMsg {
  kind: 'detectSupport';
}

type InMsg = LoadMsg | StreamMsg | DetectMsg;

let codec: CodecEngine | null = null;
let defaultMaxTokens = 256;
let loading = false;

function post(msg: unknown): void {
  (self as unknown as Worker).postMessage(msg);
}

async function handleDetectSupport(): Promise<void> {
  // Worker-side WebGPU check. `navigator.gpu` is available in
  // DedicatedWorker in Chrome 113+; we mirror the main-thread shape
  // `useLocalLlm` returns from detectSupport() so the consumer can
  // reuse the same status enum.
  const nav = (self as unknown as { navigator?: { gpu?: unknown } }).navigator;
  if (!nav?.gpu) {
    post({
      kind: 'support',
      status: {
        phase: 'unsupported',
        reason:
          'this browser does not expose WebGPU inside a DedicatedWorker. Chrome 113+ desktop is the floor.',
      },
    });
    return;
  }
  post({ kind: 'support', status: { phase: 'idle' } });
}

async function handleLoad(msg: LoadMsg): Promise<void> {
  if (codec) {
    post({ kind: 'loaded' });
    return;
  }
  if (loading) return;
  loading = true;
  try {
    defaultMaxTokens = msg.defaultMaxTokens ?? 256;

    const appConfig = JSON.parse(JSON.stringify(prebuiltAppConfig)) as typeof prebuiltAppConfig;
    appConfig.cacheBackend = 'indexeddb';

    // Same-origin mirror swap. The host page is mounted at
    // legion.codecai.net and the mirror lives at /webllm/ on the
    // same origin — the worker can fetch it without CORS issues.
    if (msg.mirror && isMirroredModelId(msg.mirror, msg.modelId)) {
      const newBase = mirroredModelUrl(msg.mirror, msg.modelId);
      if (newBase) {
        for (const rec of appConfig.model_list) {
          if (rec.model_id === msg.modelId) rec.model = newBase;
        }
      }
    }

    // OPFS / IndexedDB persistence — the worker also has access to
    // navigator.storage in Chrome.
    const nav = (self as unknown as {
      navigator?: { storage?: { persist?: () => Promise<boolean> } };
    }).navigator;
    if (nav?.storage?.persist) {
      try {
        await nav.storage.persist();
      } catch {
        /* ignore */
      }
    }

    post({
      kind: 'progress',
      pct: 0,
      text: `booting WebGPU + downloading ${msg.modelId} (cached after first run)`,
    });
    const engine: MLCEngineInterface = await CreateMLCEngine(msg.modelId, {
      initProgressCallback: (report) => {
        post({
          kind: 'progress',
          pct: Math.max(0, Math.min(1, report.progress ?? 0)),
          text: report.text ?? 'loading…',
        });
      },
      appConfig,
    });
    codec = wrapEngine(engine as unknown as Parameters<typeof wrapEngine>[0], {
      mapId: msg.mapId,
      defaultMaxTokens,
    });
    post({ kind: 'loaded' });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    post({ kind: 'error', error });
  } finally {
    loading = false;
  }
}

async function handleStream(msg: StreamMsg): Promise<void> {
  if (!codec) {
    post({
      kind: 'streamDone',
      streamId: msg.streamId,
      ok: false,
      error: 'engine not loaded — call load() first',
    });
    return;
  }
  try {
    await codec.streamFrames(
      { prompt: msg.prompt, max_tokens: msg.max_tokens ?? defaultMaxTokens },
      (frame) => {
        // Frame is a plain object with `ids: number[]` etc. — fully
        // structured-clonable, so postMessage handles it.
        post({ kind: 'frame', streamId: msg.streamId, frame });
      },
    );
    post({ kind: 'streamDone', streamId: msg.streamId, ok: true });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    post({ kind: 'streamDone', streamId: msg.streamId, ok: false, error });
  }
}

self.onmessage = (event: MessageEvent<InMsg>) => {
  const m = event.data;
  switch (m.kind) {
    case 'detectSupport':
      void handleDetectSupport();
      break;
    case 'load':
      void handleLoad(m);
      break;
    case 'streamFrames':
      void handleStream(m);
      break;
  }
};
