/**
 * useAudioPlayback — decode + play a base64-encoded audio clip
 * (`TtsSynthesizeContent`'s shape) on the MAIN thread via WebAudio.
 *
 * Reimplements (cleanly, in TS, not copied) the gapless-playback idea
 * from `H:/dev/wayfinder/web/app.js`'s `speakSeq`/`primeSpeech` (~L1006):
 * one shared `AudioContext` for the hook instance's lifetime, and a
 * serial promise chain (`chainRef`) so back-to-back `play()` calls (e.g.
 * clicking 🔊 on a second message before the first finishes) schedule
 * gaplessly one after another on the SAME context instead of two
 * `AudioContext`s fighting over the audio output or overlapping into
 * garbled sound. Unlike wayfinder's route-fragment cache (fixed phrases
 * pre-synthesized once, replayed many times), there's no cache here —
 * every `play()` is a fresh clip from a fresh `synthesize()` call — so
 * this hook is just the scheduling half of that pattern, not the
 * priming half.
 *
 * `AudioContext`/`decodeAudioData` are Window-only APIs — this hook is
 * main-thread-only by construction (a React hook can't run in a
 * worker), so there's no Worker trap to guard against here the way
 * `ttsWorker.ts` has to.
 */
import { useCallback, useRef, useState } from 'react';

export interface AudioPlaybackContent {
  /** Base64-encoded audio clip bytes. */
  audioBase64: string;
  /** Container/codec mime type, e.g. `audio/wav`. */
  mimeType: string;
}

export interface UseAudioPlaybackHandle {
  /** Decode + play one clip. Queues after any clip already playing/queued on this hook instance. */
  play: (content: AudioPlaybackContent) => Promise<void>;
  /** Stop whatever is currently playing (queued clips still play after). */
  stop: () => void;
  /** True while a clip decoded by this hook instance is actively playing. */
  playing: boolean;
  /** Non-null if the last `play()` failed (decode error, playback error). */
  error: string | null;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function useAudioPlayback(): UseAudioPlaybackHandle {
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  const getCtx = useCallback((): AudioContext => {
    if (!ctxRef.current) {
      const Ctor: typeof AudioContext =
        (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
          .AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
      ctxRef.current = new Ctor();
    }
    return ctxRef.current;
  }, []);

  const play = useCallback(
    (content: AudioPlaybackContent): Promise<void> => {
      const next = chainRef.current.then(async () => {
        try {
          setError(null);
          const ctx = getCtx();
          if (ctx.state === 'suspended') await ctx.resume();
          console.debug(`[legion-speech] playback: decoding clip (${content.mimeType})…`);
          const arrayBuffer = base64ToArrayBuffer(content.audioBase64);
          const buffer = await ctx.decodeAudioData(arrayBuffer);
          console.debug(`[legion-speech] playback: playing ${buffer.duration.toFixed(2)}s clip`);
          setPlaying(true);
          await new Promise<void>((resolve) => {
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            sourceRef.current = source;
            source.onended = () => resolve();
            source.start(0);
          });
          console.debug('[legion-speech] playback: done');
        } catch (err) {
          console.error('[legion-speech] playback: FAILED', err);
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          sourceRef.current = null;
          setPlaying(false);
        }
      });
      chainRef.current = next;
      return next;
    },
    [getCtx],
  );

  const stop = useCallback(() => {
    // `AudioBufferSourceNode.stop()` fires `onended`, which resolves the
    // pending `play()` promise in the chain above — no separate
    // chain-reset needed; the next queued `play()` proceeds normally.
    sourceRef.current?.stop();
  }, []);

  return { play, stop, playing, error };
}
