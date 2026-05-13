/**
 * useLocalLlm — load a Codec-aware browser LLM via @codecai/web-llm.
 *
 * Wraps the patched `wdunn001/web-llm` fork (`stream_format: "raw"`).
 * The host does no tokenize or detokenize on the wire path: the
 * engine's generate loop emits raw token IDs as `CodecFrame` objects;
 * we ship them verbatim over the mesh. Consumers (this peer's own UI,
 * other peers) detokenize at the edge via @codecai/web's `Detokenizer`
 * + the tokenizer map fetched from `/.well-known/codec/`.
 *
 * Cross-tab leader election: only one tab on the origin can hold the
 * WebGPU engine — multi-tab boot would download the model twice and
 * fight over GPU memory. We use `navigator.locks` to elect a leader.
 * Other tabs see `phase: "follower"` and skip the download. When the
 * leader closes the lock auto-releases and the next `load()` in a
 * still-open tab takes over.
 *
 * Mirrored-model URL swap: if the chosen modelId is in
 * `opts.mirror.modelIds`, the `prebuiltAppConfig` model entry has its
 * `model` field re-pointed at the mirror base URL instead of HF.
 *
 * The hook is configurable per-consumer: `modelId`, `mapId`, optional
 * `mirror` config, optional `leaderLockName`. Peer-dep on
 * `@codecai/web-llm` — that package's own dependency pins the patched
 * fork (`github:wdunn001/web-llm`), so the consumer never has to
 * mention `@mlc-ai/web-llm` directly.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
// Type-only static import so the engine's 6 MB of WebGPU runtime stays
// dynamically code-split — the actual symbols are pulled inside `load()`
// via `import('@codecai/web-llm')`.
import type {
  CodecEngine,
  CodecFrame,
  MLCEngineInterface,
} from '@codecai/web-llm';
import {
  isMirroredModelId,
  mirroredModelUrl,
  type MirroredModelConfig,
} from '@unstable-legion/core';

export type LlmStatus =
  | { phase: 'idle' }
  | { phase: 'unsupported'; reason: string }
  | { phase: 'follower'; reason: string }
  | { phase: 'loading'; pct: number; text: string }
  | { phase: 'ready'; modelId: string; mapId: string }
  | { phase: 'error'; error: string };

export interface UseLocalLlmOptions {
  /** MLC model id, e.g. `Qwen2.5-0.5B-Instruct-q4f16_1-MLC`. */
  modelId: string;
  /** Tokenizer-map id receivers use to detokenize the frames. */
  mapId: string;
  /** Optional same-origin mirror for the model weights. */
  mirror?: MirroredModelConfig;
  /** Web-Locks name for cross-tab leader election. */
  leaderLockName?: string;
  /** Default max tokens for generation. */
  defaultMaxTokens?: number;
  /**
   * Optional DedicatedWorker to host the engine. When provided, all
   * load + streamFrames calls are proxied via postMessage instead of
   * running on the main thread. The worker must implement the message
   * protocol documented in `apps/demo/src/workers/llmWorker.ts`.
   *
   * Why: backgrounded tabs throttle main-thread JS, which stalls
   * WebGPU dispatch and token read-back; a worker context has less
   * aggressive throttling, and inbound WebRTC events (the typical
   * caller of `streamFrames` in our distributed-/ai shape) still fire
   * on the main thread in real time.
   */
  worker?: Worker;
}

export interface UseLocalLlmHandle {
  status: LlmStatus;
  /** Begin the WebGPU model load (acquires leader lock first). Idempotent. */
  load: () => Promise<void>;
  /**
   * Stream raw CodecFrames from the engine. No host-side tokenization
   * or detokenization happens here — the engine emits IDs natively.
   */
  streamFrames: (
    prompt: string,
    onFrame: (frame: CodecFrame) => void,
  ) => Promise<void>;
}

const DEFAULT_LOCK_NAME = 'unstable-legion-engine-leader-v1';

/** Try to acquire the engine-leader lock without blocking. Returns null on miss. */
function acquireLeaderLock(lockName: string): Promise<{ release: () => void } | null> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return Promise.resolve({ release: () => undefined });
  }
  return new Promise((resolve) => {
    let releaseFn: () => void = () => undefined;
    const held = new Promise<void>((release) => {
      releaseFn = release;
    });
    navigator.locks
      .request(lockName, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        resolve({ release: releaseFn });
        await held;
      })
      .catch(() => resolve(null));
  });
}

