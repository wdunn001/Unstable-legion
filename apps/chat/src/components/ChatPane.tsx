import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useMeshRoster,
  useTtsSpeaker,
  useVadListen,
  type CallToolFn,
  type UseSpeechHostHandle,
  type UseTtsHostHandle,
} from '@unstable-legion/react';
import { ASR_SKILL, TTS_SKILL } from '@unstable-legion/core';
import { MessageBubble } from './MessageBubble.js';
import { Composer } from './Composer.js';
import { toSpeakableText } from '../speakableText.js';
import { matchWakePhrase } from '../matchWakePhrase.js';
import { VAD_ASSETS } from '../vadAssets.js';
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
  /** Auto-speak preference (increment 2) — when true, the assistant's reply
   * is spoken automatically the instant it finishes streaming (see the
   * streaming→done detection effect below). A CONSUMPTION preference, so
   * it's independent of `ttsHost` (which is about THIS tab hosting TTS for
   * others) — it works off whatever `ttsReachable` resolves to below. */
  autoSpeak: boolean;
  /** 💬 Conversation mode (increment 3c) — hands-free continuous
   * back-and-forth: continuous VAD auto-sends each utterance, the reply is
   * auto-spoken, and talking while it's speaking (barge-in) cuts the TTS
   * short and the resulting utterance becomes the next turn. See the state
   * machine built from `conversationMode`/`busy`/`speaker.speaking` below —
   * it FORCES auto-speak on (see `effectiveAutoSpeak`) rather than
   * duplicating the speak path, and disables Composer's own "🎙 Listen"
   * toggle (see `Composer`'s `conversationMode` prop) since both would
   * otherwise fight over the mic. */
  conversationMode: boolean;
  /** 🔴/🟢 wake-phrase gate on conversation mode (increment 3b) — when true,
   * `handleConversationTranscript` below drops any utterance that doesn't
   * contain `wakePhrase` while "asleep" (see `WAKE_ACTIVE_WINDOW_MS`). Reuses
   * the SAME VAD→Whisper transcript conversation mode already produces — no
   * second ASR/wake-word model, just a phrase match over existing text (see
   * `matchWakePhrase.ts`). No-op when `conversationMode` is off (nothing
   * calls `handleConversationTranscript` in that case). */
  requireWakeWord: boolean;
  /** The phrase to listen for while asleep — normalized (lowercase,
   * punctuation stripped, whitespace collapsed) on both sides before
   * matching, see `matchWakePhrase`. */
  wakePhrase: string;
  callTool: CallToolFn;
}

/** How long a wake (or a sent/replied-to turn) keeps conversation mode
 * "active" — a follow-up utterance inside this window is sent as-is, no
 * need to repeat the wake phrase. Chosen to comfortably cover "listen to
 * the reply, then ask a quick follow-up" without staying open so long it
 * effectively becomes open-mic. */
