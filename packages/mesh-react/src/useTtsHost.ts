/**
 * useTtsHost — opt-in TTS hosting for this peer.
 *
 * When `enabled`, lazily constructs the TTS Worker (via the caller's
 * `createWorker`), registers the `synthesize` tool
 * (`createTtsSynthesizeTool` from `@unstable-legion/speech`) on the
 * passed `ToolRegistry`, and exposes the skill name + tool descriptor so
 * the host app can fold them into its `cap.skills[]` / `cap.tools[]`
 * advertisement and `optedIn` list. Mirrors `useSpeechHost.ts` exactly —
 * see that file's doc comment for the rationale behind each design
 * choice (this hook not calling `peer.setCap` itself, the `createWorker`
 * indirection, etc.), all of which applies here unchanged.
 *
 * `createWorker` mirrors `useSpeechHost`'s prop of the same name — the
 * actual `new Worker(new URL('./workers/ttsWorker.ts', import.meta.url),
 * { type: 'module' })` call needs to live in the consuming app (see
 * `apps/chat`'s `ttsWorker.ts`, a thin re-export of
 * `@unstable-legion/speech`'s `ttsWorker.ts` via its `./tts-worker`
 * export). This is a SEPARATE worker from `useSpeechHost`'s — a peer may
 * host TTS without hosting ASR, or vice versa, so the two hooks (and
 * their workers) have fully independent lifecycles.
 *
 * `synthesizeLocal` lets the host synthesize speech for itself without a
 * mesh round-trip (solo/loopback mode) — same engine, no `tc` framing
 * overhead.
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
  /** Synthesize speech locally without a mesh round-trip. */
  synthesizeLocal: (args: TtsSynthesizeArgs) => Promise<TtsSynthesizeContent>;
  /** Non-null if worker/engine construction (or the last synthesize) failed. */
  error: string | null;
}

export function useTtsHost(opts: UseTtsHostOptions): UseTtsHostHandle {
  const { registry, enabled, createWorker } = opts;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [descriptor, setDescriptor] = useState<MeshToolDescriptor | null>(null);
  const clientRef = useRef<TtsWorkerClient | null>(null);

  useEffect(() => {
    if (!enabled) {
      setReady(false);
      setDescriptor(null);
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, registry, createWorker]);

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

  return { ready, skill: TTS_SKILL, descriptor, synthesizeLocal, error };
}
