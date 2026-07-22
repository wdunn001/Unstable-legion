import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  useMeshRoster,
  useMicCapture,
  useSpeechClient,
  useVadListen,
  type CallToolFn,
  type MicClip,
  type UseSpeechHostHandle,
} from '@unstable-legion/react';
import { ASR_SKILL } from '@unstable-legion/core';

// Self-hosted `@ricky0123/vad-web` assets — see useVadListen.ts's module
// doc for why these are a fixed local `/vad/` directory rather than
// per-file `?url` imports (the library concatenates a shared
// `baseAssetPath`/`onnxWASMBasePath` directory + fixed filenames
// internally, so per-asset hashed URLs can't be threaded through it).
// Populated at dev/build time by the `copyVadAssets` plugin in
// `vite.config.ts`.
const VAD_ASSETS = { baseAssetPath: '/vad/', onnxWASMBasePath: '/vad/' };

export interface ComposerProps {
  disabled: boolean;
  disabledReason?: string;
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Voice-input wiring — mic → ASR → dropped into the textarea. Local-first
   * (`speechHost.ready`), else routed to a roster peer advertising
   * `asr.transcribe` via `callTool` (see `useSpeechClient`). */
  speechHost: UseSpeechHostHandle;
  callTool: CallToolFn;
}

export function Composer(props: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { speechHost } = props;

  // Voice input: reachable if THIS tab hosts ASR, or some roster peer
  // advertises `asr.transcribe` — same resolution order `useSpeechClient`
  // itself uses, checked here just to decide whether the mic button is
  // clickable at all.
  const roster = useMeshRoster();
  const asrReachable = speechHost.ready || roster.some((r) => r.skills.includes(ASR_SKILL));

  const mic = useMicCapture({ maxMs: 30_000 });
  const client = useSpeechClient({
    callTool: props.callTool,
    transcribeLocal: speechHost.ready ? speechHost.transcribeLocal : undefined,
  });
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);

  // A fresh clip (not the one already transcribed) triggers the
  // transcribe → drop-into-textarea flow. Keyed off object identity — each
  // `mic.stop()` produces a brand-new `MicClip`.
  const handledClipRef = useRef<MicClip | null>(null);
  useEffect(() => {
    const clip = mic.lastClip;
    if (!clip || clip === handledClipRef.current) return;
    handledClipRef.current = clip;
    setTranscribing(true);
    setTranscribeError(null);
    void client
      .transcribe(clip)
      .then((result) => {
        const el = ref.current;
        if (!el) return;
        const existing = el.value.trim();
        el.value = existing ? `${existing} ${result.text}` : result.text;
        el.style.height = 'auto';
        el.style.height = `${Math.min(200, el.scrollHeight)}px`;
        el.focus();
      })
      .catch((err) => {
        setTranscribeError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setTranscribing(false));
  }, [mic.lastClip, client]);

  // "🎙 Listen" — continuous, hands-free VAD open mic (increment 3a of the
  // voice-conversation layer). Independent of push-to-talk above: it owns
  // its own continuous mic stream while toggled on, segments speech
  // locally via Silero VAD, and appends each utterance's transcript into
  // the composer as it arrives. No auto-send here — that's increment 3c.
  const [listenEnabled, setListenEnabled] = useState(false);
  const handleTranscript = (text: string) => {
    const el = ref.current;
    if (!el) return;
    const existing = el.value.trim();
    el.value = existing ? `${existing} ${text}` : text;
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
    el.focus();
  };
  const vad = useVadListen({
    enabled: listenEnabled,
    callTool: props.callTool,
    transcribeLocal: speechHost.ready ? speechHost.transcribeLocal : undefined,
    onTranscript: handleTranscript,
    assets: VAD_ASSETS,
  });

  // If the ASR target disappears mid-listen (host toggled off, mesh peer
  // left) turn Listen back off instead of leaving it stuck spinning with a
  // continuous mic stream open and no way to serve a transcript.
  useEffect(() => {
    if (listenEnabled && !asrReachable) setListenEnabled(false);
  }, [asrReachable, listenEnabled]);

  function send() {
    const el = ref.current;
    if (!el) return;
    const text = el.value.trim();
    if (!text) return;
    props.onSend(text);
    el.value = '';
    el.style.height = 'auto';
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!props.disabled && !props.busy) send();
    }
  }

  function autoGrow() {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  }

  function handleMicClick() {
    if (mic.recording) mic.stop();
    else mic.start();
  }

  function handleListenClick() {
    setListenEnabled((cur) => !cur);
  }

  const micDisabled = props.disabled || !asrReachable || transcribing;
  const micTitle = !asrReachable
    ? 'Enable Host speech-to-text, or wait for a peer that offers it'
    : mic.recording
      ? 'Stop recording'
      : 'Speak your message';

  const listenDisabled = props.disabled || !asrReachable;
  const listenTitle = !asrReachable
    ? 'Enable Host speech-to-text, or wait for a peer that offers it'
    : listenEnabled
      ? 'Stop hands-free listening'
      : 'Start hands-free listening — speech is transcribed into the composer as you talk';

  return (
    <div className="composer">
      {props.disabled && props.disabledReason && <div className="composer-disabled-reason">{props.disabledReason}</div>}
      {mic.error && <div className="composer-mic-error">Mic error: {mic.error}</div>}
      {transcribeError && <div className="composer-mic-error">Transcription failed: {transcribeError}</div>}
      {vad.error && <div className="composer-listen-error">Listen failed: {vad.error}</div>}
      <div className="composer-row">
        <button
          type="button"
          className={`btn btn-secondary composer-mic ${mic.recording ? 'composer-mic-recording' : ''}`}
          disabled={micDisabled}
          title={micTitle}
          aria-pressed={mic.recording}
          onClick={handleMicClick}
        >
          {transcribing ? 'transcribing…' : mic.recording ? '● recording…' : '🎤'}
        </button>
        <button
          type="button"
          className={`btn btn-secondary composer-listen ${vad.listening ? 'composer-listen-active' : ''}`}
          disabled={listenDisabled}
          title={listenTitle}
          aria-pressed={listenEnabled}
          onClick={handleListenClick}
        >
          {vad.listening ? '📡 listening…' : '🎙 Listen'}
        </button>
        <textarea
          ref={ref}
          className="composer-input"
          placeholder={props.disabled ? 'Chat is unavailable right now…' : 'Message the mesh…'}
          disabled={props.disabled}
          onKeyDown={handleKeyDown}
          onInput={autoGrow}
          rows={1}
        />
        {props.busy ? (
          <button type="button" className="btn btn-stop composer-stop" onClick={props.onStop}>
            Stop
          </button>
        ) : (
          <button type="button" className="btn btn-primary composer-send" disabled={props.disabled} onClick={send}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
