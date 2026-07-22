/**
 * useTtsHost — opt-in TTS hosting for this peer.
 *
 * Mirrors `useSpeechHost` (ASR) exactly, reverse capability: when
 * `enabled`, lazily constructs the TTS Worker (via the caller's
 * `createWorker`) and WARMS it — `client.warmup()` loads the actual
 * Kokoro model before `ready` ever flips true, same as `useSpeechHost`'s
 * doc explains in full: `ready` used to flip the instant the client was
 * constructed, which let the "🔊 Host text-to-speech" toggle (and
 * anything gated on `ttsHost.ready`, e.g. auto-speak/conversation mode
 * reachability) go live before the model existed, so the first
 * `synthesize` silently triggered the download. `loading`/`progress`
 * cover that gap.
 *
 * The `synthesize` tool (`createTtsSynthesizeTool` from
 * `@unstable-legion/speech`) is registered on the passed `ToolRegistry`,
 * and `descriptor` is populated, ONLY once warmup succeeds — same
 * "never advertise a cold tool" discipline as `useSpeechHost`.
 *
 * This hook deliberately does NOT call `peer.setCap` itself — same
 * reasoning as `useSpeechHost`'s doc comment: the top-level cap
 * `useMemo` is the single place that decides what's advertised.
 *
 * `createWorker` mirrors `useSpeechHost`'s prop — the actual `new
 * Worker(new URL('./workers/ttsWorker.ts', import.meta.url), {type:
 * 'module'})` call needs to live in the consuming app (Vite's worker
 * bundling only reliably discovers that pattern in project source, not
 * inside a dependency package — see `apps/chat/src/workers/ttsWorker.ts`,
 * a thin re-export of `@unstable-legion/speech`'s `ttsWorker.ts`, same
 * idiom as `speechWorker.ts`). This package doesn't construct a `Worker`
 * on its own behalf.
 *
 * `synthesizeLocal` lets the host synthesize its own text without a mesh
 * round-trip (solo/loopback mode) — same engine, no `tc` framing
 * overhead. `voices` populates once `ready` (a cheap follow-up
 * round-trip to the ALREADY-warm worker/engine, not part of warmup
 * itself) — a future voice-picker UI can read it directly.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { TtsWorkerClient, createTtsSynthesizeTool, type EngineLoadProgress } from '@unstable-legion/speech';
import {
  TTS_SKILL,
  type TtsSynthesizeArgs,
  type TtsSynthesizeContent,
  type MeshToolDescriptor,
  type ToolRegistry,
} from '@unstable-legion/core';

export interface UseTtsHostOptions {
  /** The local tool registry (same instance the host passes to `useMeshTools`). */
  registry: ToolRegistry;
  /** Whether this peer is hosting TTS right now. */
  enabled: boolean;
  /**
   * Constructs the TTS Worker. Required when `enabled` — omitting it
   * throws a descriptive error instead of silently no-opping (there's no
   * safe bundler-agnostic default; see module doc).
   */
  createWorker?: () => Worker;
}

export interface UseTtsHostHandle {
  /** True once the Kokoro MODEL has finished loading (not just the
   * worker constructed) and the `synthesize` tool is registered/
   * advertised. See module doc. */
  ready: boolean;
  /** True while the model is downloading/initializing — the gap between
   * `enabled` flipping on and `ready` flipping true. */
  loading: boolean;
  /** Most recent load-progress event from the worker, or `null` before
   * the first one arrives (e.g. a warm Cache Storage hit may resolve
   * `ready` with no `progress` events at all). */
  progress: EngineLoadProgress | null;
  /** `TTS_SKILL` — fold into `cap.skills[]` when `ready`. */
  skill: string;
  /** The registered tool's descriptor once `ready`; `null` otherwise. */
  descriptor: MeshToolDescriptor | null;
  /** Synthesize locally-requested text without a mesh round-trip. */
  synthesizeLocal: (args: TtsSynthesizeArgs) => Promise<TtsSynthesizeContent>;
  /** Voice ids the loaded engine supports. Empty until `ready`. */
  voices: string[];
  /** Non-null if worker/model warmup (or the last synthesize) failed. */
  error: string | null;
}

export function useTtsHost(opts: UseTtsHostOptions): UseTtsHostHandle {
  const { registry, enabled, createWorker } = opts;
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<EngineLoadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [descriptor, setDescriptor] = useState<MeshToolDescriptor | null>(null);
  const [voices, setVoices] = useState<string[]>([]);
  const clientRef = useRef<TtsWorkerClient | null>(null);

  useEffect(() => {
    if (!enabled) {
      setReady(false);
      setLoading(false);
      setProgress(null);
      setDescriptor(null);
      setVoices([]);
      return;
    }
    if (!createWorker) {
      setError('useTtsHost: enabled=true but no createWorker was supplied');
      return;
    }
    setError(null);
    setProgress(null);
    setLoading(true);

    const worker = createWorker();
    const client = new TtsWorkerClient(worker);
    clientRef.current = client;

    // Built up front (cheap), REGISTERED only once warmup succeeds below
    // — see module doc.
    const reg = createTtsSynthesizeTool(client);

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
      setVoices([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, registry, createWorker]);

  // Voice list: a cheap follow-up query once the worker/engine is ready —
  // separate from construction so a slow `list_voices()` call (engine
  // still loading) can't delay `ready`/tool registration.
  useEffect(() => {
    if (!ready) return;
    const client = clientRef.current;
    if (!client) return;
    let cancelled = false;
    client
      .listVoices()
      .then((v) => {
        if (!cancelled) setVoices(v);
      })
      .catch((err) => {
        console.warn('[legion-speech] useTtsHost: listVoices failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, [ready]);

  const synthesizeLocal = useMemo(
    () =>
      async (args: TtsSynthesizeArgs): Promise<TtsSynthesizeContent> => {
        const client = clientRef.current;
        if (!client) throw new Error('TTS host is not enabled/ready on this peer');
        try {
          return await client.synthesize(args);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          throw err;
        }
      },
    [],
  );

  return { ready, loading, progress, skill: TTS_SKILL, descriptor, synthesizeLocal, voices, error };
}
