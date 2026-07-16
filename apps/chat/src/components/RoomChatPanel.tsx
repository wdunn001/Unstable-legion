/**
 * RoomChatPanel — the user-to-user room chat surface, a DISTINCT product
 * surface from the AI assistant pane (`ChatPane`). Where `ChatPane` streams
 * a model's reply split across the mesh, this is humans talking to humans:
 * peers in the room exchange short text messages over the mesh's `uc`
 * action, dict-deflate compressed and standing-rate-limited (all in
 * `useUserChat`). Plain text only — no Markdown, no command parsing — kept
 * deliberately simple and safe (React escapes text nodes; the outbound
 * safety prefilter runs in the hook before anything leaves the tab).
 *
 * Visually consistent with the Legion identity: same monospace, mint
 * accent, hairline panels, chip badges — all from the shared `ul-*` /
 * app-level CSS tokens in styles.css, light + dark.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { MeshRosterEntry, UserChatMessage } from '@unstable-legion/core';
import type { UserChatSendResult, UserChatWireStats } from '@unstable-legion/react';

export interface RoomChatPanelProps {
  messages: readonly UserChatMessage[];
  stats: UserChatWireStats;
  roster: readonly MeshRosterEntry[];
  selfId: string;
  onSend: (text: string) => Promise<UserChatSendResult>;
}

function shortId(id: string): string {
  return id.length > 6 ? id.slice(0, 6) : id;
}

export function RoomChatPanel(props: RoomChatPanelProps) {
  const { messages, stats, roster, selfId } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function doSend() {
    const el = inputRef.current;
    if (!el) return;
    const text = el.value;
    if (!text.trim()) return;
    const result = await props.onSend(text);
    switch (result.kind) {
      case 'sent':
        el.value = '';
        el.style.height = 'auto';
        setNotice(null);
        break;
      case 'throttled':
        setNotice(`You're sending too fast — slow down for ${Math.ceil(result.retryAfterMs / 1000)}s.`);
        break;
      case 'blocked':
        setNotice(`Message held back by the safety filter (${result.categories.join(', ')}).`);
        break;
      case 'empty':
        break;
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void doSend();
    }
  }

  const savedPct = stats.rawBytesSent > 0 ? Math.round((1 - stats.ratio) * 100) : 0;
  const droppedTotal = stats.droppedFlood + stats.droppedDup + stats.droppedDecode;

  return (
    <div className="room-chat" data-testid="room-chat">
      <div className="room-chat-main">
        <div className="room-chat-scroll" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="room-chat-empty">
              <p>No room messages yet. This is a direct people-to-people channel — separate from the AI assistant.</p>
              <p className="room-chat-empty-sub">Messages are Codec-compressed on the wire and rate-limited to keep the room civil.</p>
            </div>
          ) : (
            messages.map((m) => {
              const mine = m.from === selfId;
              return (
                <div key={`${m.from}:${m.id}`} className={`room-msg ${mine ? 'room-msg-mine' : ''}`}>
                  <span className="room-msg-nick" title={m.from}>
                    {m.nick || shortId(m.from)}
                    {mine && <span className="room-msg-you"> (you)</span>}
                  </span>
                  <span className="room-msg-text">{m.text}</span>
                  {m.safety?.category && <span className="room-msg-badge">{m.safety.category}</span>}
                </div>
              );
            })
          )}
        </div>
        {notice && <div className="room-chat-notice" role="status">{notice}</div>}
        <div className="room-composer">
          <textarea
            ref={inputRef}
            className="room-composer-input"
            placeholder="Message the room…"
            rows={1}
            onKeyDown={handleKeyDown}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${Math.min(160, el.scrollHeight)}px`;
            }}
          />
          <button type="button" className="btn btn-primary room-composer-send" onClick={() => void doSend()}>
            Send
          </button>
        </div>
        <div className="room-chat-statusbar">
          <span className="room-stat-chip" data-testid="room-compression" title="On-wire vs raw bytes for messages you've sent (dict-deflate).">
            wire {savedPct >= 0 ? `−${savedPct}%` : `+${-savedPct}%`} · {stats.wireBytesSent}/{stats.rawBytesSent}B
          </span>
          {droppedTotal > 0 && (
            <span className="room-stat-chip room-stat-warn" data-testid="room-dropped" title="Inbound frames dropped: flood / duplicate / undecodable.">
              dropped {droppedTotal} ({stats.droppedFlood}f/{stats.droppedDup}d/{stats.droppedDecode}x)
            </span>
          )}
        </div>
      </div>
      <aside className="room-people">
        <h4 className="room-people-title">People · {roster.length}</h4>
        <ul className="room-people-list">
          {roster.map((r) => (
            <li key={r.peerId} className={`room-person ${r.peerId === selfId ? 'room-person-self' : ''}`} title={r.peerId}>
              <span className="room-person-dot" aria-hidden="true" />
              <span className="room-person-nick">{r.nick || shortId(r.peerId)}</span>
              {r.peerId === selfId && <span className="room-person-you">you</span>}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
