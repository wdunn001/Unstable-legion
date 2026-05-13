/**
 * useAudioKeepalive — keep a browser tab unthrottled by playing silent
 * audio on loop.
 *
 * Background: when a tab is hidden, Chromium throttles main-thread JS
 * (setTimeout/setInterval down to ~1/min, intensive throttling on
 * sustained background). DedicatedWorker inherits the throttle of its
 * parent tab. A reliable platform-level escape hatch is that *tabs
 * playing audio are never throttled* — the audio pipeline keeps the
 * page in the active state.
 *
 * This hook wraps that trick: a hidden `<audio>` element plays a
 * tiny silent WAV on loop while the keepalive is enabled, defeating
 * tab-throttling for the whole tab including any workers it owns.
 *
 * Autoplay rules: browsers require a user gesture to start playback
 * for the first time. The hook flips an internal "playing" flag on
 * the first user interaction; the consumer typically wires the
 * toggle to a button click which counts as a gesture.
 *
 * Tradeoffs:
 * - The OS-level "tab is playing audio" indicator (the speaker icon
 *   in the tab bar) lights up. Some users will notice. Worth telling
 *   them why.
 * - Volume is `0` and the WAV is pure silence so no actual audio
 *   reaches the speakers. Some users disable autoplay for the site;
 *   the toggle button is then a no-op.
 * - This is a workaround for browser tab-throttling; the cleaner
 *   architectural fix is to move long-running state into a worker,
 *   but workers themselves are throttled too when the parent tab is
 *   backgrounded.
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
