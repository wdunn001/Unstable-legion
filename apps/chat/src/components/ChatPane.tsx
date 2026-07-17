import { useEffect, useRef } from 'react';
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
}

export function ChatPane(props: ChatPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.messages, props.streamingMessageId]);

  const disabled = !props.capacity.ready;
  const disabledReason = disabled ? props.capacity.gapMessage : undefined;

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
          props.messages.map((m) => <MessageBubble key={m.id} message={m} streaming={m.id === props.streamingMessageId} />)
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
      <Composer disabled={disabled} disabledReason={disabledReason} busy={props.busy} onSend={props.onSend} onStop={props.onStop} />
    </div>
  );
}
