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
        {!isUser && message.tokPerSec !== undefined && (
          <div
            className="msg-tokrate"
            title="Decode throughput for this reply — tokens generated per second across the mesh pipeline (first token to last)."
          >
            <span aria-hidden="true">⚡</span> {formatTokPerSec(message.tokPerSec)} tok/s
          </div>
        )}
      </div>
    </div>
  );
}

/** One decimal below 10 tok/s (where the difference reads), whole numbers
 * above — a browser-mesh split route runs single-digit tok/s, so the
 * fractional digit is the informative part of the metric here. */
function formatTokPerSec(v: number): string {
  return v < 10 ? v.toFixed(1) : Math.round(v).toString();
}
