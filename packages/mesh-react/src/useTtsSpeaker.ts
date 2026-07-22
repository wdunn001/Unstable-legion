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
 * SUPERSEDE-SAFE: a NEW `speak()` call can start while a previous one is
 * still mid-flight (e.g. auto-speak: reply B finishes streaming and gets
 * spoken while reply A is still being read aloud). A single shared "abort"
 * flag can't express that safely — it can only mean "stop everything",
 * not "cancel the OLD call, let the NEW one own the engine" — and the
 * underlying Kokoro engine/worker is not safe to call re-entrantly from
 * two overlapping loops. So concurrency is guarded with a generation
 * counter instead: each `speak()` bumps `genRef` and captures its own
 * value; every loop check compares against the CURRENT `genRef`, so a
 * later `speak()` cleanly invalidates an earlier one's loop (and flushes
 * its queued audio) without a shared boolean that both loops would fight
 * over.
 *
 * `stop()` bumps the generation counter (invalidating any in-flight
 * `speak()`, checked before each chunk's synth AND before each chunk is
 * handed to playback, so no new work starts) and calls
 * `useAudioPlayback`'s `stopAndClear()` (halts the currently-playing clip
 * AND skips any clips already queued but not yet started) — so clicking
 * stop mid-reply doesn't let the rest of the queue keep talking. A
 * superseding `speak()` does the same two things before starting its own
 * loop, so it both cancels the previous call AND flushes its audio.
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
  // Bumped by both `stop()` and every new `speak()` call — see the
  // SUPERSEDE-SAFE doc above. `myGen` below is this call's own snapshot;
  // once `genRef.current` moves past it, this call is stale and must stop
  // touching the engine/playback/state.
  const genRef = useRef(0);

  const speak = useCallback(
    async (text: string, extra?: { voice?: string }): Promise<void> => {
      // A superseding speak() cancels whatever loop is currently running
      // (bumping past its `myGen`) AND flushes its queued audio, so the new
      // call starts from a clean playback queue rather than gapless-queuing
      // behind the call it's replacing.
      const myGen = ++genRef.current;
      playback.stopAndClear();
      const chunks = splitForTts(text);
      if (chunks.length === 0) return;

      console.debug(`[legion-speech] speak: ${chunks.length} chunk(s)`);
      setSpeaking(true);
      let lastPlay: Promise<void> = Promise.resolve();
      try {
        for (let i = 0; i < chunks.length; i++) {
          if (genRef.current !== myGen) break;
          console.debug(`[legion-speech] speak: chunk ${i + 1}/${chunks.length} synth start`);
          const content = await client.synthesize(chunks[i], extra);
          console.debug(`[legion-speech] speak: chunk ${i + 1}/${chunks.length} synth done`);
          if (genRef.current !== myGen) break;
          // NOT awaited — this is the pipelining: chunk i+1 starts
          // synthesizing on the next loop iteration while chunk i plays.
          lastPlay = playback.play(content);
        }
        await lastPlay;
        console.debug('[legion-speech] speak: done');
      } finally {
        // Only the call that's still current gets to clear `speaking` — a
        // superseded call's `finally` must not flip it false out from under
        // the call that superseded it.
        if (genRef.current === myGen) setSpeaking(false);
      }
    },
    [client, playback],
  );

  const stop = useCallback(() => {
    // Bump past whatever call is running (its own `finally` will see the
    // mismatch and skip `setSpeaking(false)`, since that guard exists so a
    // SUPERSEDING speak() — not a stop() — doesn't stomp on the new call's
    // `speaking: true`) — so this is the one that actually clears it here.
    genRef.current++;
    playback.stopAndClear();
    setSpeaking(false);
  }, [playback]);

  return { speak, stop, speaking };
}
