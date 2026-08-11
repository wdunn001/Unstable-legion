import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useAudioPlayback,
  useMeshRoster,
  useTtsClient,
  type CallToolFn,
  type UseSpeechHostHandle,
  type UseTtsHostHandle,
} from '@unstable-legion/react';
import { TTS_SKILL } from '@unstable-legion/core';
import { MessageBubble } from './MessageBubble.js';
import { Composer } from './Composer.js';
import type { ChatMessage } from '../db/threadStore.js';
import type { CapacityView, ChatNoticeView } from '../viewmodels/meshViewModels.js';

export interface ChatPaneProps {
  messages: readonly ChatMessage[];
  streamingMessageId: string | undefined;
  busy: boolean;
  capacity: CapacityView;
  /** Driver-side failure/reconnect notice — a visible card, never a silent
   * hang (see `deriveChatNotice`). Undefined when there's nothing to say. */
  notice?: ChatNoticeView;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Voice-input wiring for the Composer's mic button — see Composer.tsx. */
  speechHost: UseSpeechHostHandle;
  /** Voice-output wiring for each assistant bubble's speak button — see MessageBubble.tsx. */
  ttsHost: UseTtsHostHandle;
  callTool: CallToolFn;
}

/** Per-message speak state: which message is being synthesized/played,
 * so at most one bubble ever shows an active speak/stop affordance —
 * `useAudioPlayback` itself already enforces "one clip at a time" at the
 * audio layer, this just mirrors that into the UI. */
interface SpeakState {
  messageId: string;
  phase: 'synthesizing' | 'playing';
}

export function ChatPane(props: ChatPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.messages, props.streamingMessageId]);

  const disabled = !props.capacity.ready;
  const disabledReason = disabled ? props.capacity.gapMessage : undefined;

  // Voice output: reachable if THIS tab hosts TTS, or some roster peer
  // advertises `tts.synthesize` — same resolution order `useTtsClient`
  // itself uses, checked here just to decide whether speak buttons are
  // clickable at all (mirrors Composer.tsx's `asrReachable`).
  const { ttsHost } = props;
  const roster = useMeshRoster();
  const ttsReachable = ttsHost.ready || roster.some((r) => r.skills.includes(TTS_SKILL));

  const ttsClient = useTtsClient({
    callTool: props.callTool,
    synthesizeLocal: ttsHost.ready ? ttsHost.synthesizeLocal : undefined,
  });
  const audioPlayback = useAudioPlayback();
  const [speak, setSpeak] = useState<SpeakState | null>(null);
  const [speakError, setSpeakError] = useState<{ messageId: string; message: string } | null>(null);

  // Natural end of playback (or an external stop()) clears the "playing"
  // bubble's state — synthesizing → playing → (this effect) → idle.
  useEffect(() => {
    if (!audioPlayback.playing) {
      setSpeak((prev) => (prev?.phase === 'playing' ? null : prev));
    }
  }, [audioPlayback.playing]);

  const handleSpeak = useCallback(
    (message: ChatMessage) => {
      setSpeakError(null);
      setSpeak({ messageId: message.id, phase: 'synthesizing' });
      void ttsClient
        .synthesize(message.content)
        .then((content) => {
          setSpeak({ messageId: message.id, phase: 'playing' });
          return audioPlayback.play(content);
        })
        .catch((err) => {
          setSpeakError({ messageId: message.id, message: err instanceof Error ? err.message : String(err) });
          setSpeak(null);
        });
    },
    [ttsClient, audioPlayback],
  );

  const handleStopSpeak = useCallback(() => {
    audioPlayback.stop();
    setSpeak(null);
  }, [audioPlayback]);

  return (
    <div className="chat-pane">
      <div className="chat-scroll" ref={scrollRef}>
        {props.messages.length === 0 ? (
          <div className="chat-empty">
            {props.capacity.ready ? (
              <p>Say something — your message will be split across the mesh and streamed back.</p>
            ) : (
              <p className="chat-empty-gap">{props.capacity.gapMessage}</p>
            )}
          </div>
        ) : (
          props.messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              streaming={m.id === props.streamingMessageId}
              tts={{
                reachable: ttsReachable,
                synthesizing: speak?.messageId === m.id && speak.phase === 'synthesizing',
                speaking: speak?.messageId === m.id && speak.phase === 'playing',
                error: speakError?.messageId === m.id ? speakError.message : null,
                onSpeak: () => handleSpeak(m),
                onStop: handleStopSpeak,
              }}
            />
          ))
        )}
      </div>
      {props.notice && (
        <div
          className={`chat-notice ${props.notice.kind === 'retrying' ? 'chat-notice-retrying' : 'chat-notice-error'}`}
          role="alert"
          aria-live="polite"
        >
          {/* Status glyphs only — neither is a button (no onClick lives
              here). '↻'/'⟳'-style refresh glyphs read as clickable
              "retry" affordances to users who then click them and nothing
              happens; '⏳'/'⚠' don't carry that same clickable connotation
              while still distinguishing "automatically retrying" from
              "failed". */}
          <span className="chat-notice-icon" aria-hidden="true">
            {props.notice.kind === 'retrying' ? '⏳' : '⚠'}
          </span>
          <span className="chat-notice-message">{props.notice.message}</span>
        </div>
      )}
      <Composer
        disabled={disabled}
        disabledReason={disabledReason}
        busy={props.busy}
        onSend={props.onSend}
        onStop={props.onStop}
        speechHost={props.speechHost}
        callTool={props.callTool}
      />
    </div>
  );
}
