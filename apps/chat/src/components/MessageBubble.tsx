import { StreamingMarkdown } from '../markdown/StreamingMarkdown.js';
import type { ChatMessage } from '../db/threadStore.js';

/** Per-bubble speak-button wiring — computed by `ChatPane` (which owns the
 * single shared `useTtsClient`/`useAudioPlayback` instances; see that
 * file's `SpeakState` doc). Presentation only here. */
export interface MessageBubbleTtsProps {
  /** True if this tab hosts TTS, or a roster peer advertises `tts.synthesize`. */
  reachable: boolean;
  /** True while THIS message's clip is being synthesized (not yet playing). */
  synthesizing: boolean;
  /** True while THIS message's clip is actively playing. */
  speaking: boolean;
  error: string | null;
  onSpeak: () => void;
  onStop: () => void;
}

export interface MessageBubbleProps {
  message: ChatMessage;
  /** True while THIS message is the one currently streaming. */
  streaming?: boolean;
  /** Omitted for user messages — speak is assistant-reply-only. */
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
        {!isUser && tts && !streaming && message.content && (
          <SpeakButton tts={tts} />
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

/** 🔊 speak button — synthesizes + plays this bubble's text. Three states
 * (idle → synthesizing → speaking), the last two collapsing into one
 * "stop" affordance so there's always exactly one thing to click.
 * Disabled + tooltip when no TTS host/peer is reachable, same
 * disabled-reachability idiom as Composer.tsx's mic button. */
function SpeakButton(props: { tts: MessageBubbleTtsProps }) {
  const { tts } = props;
  const active = tts.synthesizing || tts.speaking;
  const title = !tts.reachable
    ? 'Enable Host text-to-speech, or wait for a peer that offers it'
    : tts.synthesizing
      ? 'Synthesizing…'
      : tts.speaking
        ? 'Stop speaking'
        : 'Speak this reply';

  return (
    <div className="msg-speak">
      <button
        type="button"
        className={`msg-speak-btn ${tts.speaking ? 'msg-speak-btn-active' : ''}`}
        disabled={!tts.reachable && !active}
        title={title}
        aria-pressed={tts.speaking}
        onClick={active ? tts.onStop : tts.onSpeak}
      >
        {tts.synthesizing ? 'synthesizing…' : tts.speaking ? '⏹ stop' : '🔊'}
      </button>
      {tts.error && <span className="msg-speak-error">{tts.error}</span>}
    </div>
  );
}