function detectSupport(): LlmStatus {
  if (typeof navigator === 'undefined') return { phase: 'idle' };
  // @ts-expect-error — navigator.gpu lib.dom coverage varies
  if (!navigator.gpu) {
    return {
      phase: 'unsupported',
      reason:
        'this browser does not expose WebGPU. try Chrome 113+ on a desktop with a discrete or integrated GPU.',
    };
  }
  return { phase: 'idle' };
}

export function useLocalLlm(opts: UseLocalLlmOptions): UseLocalLlmHandle {
  const { modelId, mapId, mirror, defaultMaxTokens, worker } = opts;
  if (worker) {
    // Disambiguated to keep the main-thread path simple — worker mode
    // is a strict superset because the worker also has access to the
    // same mirror config + persona; we just delegate every call.
    // The conditional hook call below is allowed because the `worker`
    // identity doesn't change for the lifetime of the host component
    // (typically constructed once at App level).
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useLocalLlmWorker({ worker, modelId, mapId, mirror, defaultMaxTokens });
  }
  const lockName = opts.leaderLockName ?? DEFAULT_LOCK_NAME;
  const [status, setStatus] = useState<LlmStatus>(() => detectSupport());
  const codecRef = useRef<CodecEngine | null>(null);
  const loadingRef = useRef(false);
  const lockRef = useRef<{ release: () => void } | null>(null);

  useEffect(() => {
    setStatus(detectSupport());
    return () => {
      if (lockRef.current) {
        lockRef.current.release();
        lockRef.current = null;
      }
    };
  }, []);

  const load = useCallback(async () => {
    if (status.phase === 'ready' || loadingRef.current) return;
    if (status.phase === 'unsupported') return;
    loadingRef.current = true;
    try {
      setStatus({ phase: 'loading', pct: 0, text: 'acquiring engine leader lock…' });
      const lock = await acquireLeaderLock(lockName);
      if (!lock) {
        setStatus({
          phase: 'follower',
          reason:
            'another tab on this origin holds the engine. close that tab to take over, or switch to it to issue prompts.',
        });
        return;
      }
      lockRef.current = lock;

      setStatus({ phase: 'loading', pct: 0, text: 'fetching engine runtime…' });
      // Dynamic import so Vite splits the engine's 6 MB into its own
      // chunk, only fetched on first `load()`.
      const webllm = await import('@codecai/web-llm');

      const appConfig = JSON.parse(
        JSON.stringify(webllm.prebuiltAppConfig),
      ) as typeof webllm.prebuiltAppConfig;
      appConfig.cacheBackend = 'indexeddb';

      // Same-origin mirror swap.
      if (mirror && isMirroredModelId(mirror, modelId)) {
        const newBase = mirroredModelUrl(mirror, modelId);
        if (newBase) {
          for (const rec of appConfig.model_list) {
            if (rec.model_id === modelId) rec.model = newBase;
          }
          setStatus({
            phase: 'loading',
            pct: 0,
            text: `using same-origin mirror for ${modelId}`,
          });
        }
      }

      if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
        try {
          await navigator.storage.persist();
        } catch {
          /* ignore */
        }
      }

      setStatus({
        phase: 'loading',
        pct: 0,
        text: `booting WebGPU + downloading ${modelId} (cached after first run)`,
      });
      const engine: MLCEngineInterface = await webllm.CreateMLCEngine(modelId, {
        initProgressCallback: (report) => {
          setStatus({
            phase: 'loading',
            pct: Math.max(0, Math.min(1, report.progress ?? 0)),
            text: report.text ?? 'loading…',
          });
        },
        appConfig,
      });

      codecRef.current = webllm.wrapEngine(
        engine as unknown as Parameters<typeof webllm.wrapEngine>[0],
        { mapId, defaultMaxTokens },
      );
      setStatus({ phase: 'ready', modelId, mapId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ phase: 'error', error: message });
      if (lockRef.current) {
        lockRef.current.release();
        lockRef.current = null;
      }
    } finally {
      loadingRef.current = false;
    }
  }, [status.phase, modelId, mapId, mirror, lockName, defaultMaxTokens]);

  const streamFrames = useCallback<UseLocalLlmHandle['streamFrames']>(
    async (prompt, onFrame) => {
      const codec = codecRef.current;
      if (!codec) throw new Error('LLM not loaded — call load() first');
      await codec.streamFrames({ prompt, max_tokens: defaultMaxTokens ?? 256 }, onFrame);
    },
    [defaultMaxTokens],
  );

  return { status, load, streamFrames };
}

