/**
 * useMicCapture — record a short mic clip via `getUserMedia` +
 * `MediaRecorder`. Ported (cleanly reimplemented, not copied) from the
 * `toggleMic()` pattern in H:\dev\wayfinder\web\app.js: request the mic,
 * record into a `MediaRecorder`, auto-stop after `maxMs` (default 6s),
 * hand back the encoded blob bytes + mime type for the caller to feed
 * into ASR.
 *
 * Feature-detects the best-supported mime type via
 * `MediaRecorder.isTypeSupported` (Safari doesn't support `audio/webm`;
 * falls back to whatever the browser offers) instead of hardcoding
 * `audio/webm`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const CANDIDATE_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm';
  for (const candidate of CANDIDATE_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

export interface MicClip {
  bytes: ArrayBuffer;
  mimeType: string;
}

export interface UseMicCaptureOptions {
  /** Auto-stop recording after this many ms. Default 6000. */
  maxMs?: number;
}

export interface UseMicCaptureHandle {
  recording: boolean;
  error: string | null;
  start: () => void;
  stop: () => void;
  lastClip: MicClip | null;
}

export function useMicCapture(opts: UseMicCaptureOptions = {}): UseMicCaptureHandle {
  const maxMs = opts.maxMs ?? 6000;
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastClip, setLastClip] = useState<MicClip | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cleanupStream = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    } else {
      cleanupStream();
      setRecording(false);
    }
  }, [cleanupStream]);

  const start = useCallback(() => {
    if (recording) return;
    setError(null);
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        const mimeType = pickMimeType();
        const recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
        recorderRef.current = recorder;
        chunksRef.current = [];

        recorder.ondataavailable = (ev: BlobEvent) => {
          if (ev.data.size > 0) chunksRef.current.push(ev.data);
        };
        recorder.onstop = () => {
          void (async () => {
            const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' });
            const bytes = await blob.arrayBuffer();
            setLastClip({ bytes, mimeType: blob.type || mimeType || 'audio/webm' });
            cleanupStream();
            setRecording(false);
          })();
        };

        recorder.start();
        setRecording(true);
        timerRef.current = setTimeout(() => stop(), maxMs);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        cleanupStream();
        setRecording(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, maxMs, cleanupStream]);

  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
      }
      cleanupStream();
    };
  }, [cleanupStream]);

  return { recording, error, start, stop, lastClip };
}
