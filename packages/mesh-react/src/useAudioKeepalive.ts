/**
 * useAudioKeepalive — *deprecated workaround* for tab-throttling.
 *
 * **Does not reliably work on modern browsers (2025+).** Chrome and
 * Firefox added heuristics that detect zero-amplitude / near-silent
 * audio and throttle those tabs anyway. The historical "play a silent
 * WAV to keep the tab alive" trick is largely defeated. Still ships
 * here for completeness, in case a future browser version regresses
 * the detection or you want to swap in your own non-silent stream.
 *
 * The actual fix is moving long-running state (mesh peer, LLM engine,
 * heartbeat) into a DedicatedWorker — see `createWorkerMeshPeer` /
 * `apps/demo/src/workers/meshWorker.ts`. The worker still gets
 * throttled when the tab is hidden, but inbound network events
 * (WebRTC data channel messages, MQTT websocket frames) fire in real
 * time on the main thread and dispatch into the worker via
 * postMessage; WebGPU compute also keeps making forward progress
 * because GPU dispatch is async. End result: an /ai request that
 * lands on a hidden tab still completes.
 *
 * Autoplay rules: browsers require a user gesture to start playback
 * for the first time. The hook flips an internal "playing" flag on
 * first user interaction; the consumer typically wires the toggle to
 * a button click which counts as a gesture.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 12-byte silent WAV header + minimal PCM data. Loops indefinitely
 * without bandwidth or memory pressure. Data URI keeps it inline so
 * there's no extra HTTP request.
 */
const SILENT_WAV_DATA_URI =
  'data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAVFYAAFRWAAABAAgAZGF0YQgAAACAgICAgIA=';

const STORAGE_KEY = 'unstable-legion:audio-keepalive';

export interface AudioKeepaliveHandle {
  /** Is the silent audio currently playing? */
  enabled: boolean;
  /**
   * Toggle the keepalive on/off. Must be invoked from a user gesture
   * the first time (button click) so autoplay rules are satisfied.
   */
  toggle: () => Promise<void>;
  /** Force-enable (won't help without a gesture if autoplay is blocked). */
  enable: () => Promise<void>;
  /** Force-disable. */
  disable: () => void;
  /**
   * If a previous attempt to enable was blocked by autoplay policy or
   * other error, this carries the reason; null otherwise.
   */
  lastError: string | null;
}

export function useAudioKeepalive(): AudioKeepaliveHandle {
  const [enabled, setEnabled] = useState<boolean>(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Lazy-create the audio element on first toggle so we don't pollute
  // the DOM for users who never enable the keepalive.
  const ensureAudio = useCallback((): HTMLAudioElement => {
    if (audioRef.current) return audioRef.current;
    const el = new Audio(SILENT_WAV_DATA_URI);
    el.loop = true;
    el.volume = 0;
    audioRef.current = el;
    return el;
  }, []);

  const enable = useCallback(async (): Promise<void> => {
    const el = ensureAudio();
    try {
      await el.play();
      setEnabled(true);
      setLastError(null);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, '1');
      }
    } catch (err) {
      setEnabled(false);
      setLastError(err instanceof Error ? err.message : String(err));
    }
  }, [ensureAudio]);

  const disable = useCallback((): void => {
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
    setEnabled(false);
    setLastError(null);
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const toggle = useCallback(async (): Promise<void> => {
    if (enabled) {
      disable();
    } else {
      await enable();
    }
  }, [enabled, enable, disable]);

  // Restore prior state on mount — but the call to `enable()` may be
  // rejected without a user gesture; that's fine, the toggle will
  // show as off and the user can re-enable.
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    const want = localStorage.getItem(STORAGE_KEY) === '1';
    if (want) {
      void enable();
    }
  }, [enable]);

  // Stop on unmount so the tab can be reclaimed cleanly.
  useEffect(() => {
    return () => {
      const el = audioRef.current;
      if (el) {
        el.pause();
        audioRef.current = null;
      }
    };
  }, []);

  return { enabled, toggle, enable, disable, lastError };
}
