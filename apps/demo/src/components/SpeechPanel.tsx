/**
 * SpeechPanel — PoC demo UI for the speech mesh capability
 * (`@unstable-legion/core`'s `speech.ts`: `asr.transcribe`).
 *
 * Three pieces composed here:
 *   1. "enable ASR host" toggle — flips `props.enabled` (owned by
 *      `App.tsx` so its readiness feeds the top-level `cap` computation,
 *      see that file's comment on why this isn't a local `peer.setCap`
 *      call like `CommunalHostPanel`/`StagePipelinePanel` use).
 *   2. `useMicCapture` — record/stop a short clip.
 *   3. `useSpeechClient` — transcribe the clip, locally if this peer's
 *      host is ready, else via a roster peer advertising `asr.transcribe`.
 *
 * Deliberately separate from the LLM chat panels — this panel's only
 * job is proving the mic → ASR → transcript path, local or meshed.
 */
import { useMemo, useState } from 'react';
import {
  useMicCapture,
  useSpeechClient,
  type CallToolFn,
  type UseSpeechHostHandle,
} from '@unstable-legion/react';

export interface SpeechPanelProps {
  speechHost: UseSpeechHostHandle;
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  callTool: CallToolFn;
}

export function SpeechPanel(props: SpeechPanelProps) {
  const { speechHost } = props;
  const mic = useMicCapture({ maxMs: 6000 });
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [lastVia, setLastVia] = useState<'local' | string | null>(null);
  const [lastTiming, setLastTiming] = useState<{ durationMs?: number; engine: string } | null>(null);

  const client = useSpeechClient({
    callTool: props.callTool,
    transcribeLocal: speechHost.ready ? speechHost.transcribeLocal : undefined,
  });

  const canTranscribe = useMemo(() => mic.lastClip !== null && !mic.recording && !busy, [mic.lastClip, mic.recording, busy]);

  const handleTranscribe = async () => {
    if (!mic.lastClip) return;
    setBusy(true);
    setLastError(null);
    try {
      const result = await client.transcribe(mic.lastClip);
      setTranscript(result.text);
      setLastVia(result.via);
      setLastTiming({ durationMs: result.durationMs, engine: result.engine });
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sp-panel">
      <h3>
        speech (ASR) <span className="sp-model">asr.transcribe — Whisper via transformers.js</span>
      </h3>
      <div className="sp-host-row">
        <label className="sp-host-toggle">
          <input
            type="checkbox"
            checked={props.enabled}
            onChange={(e) => props.onToggleEnabled(e.target.checked)}
          />
          enable ASR host
        </label>
        {props.enabled && !speechHost.ready && !speechHost.error && (
          <span className="ul-muted sp-small">initializing (downloading model on first use)…</span>
        )}
        {speechHost.ready && speechHost.descriptor && (
          <span className="sp-badge">hosting {speechHost.skill}</span>
        )}
        {speechHost.error && <span className="sp-err">{speechHost.error}</span>}
      </div>
      <div className="sp-run-row">
        <button onClick={() => mic.start()} disabled={mic.recording}>
          {mic.recording ? 'recording…' : 'record'}
        </button>
        <button onClick={() => mic.stop()} disabled={!mic.recording}>
          stop
        </button>
        <button onClick={() => void handleTranscribe()} disabled={!canTranscribe}>
          {busy ? 'transcribing…' : 'transcribe'}
        </button>
        {mic.lastClip && (
          <span className="ul-muted sp-small">
            clip ready ({mic.lastClip.mimeType}, {Math.round(mic.lastClip.bytes.byteLength / 1024)} KB)
          </span>
        )}
      </div>
      {mic.error && <div className="sp-err">mic error: {mic.error}</div>}
      {lastError && <div className="sp-err">{lastError}</div>}
      <div className="sp-status-row">
        {lastVia && (
          <span className="sp-badge">
            {lastVia === 'local' ? 'ran locally' : `via peer ${lastVia.slice(0, 10)}…`}
          </span>
        )}
        {lastTiming && (
          <span className="ul-muted sp-small">
            engine: {lastTiming.engine}
            {lastTiming.durationMs !== undefined ? ` · ${lastTiming.durationMs}ms` : ''}
          </span>
        )}
      </div>
      {transcript !== null && <pre className="sp-output">{transcript || '(empty transcript)'}</pre>}
    </section>
  );
}
