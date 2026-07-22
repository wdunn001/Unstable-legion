import { StreamingMarkdown } from '../markdown/StreamingMarkdown.js';
import type { ChatMessage } from '../db/threadStore.js';

/**
 * TTS "speak" affordance for an assistant bubble. Purely presentational —
 * `ChatPane` owns the actual `useTtsSpeaker` hook (ONE instance shared
 * across every bubble in the pane, not one per message; see
 * `ChatPane.tsx`'s module doc) and passes down just enough state + a
 * callback for this bubble to render a button.
 */
export interface MessageBubbleTtsProps {
  /** This tab hosts TTS itself, or a roster peer advertises `tts.synthesize`. */
  reachable: boolean;
  /** True while THIS message's audio is synthesizing/playing — clicking 🔊 again while true STOPS it (toggle). */
  speaking: boolean;
  onSpeak: () => void;
}

export interface MessageBubbleProps {
  message: ChatMessage;
  /** True while THIS message is the one currently streaming. */
  streaming?: boolean;
  /** Omitted for user messages — only assistant replies are speakable. */
  tts?: MessageBubbleTtsProps;
}

export function MessageBubble(props: MessageBubbleProps) {
  const { message, streaming, tts } = props;
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
        {!isUser && tts && !streaming && (
          <button
            type="button"
            className={`btn-link msg-speak ${tts.speaking ? 'msg-speak-active' : ''}`}
            disabled={!tts.reachable}
            title={
              !tts.reachable
                ? "Enable Host text-to-speech, or wait for a peer that offers it"
                : tts.speaking
                  ? 'Stop speaking'
                  : 'Speak this reply aloud'
            }
            onClick={tts.onSpeak}
          >
            {tts.speaking ? '⏹' : '🔊'}
          </button>
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
