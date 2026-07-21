/**
 * useTtsHost — opt-in TTS hosting for this peer.
 *
 * Mirrors `useSpeechHost` (ASR) exactly, reverse capability: when
 * `enabled`, lazily constructs the TTS Worker (via the caller's
 * `createWorker`), registers the `synthesize` tool
 * (`createTtsSynthesizeTool` from `@unstable-legion/speech`) on the
 * passed `ToolRegistry`, and exposes the skill name + tool descriptor so
 * the host app can fold them into its `cap.skills[]` / `cap.tools[]`
 * advertisement and `optedIn` list.
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
 * overhead. `voices` populates once the engine has loaded (a cheap
 * follow-up round-trip to the worker, not part of the initial
 * construction) — a future voice-picker UI can read it directly.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { TtsWorkerClient, createTtsSynthesizeTool } from '@unstable-legion/speech';
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
  /** True once the worker + engine are constructed and the tool is registered. */
  ready: boolean;
  /** `TTS_SKILL` — fold into `cap.skills[]` when `ready`. */
  skill: string;
  /** The registered tool's descriptor — fold into `cap.tools[]` when `ready`. */
  descriptor: MeshToolDescriptor | null;
  /** Synthesize locally-requested text without a mesh round-trip. */
  synthesizeLocal: (args: TtsSynthesizeArgs) => Promise<TtsSynthesizeContent>;
  /** Voice ids the loaded engine supports. Empty until the engine finishes loading. */
  voices: string[];
  /** Non-null if worker/engine construction (or the last synthesize) failed. */
  error: string | null;
}

export function useTtsHost(opts: UseTtsHostOptions): UseTtsHostHandle {
  const { registry, enabled, createWorker } = opts;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [descriptor, setDescriptor] = useState<MeshToolDescriptor | null>(null);
  const [voices, setVoices] = useState<string[]>([]);
  const clientRef = useRef<TtsWorkerClient | null>(null);

  useEffect(() => {
    if (!enabled) {
      setReady(false);
      setDescriptor(null);
      setVoices([]);
      return;
    }
    if (!createWorker) {
      setError('useTtsHost: enabled=true but no createWorker was supplied');
      return;
    }
    setError(null);

    const worker = createWorker();
    const client = new TtsWorkerClient(worker);
    clientRef.current = client;

    const reg = createTtsSynthesizeTool(client);
    registry.register(reg);
    setDescriptor(reg.descriptor);
    setReady(true);

    return () => {
      registry.unregister(reg.descriptor.name);
      client.dispose();
      clientRef.current = null;
      setReady(false);
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

  return { ready, skill: TTS_SKILL, descriptor, synthesizeLocal, voices, error };
}
