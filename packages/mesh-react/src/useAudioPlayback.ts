/**
 * useAudioPlayback — WebAudio playback for a synthesized `TtsSynthesizeContent`
 * clip (base64 WAV, as produced by `@unstable-legion/speech`'s
 * `ttsWorker.ts`/`wavEncode.ts`).
 *
 * One shared `AudioContext` per hook instance, one clip at a time — a
 * fresh `play()` call stops whatever's currently playing first, same
 * "only one clip" discipline `useMicCapture`'s recorder applies to
 * capture. Host apps should instantiate this ONCE (e.g. one per chat
 * pane, not one per message bubble) and pass the resulting `play`/`stop`/
 * `playing` down to each consumer — multiple instances would each own a
 * separate `AudioContext` and wouldn't stop each other's clips.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TtsSynthesizeContent } from '@unstable-legion/core';

export interface UseAudioPlaybackHandle {
  /** Decode + play a synthesized clip. Stops any clip already playing first. */
  play: (content: TtsSynthesizeContent) => Promise<void>;
  /** Stop the currently playing clip, if any. */
  stop: () => void;
  /** True while a clip is actively playing. */
  playing: boolean;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function useAudioPlayback(): UseAudioPlaybackHandle {
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const [playing, setPlaying] = useState(false);

  const getCtx = useCallback((): AudioContext => {
    if (!ctxRef.current) ctxRef.current = new AudioContext();
    return ctxRef.current;
  }, []);

  const stop = useCallback(() => {
    const source = sourceRef.current;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already stopped/finished — nothing to do
      }
      source.disconnect();
      sourceRef.current = null;
    }
    setPlaying(false);
  }, []);

  const play = useCallback(
    async (content: TtsSynthesizeContent): Promise<void> => {
      stop(); // only one clip at a time
      const ctx = getCtx();
      if (ctx.state === 'suspended') await ctx.resume();

      const bytes = base64ToBytes(content.audioBase64);
      const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.onended = () => {
        if (sourceRef.current === source) {
          sourceRef.current = null;
          setPlaying(false);
        }
      };

      sourceRef.current = source;
      setPlaying(true);
      source.start();
    },
    [stop, getCtx],
  );

  useEffect(() => {
    return () => {
      stop();
      if (ctxRef.current) {
        void ctxRef.current.close();
        ctxRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { play, stop, playing };
}
