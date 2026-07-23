/**
 * useSpeechHost — opt-in ASR hosting for this peer.
 *
 * When `enabled`, lazily constructs the speech Worker (via the caller's
 * `createWorker`) and WARMS it: `client.warmup()` loads the actual Whisper
 * model before `ready` ever flips true (see `SpeechWorkerClient.warmup`'s
 * doc for the `warmup`/`ready`/`progress` wire protocol). `ready` used to
 * flip the instant the client was constructed — a worker existing said
 * nothing about whether the model had loaded, so the FIRST real
 * `transcribe` silently triggered the (multi-second, sometimes
 * multi-hundred-MB) download while the mic/mesh-tool UI already looked
 * live. Now `ready` means "the model is loaded and this peer can actually
 * serve a transcribe call" — `loading`/`progress` cover the gap in
 * between so the host app can show real status instead of a dead
 * "initializing…" placeholder (see `ToolContributionPanel.tsx`).
 *
 * The `transcribe` tool (`createAsrTranscribeTool` from
 * `@unstable-legion/speech`) is registered on the passed `ToolRegistry`,
 * and `descriptor` is populated, ONLY once warmup succeeds — so a mesh
 * peer can never see this tab advertise `asr.transcribe` (via
 * `cap.tools[]`, folded in by the host app's cap `useMemo` whenever
 * `speechHost.ready`) before it can actually serve a call warm. `skill`
 * (`ASR_SKILL`) is likewise only meaningful once `ready`; callers already
 * gate on `ready` before adding it to `cap.skills[]` (see `apps/chat`'s
 * `App.tsx`), so it's returned unconditionally for convenience but never
 * folded in early.
 *
 * This hook deliberately does NOT call `peer.setCap` itself — the
 * top-level cap `useMemo` (see `apps/demo`'s `App.tsx`) is the single
 * place that decides what's advertised, so this hook and, say,
 * `useCommunalHost`'s `stageHost` merge don't clobber each other's cap
 * fields the way they would if each independently re-merged onto a
 * stale `baseCap` snapshot via its own `peer.setCap` call.
 *
 * `createWorker` mirrors `useCommunalHost`'s `createStageWorker` prop —
 * the actual `new Worker(new URL('./workers/speechWorker.ts',
 * import.meta.url), { type: 'module' })` call needs to live in the
 * consuming app (Vite's worker bundling only reliably discovers that
 * pattern in project source, not inside a dependency package — see
 * `apps/demo/src/workers/speechWorker.ts`, a thin re-export of
 * `@unstable-legion/speech`'s `worker.ts`, same idiom as
 * `stageWorker.ts`/`llmWorker.ts`). This package doesn't construct a
 * `Worker` on its own behalf.
 *
 * `transcribeLocal` lets the host transcribe its own recorded clip
 * without a mesh round-trip (solo/loopback mode) — same engine, no `tc`
 * framing overhead. It still works if called before `ready` (the
 * underlying `client.transcribe` call falls back to the worker's own
 * lazy `getEngine`, same as before this change), but every caller in this
 * codebase already gates on `speechHost.ready` first (see
 * `Composer.tsx`/`ChatPane.tsx`), so in practice it's never invoked warm.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { SpeechWorkerClient, createAsrTranscribeTool, type EngineLoadProgress } from '@unstable-legion/speech';
import {
  ASR_SKILL,
  type AsrTranscribeArgs,
  type AsrTranscribeContent,
  type MeshToolDescriptor,
  type ToolRegistry,
} from '@unstable-legion/core';

export interface UseSpeechHostOptions {
  /** The local tool registry (same instance the host passes to `useMeshTools`). */
  registry: ToolRegistry;
  /** Whether this peer is hosting ASR right now. */
  enabled: boolean;
  /**
   * Constructs the speech Worker. Required when `enabled` — omitting it
   * throws a descriptive error instead of silently no-opping (there's no
   * safe bundler-agnostic default; see module doc).
   */
  createWorker?: () => Worker;
}

export interface UseSpeechHostHandle {
  /** True once the Whisper MODEL has finished loading (not just the
   * worker constructed) and the `transcribe` tool is registered/
   * advertised. See module doc. */
  ready: boolean;
  /** True while the model is downloading/initializing — the gap between
   * `enabled` flipping on and `ready` flipping true. */
  loading: boolean;
  /** Most recent load-progress event from the worker, or `null` before
   * the first one arrives (e.g. a warm Cache Storage hit may resolve
   * `ready` with no `progress` events at all). */
  progress: EngineLoadProgress | null;
  /** `ASR_SKILL` — fold into `cap.skills[]` when `ready`. */
  skill: string;
  /** The registered tool's descriptor once `ready`; `null` otherwise — so
   * a host app that (incorrectly) forgot to gate on `ready` still can't
   * accidentally advertise a cold tool. */
  descriptor: MeshToolDescriptor | null;
  /** Transcribe a locally-recorded clip without a mesh round-trip. */
  transcribeLocal: (args: AsrTranscribeArgs) => Promise<AsrTranscribeContent>;
  /** Non-null if worker/model warmup (or the last transcribe) failed. */
  error: string | null;
}

export function useSpeechHost(opts: UseSpeechHostOptions): UseSpeechHostHandle {
  const { registry, enabled, createWorker } = opts;
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<EngineLoadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [descriptor, setDescriptor] = useState<MeshToolDescriptor | null>(null);
  const clientRef = useRef<SpeechWorkerClient | null>(null);

  useEffect(() => {
    if (!enabled) {
      setReady(false);
      setLoading(false);
      setProgress(null);
      setDescriptor(null);
      return;
    }
    if (!createWorker) {
      setError('useSpeechHost: enabled=true but no createWorker was supplied');
      return;
    }
    setError(null);
    setProgress(null);
    setLoading(true);

    const worker = createWorker();
    const client = new SpeechWorkerClient(worker);
    clientRef.current = client;

    // Built up front (cheap — no model I/O), but only REGISTERED once
    // warmup succeeds below, so `registry`/`descriptor` never expose a
    // cold tool. See module doc.
    const reg = createAsrTranscribeTool(client);

    let cancelled = false;
    void client
      .warmup((p) => {
        if (!cancelled) setProgress(p);
      })
      .then(() => {
        if (cancelled) return;
        registry.register(reg);
        setDescriptor(reg.descriptor);
        setReady(true);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      // Idempotent even if warmup never finished (never registered) —
      // see mesh-core's ToolRegistry.unregister (a plain Map.delete).
      registry.unregister(reg.descriptor.name);
      client.dispose();
      clientRef.current = null;
      setReady(false);
      setLoading(false);
      setProgress(null);
      setDescriptor(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, registry, createWorker]);

  const transcribeLocal = useMemo(
    () =>
      async (args: AsrTranscribeArgs): Promise<AsrTranscribeContent> => {
        const client = clientRef.current;
        if (!client) throw new Error('ASR host is not enabled/ready on this peer');
        try {
          return await client.transcribe(args);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          throw err;
        }
      },
    [],
  );

  return { ready, loading, progress, skill: ASR_SKILL, descriptor, transcribeLocal, error };
}