const WAKE_ACTIVE_WINDOW_MS = 20_000;

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
  // Same resolution, ASR direction — conversation mode's own VAD instance
  // (below) needs this to know whether it's safe to actually turn the mic
  // on, independent of whatever the toggle in ToolContributionPanel says
  // (that toggle is gated on reachability too, but reachability can change
  // out from under an already-on toggle — e.g. the only ASR host peer
  // leaves — and this hook has no way to flip the PERSISTED toggle off
  // itself, so it just stops actually listening instead).
  const asrReachable = props.speechHost.ready || roster.some((r) => r.skills.includes(ASR_SKILL));
  const speaker = useTtsSpeaker({
    callTool: props.callTool,
    synthesizeLocal: props.ttsHost.ready ? props.ttsHost.synthesizeLocal : undefined,
  });
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [speakError, setSpeakError] = useState<string | null>(null);

  // 💬 CONVERSATION MODE (increment 3c) — hands-free back-and-forth. Small
  // state machine, three states, all DERIVED from signals that already
  // exist rather than tracked separately (so there's no separate state to
  // drift out of sync with the real thing):
  //
  //   - GENERATING: `props.busy` (the LLM is streaming a reply). VAD
  //     utterances that resolve while this is true are DROPPED, not
  //     queued — see `handleConversationTranscript` below. This is the
  //     "never send a second message mid-generation" guard.
  //   - SPEAKING: `speaker.speaking` (the finished reply is being read
  //     aloud — via the SAME auto-speak effect increment 2 already built;
  //     see `effectiveAutoSpeak` below, no second speak path). Talking
  //     during this state is a BARGE-IN: `onSpeechStart` fires the instant
  //     VAD detects speech (well before the utterance ends/transcribes) and
  //     immediately calls `speaker.stop()` — see `handleConversationSpeechStart`.
  //   - LISTENING: neither of the above. A resolved utterance here — or one
  //     that resolves AFTER a barge-in has already stopped speaking, since
  //     by the time `onTranscript` fires the state has already moved back
  //     to LISTENING — is auto-sent via `props.onSend`.
  //
  // 🔴/🟢 WAKE-PHRASE GATE (increment 3b) — `lastTurnAtRef` is the timestamp
  // of the most recent "the conversation is still going" event (a sent turn,
  // or a reply finishing — see the auto-speak effect below), NOT React state:
  // it's read/written from event handlers that fire far more often than a
  // render needs to happen, and staying a ref means neither read nor write
  // ever triggers one. `wakeActive` (state) exists ONLY to drive the small
  // visible indicator below — same timestamp, just mirrored into state on a
  // timer so the UI can show it without polling every render.
  const lastTurnAtRef = useRef<number>(0);
  const [wakeActive, setWakeActive] = useState(false);
  const wakeTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const openWakeWindow = () => {
    lastTurnAtRef.current = Date.now();
    setWakeActive(true);
    if (wakeTimeoutRef.current !== undefined) clearTimeout(wakeTimeoutRef.current);
    wakeTimeoutRef.current = setTimeout(() => setWakeActive(false), WAKE_ACTIVE_WINDOW_MS);
  };
  useEffect(() => () => {
    if (wakeTimeoutRef.current !== undefined) clearTimeout(wakeTimeoutRef.current);
  }, []);

  // Both handlers read `props.busy`/`speaker.speaking` fresh from the
  // closure captured at the render that's current when the VAD event
  // actually fires (`useVadListen` re-points its internal callback ref
  // every render — see that hook's doc — so a plain function here, not a
  // `useCallback`, is enough; no stale-closure risk).
  const handleConversationTranscript = (text: string) => {
    if (props.busy) {
      console.debug('[legion-speech] conversation: dropped utterance — assistant is generating');
      return;
    }
    if (!props.requireWakeWord) {
      console.debug('[legion-speech] conversation: auto-send');
      props.onSend(text);
      return;
    }
    // Active window: already "awake" (a recent send or a reply just
    // finished) — treat this utterance as a follow-up, no wake phrase
    // needed, and slide the window forward so the back-and-forth can keep
    // going without re-waking every turn.
    if (Date.now() - lastTurnAtRef.current < WAKE_ACTIVE_WINDOW_MS) {
      console.debug('[legion-speech] conversation: active window — auto-send follow-up');
      openWakeWindow();
      props.onSend(text);
      return;
    }
    // Asleep: only a transcript that CONTAINS the wake phrase (lenient —
    // filler before it, e.g. Whisper prepending "uh", still counts) opens
    // the window. Anything else is not addressed to it — drop it, don't
    // queue it.
    const { woken, command } = matchWakePhrase(text, props.wakePhrase);
    if (!woken) {
      console.debug('[legion-speech] conversation: asleep — dropped (no wake phrase)');
      return;
    }
    openWakeWindow();
    if (command) {
      console.debug('[legion-speech] conversation: woken — auto-send command');
      props.onSend(command);
    } else {
      console.debug('[legion-speech] conversation: woken — waiting for the next utterance');
    }
  };
  const handleConversationSpeechStart = () => {
    if (speaker.speaking) {
      console.debug('[legion-speech] conversation: barge-in — stopping TTS');
      speaker.stop();
    }
  };
  // Conversation mode implies auto-speak — reuse the EXISTING auto-speak
  // effect (below) rather than building a second speak path; forcing this
  // true is the entire integration point.
  const effectiveAutoSpeak = props.autoSpeak || props.conversationMode;
  // Only actually open the mic when conversation mode is on AND there's
  // somewhere to send a transcript — mirrors Composer's own
  // `listenEnabled && asrReachable` gating for the manual "🎙 Listen" toggle.
  const conversationVad = useVadListen({
    enabled: props.conversationMode && asrReachable,
    callTool: props.callTool,
    transcribeLocal: props.speechHost.ready ? props.speechHost.transcribeLocal : undefined,
    onTranscript: handleConversationTranscript,
    onSpeechStart: handleConversationSpeechStart,
    assets: VAD_ASSETS,
    // Both true: this device is about to hear its OWN TTS reply out of the
    // speakers while the mic stays open for the next turn — without this,
    // VAD mistakes the assistant's own voice for the user talking. See
    // `useVadListen.ts`'s module doc, "self-echo prevention" section.
    echoCancellation: true,
    noiseSuppression: true,
  });

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

  // AUTO-SPEAK (increment 2, forced on by 💬 conversation mode — increment
  // 3c's `effectiveAutoSpeak`) — speak the COMPLETED reply the instant
  // `streamingMessageId` transitions away from it, never on mount and never
  // a second time for the same message. `prevStreamingRef` remembers the
  // PREVIOUS render's streaming id; when this render's id differs from it,
  // whatever id was previously streaming just finished (or was aborted).
  // First transition ever has `prev === undefined` (nothing was streaming
  // before), so the very first reply's mount-time render never fires this —
  // only a genuine streaming→settled transition does.
  const prevStreamingRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevStreamingRef.current;
    prevStreamingRef.current = props.streamingMessageId;
    if (!prev || prev === props.streamingMessageId) return;
    // WAKE-GATE (increment 3b): a reply finishing counts as "the
    // conversation is still going" exactly like sending a turn does — see
    // `openWakeWindow`'s doc — so the active window covers the reply PLUS a
    // follow-up gap, not just the moment of sending. Refreshed unconditionally
    // (not just under `effectiveAutoSpeak`) since the window matters whenever
    // conversation mode is on, autoSpeak or not.
    openWakeWindow();
    if (!effectiveAutoSpeak) return;
    if (!ttsReachable) return;
    const finished = props.messages.find((m) => m.id === prev);
    if (!finished || finished.role !== 'assistant') return;
    // Same sanitize-before-speak + code-only fallback as the manual 🔊
    // path (handleSpeak above) — auto-speak must read the same thing a
    // manual click would.
    const speakable =
      toSpeakableText(finished.content) || 'This reply is code only, so there is nothing to read aloud.';
    setSpeakError(null);
    setSpeakingId(finished.id);
    // A reply that finishes while a PREVIOUS auto-spoken (or manually
    // spoken) reply is still talking is safe to just call speak() on —
    // useTtsSpeaker's generation counter supersedes the earlier call and
    // flushes its queued audio (see useTtsSpeaker.ts), no coordination
    // needed here.
    void speaker
      .speak(speakable)
      .catch((err) => {
        setSpeakError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setSpeakingId((cur) => (cur === finished.id ? null : cur));
      });
    // Keyed ONLY on the streaming-id transition — `messages`/`speaker`/
    // `ttsReachable` are read fresh inside but must not themselves
    // re-trigger this effect (that would re-speak on every unrelated
    // message-list update, e.g. tool-trace edits on the SAME id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.streamingMessageId]);

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
      {props.conversationMode && props.requireWakeWord && (
        <div className="chat-notice chat-notice-wake" aria-live="polite">
          <span className="chat-notice-icon" aria-hidden="true">
            {wakeActive ? '🟢' : '🔴'}
          </span>
          <span className="chat-notice-message">
            {wakeActive ? 'conversation active' : `listening for "${props.wakePhrase}"`}
          </span>
        </div>
      )}
      {props.conversationMode && conversationVad.error && (
        <div className="chat-notice chat-notice-error" role="alert" aria-live="polite">
          <span className="chat-notice-icon" aria-hidden="true">
            ⚠
          </span>
          <span className="chat-notice-message">Conversation mode failed: {conversationVad.error}</span>
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
        conversationMode={props.conversationMode}
      />
    </div>
  );
}
