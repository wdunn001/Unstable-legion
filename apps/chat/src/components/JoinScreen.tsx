import { useState, type FormEvent } from 'react';
import { TrustBadge } from './TrustBadge.js';

export interface JoinScreenProps {
  initialNick: string;
  onJoin: (nick: string) => void;
}

/** The chat app's own lightweight join screen — deliberately NOT
 * mesh-react's `PersonaForm` (a full operator-persona editor with a
 * model picker, tool opt-ins, and MCP endpoints). This product has one
 * fixed model and no legacy tool-calling surface — asking for a nick is
 * the entire "sign-up". */
export function JoinScreen(props: JoinScreenProps) {
  const [nick, setNick] = useState(props.initialNick);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = nick.trim();
    if (!trimmed) return;
    props.onJoin(trimmed);
  }

  return (
    <div className="join-screen">
      <div className="join-card">
        <h1 className="join-title">Unstable Legion</h1>
        <p className="join-tagline">A chat app where opening it makes you part of the model.</p>
        <p className="join-body">
          There's no server running Qwen3-8B somewhere — the people in this room are. Every open tab is a peer;
          contributors keep it fast for everyone, and nobody is ever cut off.
        </p>
        <form onSubmit={handleSubmit} className="join-form">
          <label htmlFor="chat-nick">What should we call you?</label>
          <input
            id="chat-nick"
            className="join-nick-input"
            value={nick}
            onChange={(e) => setNick(e.target.value)}
            placeholder="your name"
            autoFocus
            maxLength={40}
          />
          <button type="submit" className="btn btn-primary join-submit" disabled={!nick.trim()}>
            Join the mesh
          </button>
        </form>
        <div className="join-trust">
          <TrustBadge />
        </div>
      </div>
    </div>
  );
}
