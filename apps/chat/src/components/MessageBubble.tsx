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
        {!isUser && message.toolTrace && message.toolTrace.length > 0 && (
          <div className="msg-tool-trace" title="Tool calls the mesh served while producing this reply.">
            {message.toolTrace.map((line, i) => (
              <span key={i} className="msg-tool-chip">
                🔧 {line}
              </span>
            ))}
          </div>
        )}
        {isUser ? (
          <p className="msg-plain">{message.content}</p>
        ) : (
          <StreamingMarkdown text={message.content} className="msg-markdown" />
        )}
        {streaming && <span className="msg-cursor" aria-hidden="true" />}
        {message.reconnected && (
          <div className="msg-reconnected" title="A host went offline mid-reply; the mesh picked up from where it left off on another host.">
            {/* Plain status marker, not a button — this already happened
                (past tense, nothing to retry), and a refresh-style glyph
                here reads as a clickable affordance it isn't. */}
            <span aria-hidden="true">•</span> reconnected via another host
          </div>
        )}
      </div>
    </div>
  );
}
