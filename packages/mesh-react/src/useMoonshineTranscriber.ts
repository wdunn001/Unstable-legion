/**
 * useMoonshineTranscriber — a LOCAL-ONLY ASR transcriber for conversation
 * mode's wake-listening (see `useVadListen`'s `transcribe` override, and
 * `apps/chat`'s `ChatPane.tsx` wiring). Mirrors `useSpeechHost`'s worker
 * lifecycle (lazy `Worker` construction, `SpeechWorkerClient`, cleanup on
 * disable) but is deliberately NOT a mesh host: it never touches a
 * `ToolRegistry` and advertises no skill/cap of its own — Moonshine only
 * ever serves THIS peer's own conversation-mode VAD, never a remote
 * peer's `asr.transcribe` call. Swapping the wake-listening ASR engine for
 * a tiny, fast, fully on-device one (Moonshine, 5.8M params, built for
 * voice commands) is the whole point: it turns "is the wake phrase being
 * said" into a question this tab can answer without a mesh round-trip,
 * while manual push-to-talk and "🎙 Listen" keep going through the
 * existing Whisper/mesh `useSpeechClient` path untouched.
 *
 * `createWorker` mirrors `useSpeechHost.createWorker` exactly (a
 * `new Worker(new URL('./workers/moonshineWorker.ts', import.meta.url),
 * { type: 'module' })` call living in the host app, since Vite's static
 * worker-bundling only reliably discovers that pattern in project source
 * — see `apps/chat/src/workers/moonshineWorker.ts`). The client is
 * constructed with `{ engine: 'moonshine' }` (see
 * `@unstable-legion/speech`'s `SpeechWorkerClient`/`worker.ts`), so the
 * SAME worker entry file that backs Whisper can back this instead —
 * which engine actually loads is decided per-`SpeechWorkerClient`, not
 * per-worker-file.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { SpeechWorkerClient } from '@unstable-legion/speech';
import type { AsrTranscribeContent } from '@unstable-legion/core';
import type { SpeechClientClip } from './useSpeechClient.js';

export interface UseMoonshineTranscriberOptions {
  /** Whether Moonshine should be loaded/kept warm right now — conversation
   * mode passes its own on/off state (see `ChatPane.tsx`). Toggling off
   * tears the worker down; toggling back on re-downloads/re-inits it
   * (transformers.js' Cache Storage hit makes a repeat init fast). */
  enabled: boolean;
  /** Constructs the Moonshine speech Worker. Required when `enabled` —
   * omitting it throws a descriptive error instead of silently no-opping
   * (same discipline as `useSpeechHost`). */
  createWorker?: () => Worker;
}

export interface UseMoonshineTranscriberHandle {
  /** True once the worker is constructed (the Moonshine model itself
   * still loads lazily inside the worker on the FIRST `transcribe` call —
   * same lazy-engine-construction shape as `useSpeechHost`/`worker.ts`). */
  ready: boolean;
  /** Transcribe a locally-recorded clip through Moonshine — no mesh
   * round-trip, ever (see module doc). */
  transcribe: (clip: SpeechClientClip) => Promise<AsrTranscribeContent>;
  /** Non-null if worker construction (or the last transcribe) failed. */
  error: string | null;
}

/** Mirrors `useSpeechClient.ts`'s private helper of the same name — kept
 * as its own tiny copy rather than a shared util, same as every other
 * base64 helper in this codebase (`workerClient.ts`, `wavEncode.ts`, …). */
function bytesToBase64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let bin = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < arr.length; i += chunkSize) {
    bin += String.fromCharCode(...arr.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}

export function useMoonshineTranscriber(opts: UseMoonshineTranscriberOptions): UseMoonshineTranscriberHandle {
  const { enabled, createWorker } = opts;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<SpeechWorkerClient | null>(null);

  useEffect(() => {
    if (!enabled) {
      setReady(false);
      return;
    }
    if (!createWorker) {
      setError('useMoonshineTranscriber: enabled=true but no createWorker was supplied');
      return;
    }
    setError(null);

    const worker = createWorker();
    const client = new SpeechWorkerClient(worker, { engine: 'moonshine' });
    clientRef.current = client;
    setReady(true);
    console.debug('[legion-speech] moonshine transcriber: worker ready (model loads lazily on first transcribe)');

    return () => {
      client.dispose();
      clientRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, createWorker]);

  const transcribe = useMemo(
    () =>
      async (clip: SpeechClientClip): Promise<AsrTranscribeContent> => {
        const client = clientRef.current;
        if (!client) throw new Error('moonshine transcriber is not enabled/ready');
        try {
          return await client.transcribe({
            audioBase64: bytesToBase64(clip.bytes),
            mimeType: clip.mimeType,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          throw err;
        }
      },
    [],
  );

  return { ready, transcribe, error };
}
