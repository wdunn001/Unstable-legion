import { StreamingMarkdown } from '../markdown/StreamingMarkdown.js';
import type { ChatMessage } from '../db/threadStore.js';

export interface MessageBubbleProps {
  message: ChatMessage;
  /** True while THIS message is the one currently streaming. */
  streaming?: boolean;
}

export function MessageBubble(props: MessageBubbleProps) {
  const { message, streaming } = props;
  const isUser = message.role === 'user';

  return (
    <div className={`msg-row ${isUser ? 'msg-row-user' : 'msg-row-assistant'}`}>
      <div className={`msg-bubble ${isUser ? 'msg-bubble-user' : 'msg-bubble-assistant'}`}>
        {isUser ? (
          <p className="msg-plain">{message.content}</p>
        ) : (
          <StreamingMarkdown text={message.content} className="msg-markdown" />
        )}
        {streaming && <span className="msg-cursor" aria-hidden="true" />}
        {message.reconnected && (
          <div className="msg-reconnected" title="A host went offline mid-reply; the mesh picked up from where it left off on another host.">
            <span aria-hidden="true">⟳</span> reconnected via another host
          </div>
        )}
      </div>
    </div>
  );
}