interface WorkerLoadMsg {
  kind: 'load';
  modelId: string;
  mapId: string;
  mirror?: MirroredModelConfig;
  defaultMaxTokens?: number;
}
interface WorkerStreamMsg {
  kind: 'streamFrames';
  streamId: string;
  prompt: string;
  max_tokens?: number;
}
interface WorkerDetectMsg {
  kind: 'detectSupport';
}
type WorkerOutMsg =
  | { kind: 'progress'; pct: number; text: string }
  | { kind: 'loaded' }
  | { kind: 'error'; error: string }
  | { kind: 'frame'; streamId: string; frame: CodecFrame }
  | { kind: 'streamDone'; streamId: string; ok: boolean; error?: string }
  | { kind: 'support'; status: LlmStatus };

interface UseLocalLlmWorkerOptions {
  worker: Worker;
  modelId: string;
  mapId: string;
  mirror?: MirroredModelConfig;
  defaultMaxTokens?: number;
}

/**
 * Worker-backed variant of useLocalLlm. Same handle shape so the
 * consumer (MeshChatPanel) doesn't know the difference.
 */
function useLocalLlmWorker(opts: UseLocalLlmWorkerOptions): UseLocalLlmHandle {
  const { worker, modelId, mapId, mirror, defaultMaxTokens } = opts;
  const [status, setStatus] = useState<LlmStatus>({ phase: 'idle' });
  const loadingRef = useRef(false);
  // Per-stream callback registry — multiple streamFrames calls in flight
  // can be correlated by streamId.
  const streamsRef = useRef(
    new Map<
      string,
      {
        onFrame: (frame: CodecFrame) => void;
        resolve: () => void;
        reject: (e: Error) => void;
      }
    >(),
  );

  useEffect(() => {
    const handler = (event: MessageEvent<WorkerOutMsg>): void => {
      const m = event.data;
      switch (m.kind) {
        case 'support':
          setStatus(m.status);
          return;
        case 'progress':
          setStatus({ phase: 'loading', pct: m.pct, text: m.text });
          return;
        case 'loaded':
          setStatus({ phase: 'ready', modelId, mapId });
          loadingRef.current = false;
          return;
        case 'error':
          setStatus({ phase: 'error', error: m.error });
          loadingRef.current = false;
          return;
        case 'frame': {
          const s = streamsRef.current.get(m.streamId);
          if (s) s.onFrame(m.frame);
          return;
        }
        case 'streamDone': {
          const s = streamsRef.current.get(m.streamId);
          if (!s) return;
          streamsRef.current.delete(m.streamId);
          if (m.ok) s.resolve();
          else s.reject(new Error(m.error ?? 'stream failed'));
          return;
        }
      }
    };
    worker.addEventListener('message', handler);
    // Ask the worker to report its support state.
    const probe: WorkerDetectMsg = { kind: 'detectSupport' };
    worker.postMessage(probe);
    return () => {
      worker.removeEventListener('message', handler);
    };
  }, [worker, modelId, mapId]);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    if (status.phase === 'ready' || status.phase === 'unsupported') return;
    loadingRef.current = true;
    setStatus({ phase: 'loading', pct: 0, text: 'requesting worker engine…' });
    const msg: WorkerLoadMsg = { kind: 'load', modelId, mapId, mirror, defaultMaxTokens };
    worker.postMessage(msg);
  }, [worker, modelId, mapId, mirror, defaultMaxTokens, status.phase]);

  const streamFrames = useCallback<UseLocalLlmHandle['streamFrames']>(
    (prompt, onFrame) => {
      return new Promise<void>((resolve, reject) => {
        const streamId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        streamsRef.current.set(streamId, { onFrame, resolve, reject });
        const msg: WorkerStreamMsg = {
          kind: 'streamFrames',
          streamId,
          prompt,
          max_tokens: defaultMaxTokens,
        };
        worker.postMessage(msg);
      });
    },
    [worker, defaultMaxTokens],
  );

  return { status, load, streamFrames };
}
