import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useMeshRoster,
  useTtsSpeaker,
  type CallToolFn,
  type UseSpeechHostHandle,
  type UseTtsHostHandle,
} from '@unstable-legion/react';
import { TTS_SKILL } from '@unstable-legion/core';
import { MessageBubble } from './MessageBubble.js';
import { Composer } from './Composer.js';
import { toSpeakableText } from '../speakableText.js';
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
  /** Voice-OUTPUT wiring for each assistant bubble's 🔊 button — see
   * MessageBubble.tsx. `useTtsSpeaker` is instantiated ONCE here (not
   * per-bubble) so every message in the pane shares one `AudioContext`,
   * one gapless playback queue, and resolves the same local-vs-mesh
   * target, mirroring Composer's single `useSpeechClient` instance for
   * the mic button. */
  ttsHost: UseTtsHostHandle;
  callTool: CallToolFn;
}

export function ChatPane(props: ChatPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.messages, props.streamingMessageId]);

  const disabled = !props.capacity.ready;
  const disabledReason = disabled ? props.capacity.gapMessage : undefined;

  // Reachable if THIS tab hosts TTS, or some roster peer advertises
  // `tts.synthesize` — same resolution order `useTtsClient` itself uses,
  // checked here just to decide whether any speak button is clickable.
  const roster = useMeshRoster();
  const ttsReachable = props.ttsHost.ready || roster.some((r) => r.skills.includes(TTS_SKILL));
  const speaker = useTtsSpeaker({
    callTool: props.callTool,
    synthesizeLocal: props.ttsHost.ready ? props.ttsHost.synthesizeLocal : undefined,
  });
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [speakError, setSpeakError] = useState<string | null>(null);

  const handleSpeak = useCallback(
    (id: string, text: string) => {
      // Clicking 🔊 on the message currently speaking is a toggle: stop it.
      if (speakingId === id) {
        speaker.stop();
        setSpeakingId(null);
        return;
      }
      setSpeakError(null);
      setSpeakingId(id);
      // Read the explanation, not the markup: strip code blocks, markdown,
      // URLs, and any <think> block before synthesizing. Fall back to a
      // short spoken note when a reply is code-only (nothing to read).
      const speakable =
        toSpeakableText(text) || 'This reply is code only, so there is nothing to read aloud.';
      void speaker
        .speak(speakable)
        .catch((err) => {
          setSpeakError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          setSpeakingId((cur) => (cur === id ? null : cur));
        });
    },
    [speaker, speakingId],
  );

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
              tts={
                m.role === 'user'
                  ? undefined
                  : {
                      reachable: ttsReachable,
                      speaking: speakingId === m.id,
                      onSpeak: () => handleSpeak(m.id, m.content),
                    }
              }
            />
          ))
        )}
      </div>
      {speakError && (
        <div className="chat-notice chat-notice-error" role="alert" aria-live="polite">
          <span className="chat-notice-icon" aria-hidden="true">
            ⚠
          </span>
          <span className="chat-notice-message">Speak failed: {speakError}</span>
        </div>
      )}
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
