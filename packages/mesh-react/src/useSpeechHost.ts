/**
 * useSpeechHost — opt-in ASR hosting for this peer.
 *
 * When `enabled`, lazily constructs the speech Worker (via the caller's
 * `createWorker`), registers the `transcribe` tool
 * (`createAsrTranscribeTool` from `@unstable-legion/speech`) on the
 * passed `ToolRegistry`, and exposes the skill name + tool descriptor so
 * the host app can fold them into its `cap.skills[]` / `cap.tools[]`
 * advertisement and `optedIn` list.
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
 * framing overhead.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { SpeechWorkerClient, createAsrTranscribeTool } from '@unstable-legion/speech';
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
  /** True once the worker + engine are constructed and the tool is registered. */
  ready: boolean;
  /** `ASR_SKILL` — fold into `cap.skills[]` when `ready`. */
  skill: string;
  /** The registered tool's descriptor — fold into `cap.tools[]` when `ready`. */
  descriptor: MeshToolDescriptor | null;
  /** Transcribe a locally-recorded clip without a mesh round-trip. */
  transcribeLocal: (args: AsrTranscribeArgs) => Promise<AsrTranscribeContent>;
  /** Non-null if worker/engine construction (or the last transcribe) failed. */
  error: string | null;
}

export function useSpeechHost(opts: UseSpeechHostOptions): UseSpeechHostHandle {
  const { registry, enabled, createWorker } = opts;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [descriptor, setDescriptor] = useState<MeshToolDescriptor | null>(null);
  const clientRef = useRef<SpeechWorkerClient | null>(null);

  useEffect(() => {
    if (!enabled) {
      setReady(false);
      setDescriptor(null);
      return;
    }
    if (!createWorker) {
      setError('useSpeechHost: enabled=true but no createWorker was supplied');
      return;
    }
    setError(null);

    const worker = createWorker();
    const client = new SpeechWorkerClient(worker);
    clientRef.current = client;

    const reg = createAsrTranscribeTool(client);
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

  return { ready, skill: ASR_SKILL, descriptor, transcribeLocal, error };
}
