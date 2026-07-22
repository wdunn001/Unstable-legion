/**
 * useTtsSpeaker — rolling/chunked TTS: speak arbitrarily long text without
 * overflowing Kokoro-82M's ~510-phoneme-token max context, and start
 * playing audio sooner than "wait for the whole reply to synthesize".
 *
 * Composes `useTtsClient` (this hook's own instance — same local-vs-mesh
 * resolution: this peer's TTS host, else a roster peer advertising
 * `TTS_SKILL`) with `useAudioPlayback()`. `speak(text)` splits `text` into
 * chunks via `@unstable-legion/speech`'s `splitForTts` (sentence-sized,
 * safely under Kokoro's limit), then walks them IN ORDER:
 *
 *   - synthesize chunks ONE AT A TIME — a single Kokoro worker/engine is
 *     NOT safe to call re-entrantly, so chunk[i+1]'s `synthesize` is never
 *     started before chunk[i]'s has resolved.
 *   - but playback is NOT awaited before starting the next synth — `play()`
 *     is fire-and-forget from this loop's perspective (queued onto
 *     `useAudioPlayback`'s gapless `chainRef`, which preserves order), so
 *     chunk[i+1] synthesizes WHILE chunk[i] plays. That overlap is the
 *     entire latency-to-first-audio win: the first chunk starts playing as
 *     soon as it's synthesized, not after the whole reply is.
 *
 * `speaking` stays true from the start of `speak()` until the LAST queued
 * clip finishes playing (or a `stop()`/abort cuts it short) — a caller
 * doesn't need to separately track "still synthesizing" vs "still
 * playing".
 *
 * `stop()` sets an abort flag (checked before each chunk's synth AND
 * before each chunk is handed to playback, so no new work starts) and
 * calls `useAudioPlayback`'s `stopAndClear()` (halts the currently-playing
 * clip AND skips any clips already queued but not yet started) — so
 * clicking stop mid-reply doesn't let the rest of the queue keep talking.
 */
import { useCallback, useRef, useState } from 'react';
import { splitForTts } from '@unstable-legion/speech';

import { useTtsClient, type UseTtsClientOptions } from './useTtsClient.js';
import { useAudioPlayback } from './useAudioPlayback.js';

export type UseTtsSpeakerOptions = UseTtsClientOptions;

export interface UseTtsSpeakerHandle {
  /** Split `text`, synthesize + play each chunk in order (pipelined). Resolves once the last chunk finishes playing (or the speak is stopped). */
  speak: (text: string, opts?: { voice?: string }) => Promise<void>;
  /** Abort any in-flight synth loop and stop + flush queued playback. */
  stop: () => void;
  /** True from the start of `speak()` until its last clip finishes (or it's stopped). */
  speaking: boolean;
}

export function useTtsSpeaker(opts: UseTtsSpeakerOptions): UseTtsSpeakerHandle {
  const client = useTtsClient(opts);
  const playback = useAudioPlayback();
  const [speaking, setSpeaking] = useState(false);
  const abortedRef = useRef(false);

  const speak = useCallback(
    async (text: string, extra?: { voice?: string }): Promise<void> => {
      abortedRef.current = false;
      const chunks = splitForTts(text);
      if (chunks.length === 0) return;

      console.debug(`[legion-speech] speak: ${chunks.length} chunk(s)`);
      setSpeaking(true);
      let lastPlay: Promise<void> = Promise.resolve();
      try {
        for (let i = 0; i < chunks.length; i++) {
          if (abortedRef.current) break;
          console.debug(`[legion-speech] speak: chunk ${i + 1}/${chunks.length} synth start`);
          const content = await client.synthesize(chunks[i], extra);
          console.debug(`[legion-speech] speak: chunk ${i + 1}/${chunks.length} synth done`);
          if (abortedRef.current) break;
          // NOT awaited — this is the pipelining: chunk i+1 starts
          // synthesizing on the next loop iteration while chunk i plays.
          lastPlay = playback.play(content);
        }
        await lastPlay;
        console.debug('[legion-speech] speak: done');
      } finally {
        setSpeaking(false);
      }
    },
    [client, playback],
  );

  const stop = useCallback(() => {
    abortedRef.current = true;
    playback.stopAndClear();
  }, [playback]);

  return { speak, stop, speaking };
}
