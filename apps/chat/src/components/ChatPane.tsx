import { useEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble.js';
import { Composer } from './Composer.js';
import type { ChatMessage } from '../db/threadStore.js';
import type { CapacityView } from '../viewmodels/meshViewModels.js';

export interface ChatPaneProps {
  messages: readonly ChatMessage[];
  streamingMessageId: string | undefined;
  busy: boolean;
  capacity: CapacityView;
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
      <Composer disabled={disabled} disabledReason={disabledReason} busy={props.busy} onSend={props.onSend} onStop={props.onStop} />
    </div>
  );
}
