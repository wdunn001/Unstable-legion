/**
 * MeshChatPanel — chat composer + message list + live AI streams.
 *
 *   - Plain text: routes through `useMeshChat.send` (safety prefilter
 *     fires; blocked sends raise the safety dialog).
 *   - `/ai <prompt>`: requires `localLlm` ready; streams raw Codec
 *     frames via `peer.sendFrame` AND locally detokenizes for
 *     self-display.
 *   - `/tool <peer-nick> <name> [json-args]`: invokes a peer's tool via
 *     `useMeshTools.callTool`; result lands as a chat line.
 *
 * Receiving peers' frames are detokenized per-sender into a `Map<peerId,
 * AiStreamState>` that renders inline with the message list.
 *
 * The component registers itself as the draft-bridge target on mount so
 * `MeshRosterPanel` clicks insert templates into the composer.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Detokenizer, type TokenizerMap } from '@codecai/web';
import type {
  CodecMsgpackFrame,
  MeshToolResult,
} from '@unstable-legion/core';
import { useMeshContext } from '../provider.js';
import { useMeshChat } from '../useMeshChat.js';
import { useMeshRoster } from '../useMeshRoster.js';
import { useCodecMapResolver } from '../useCodecMap.js';
import type { UseMeshToolsHandle } from '../useMeshTools.js';
import type { UseLocalLlmHandle } from '../useLocalLlm.js';
import { registerDraftSetter } from '../draftBridge.js';
import { SafetyDialog } from './SafetyDialog.js';

interface AiStreamState {
  text: string;
  frameCount: number;
  byteCount: number;
  done: boolean;
}

export interface MeshChatPanelProps {
  /** Local LLM handle (for `/ai`). Optional — without it, `/ai` reports "not ready". */
  llm?: UseLocalLlmHandle;
  /** Tokenizer map used to detokenize incoming frames for display. */
  map: TokenizerMap | null;
  /** Tokenizer-map load error string for surface in the UI. */
  mapError?: string | null;
  /** Tool calling handle (for `/tool`). Optional — without it `/tool` is a no-op. */
  tools?: UseMeshToolsHandle;
  /** Placeholder for the composer input. */
  placeholder?: string;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function shortenFrom(from: string, self: string | undefined): string {
  if (self && from === self) return 'me';
  return truncate(from, 8);
}

/** Cheap byte-size estimate for a CodecFrame — 4 B/id + ~16 B envelope. */
function estimateFrameBytes(frame: { ids?: readonly number[] }): number {
  return (frame.ids?.length ?? 0) * 4 + 16;
}

export function MeshChatPanel(props: MeshChatPanelProps) {
  const { llm, map, mapError, tools, placeholder } = props;
  const { messages, send } = useMeshChat();
  const { peer } = useMeshContext();
  const roster = useMeshRoster();
  // Resolver maps each remote peer's advertised modelId → its tokenizer
  // family → a Detokenizer bound to the right vocab. Without this,
  // frames from a peer running SmolLM2 (or any non-local-family model)
  // get rendered through the LOCAL family's vocab and come out as
  // garbage.
  const mapResolver = useCodecMapResolver();
  const [draft, setDraft] = useState('');

  useEffect(() => {
    registerDraftSetter((mutator) => setDraft((cur) => mutator(cur)));
    return () => registerDraftSetter(null);
  }, []);

  const [pending, setPending] = useState<
    | null
    | {
        text: string;
        decision: Extract<Awaited<ReturnType<typeof send>>, { kind: 'blocked' }>;
      }
  >(null);

  const [aiStreams, setAiStreams] = useState<Map<string, AiStreamState>>(
    () => new Map(),
  );
  const detoksRef = useRef<Map<string, Detokenizer>>(new Map());

  // The roster is captured by ref so the onFrame closure always reads
  // the latest peer-cap-modelId without re-binding the subscription on
  // every roster change.
  const rosterRef = useRef(roster);
  useEffect(() => {
    rosterRef.current = roster;
  }, [roster]);

  useEffect(() => {
    if (!peer) return;
    const unsub = peer.onFrame((frame: CodecMsgpackFrame, peerId: string) => {
      // Pick the detokenizer for THIS peer based on their cap.modelId.
      // Fall back to the local `map` only if the resolver hasn't loaded
      // the right family yet (it kicks off the fetch on miss).
      let detok = detoksRef.current.get(peerId);
      if (!detok) {
        const rosterEntry = rosterRef.current.find((r) => r.peerId === peerId);
        const remoteDetok = rosterEntry
          ? mapResolver.detokenizerFor(rosterEntry.modelId)
          : null;
        if (remoteDetok) {
          detok = remoteDetok;
        } else if (map) {
          // Resolver hasn't loaded yet, OR roster entry missing.
          // Use the local map as a fallback so the user sees SOMETHING.
          // Once the resolver lands the right family on a later frame,
          // we'll swap in the correct detok.
          detok = new Detokenizer(map);
        } else {
          // No usable map at all — skip this frame.
          return;
        }
        detoksRef.current.set(peerId, detok);
      }
      const delta =
        frame.ids.length > 0
          ? detok.render(frame.ids, { partial: !frame.done })
          : '';
      setAiStreams((prev) => {
        const next = new Map(prev);
        const cur = next.get(peerId) ?? {
          text: '',
          frameCount: 0,
          byteCount: 0,
          done: false,
        };
        next.set(peerId, {
          text: cur.text + delta,
          frameCount: cur.frameCount + 1,
          byteCount: cur.byteCount + estimateFrameBytes(frame),
          done: frame.done,
        });
        return next;
      });
      if (frame.done) {
        detok.reset();
        // Drop the cached detok on completion so the next stream picks
        // up the right family — handles the case where the peer's
        // modelId changed mid-session.
        detoksRef.current.delete(peerId);
      }
    });
    return () => {
      unsub();
    };
  }, [peer, map, mapResolver]);

  const selfDetokRef = useRef<Detokenizer | null>(null);
  useEffect(() => {
    selfDetokRef.current = map ? new Detokenizer(map) : null;
  }, [map]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');

    if (text.startsWith('/tool ')) {
      if (!tools) {
        if (peer) {
          await peer.sendChat({
            to: '',
            bodyKind: 'text',
            text: '[error] this peer has no tool-caller wired in (pass `tools` to MeshChatPanel).',
          });
        }
        return;
      }
      const rest = text.slice(6).trim();
      const m = rest.match(/^(\S+)\s+(\S+)(?:\s+(.+))?$/);
      if (!m) {
        if (peer) {
          await peer.sendChat({
            to: '',
            bodyKind: 'text',
            text: '[error] usage: /tool <peer-nick-or-prefix> <toolName> [json-args]',
          });
        }
        return;
      }
      const [, targetNick, toolName, jsonArgsStr] = m;
      const targetEntry = roster.find(
        (p) =>
          p.nick.toLowerCase() === targetNick!.toLowerCase() ||
          p.peerId.toLowerCase().startsWith(targetNick!.toLowerCase()),
      );
      if (!targetEntry) {
        if (peer) {
          await peer.sendChat({
            to: '',
            bodyKind: 'text',
            text: `[error] no peer matches "${targetNick}".`,
          });
        }
        return;
      }
      let args: Record<string, unknown> = {};
      if (jsonArgsStr) {
        try {
          const parsed = JSON.parse(jsonArgsStr);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('args must be a JSON object');
          }
          args = parsed as Record<string, unknown>;
        } catch (err) {
          if (peer) {
            await peer.sendChat({
              to: '',
              bodyKind: 'text',
              text: `[error] invalid json args: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
          return;
        }
      }
      if (peer) {
        await peer.sendChat({
          to: '',
          bodyKind: 'text',
          text: `/tool ${targetEntry.nick} ${toolName} ${JSON.stringify(args)}`,
        });
      }
      try {
        const result: MeshToolResult = await tools.callTool(
          targetEntry.peerId,
          toolName!,
          args,
        );
        if (peer) {
          const resultContent =
            (result.result as Record<string, unknown> | undefined)?.content ??
            result.result;
          const summary =
            result.status === 'ok'
              ? `[tool ok] ${toolName} → ${JSON.stringify(resultContent)}`
              : `[tool ${result.status}] ${toolName}: ${result.error ?? '(no details)'}`;
          await peer.sendChat({ to: '', bodyKind: 'text', text: summary });
        }
      } catch (err) {
        if (peer) {
          await peer.sendChat({
            to: '',
            bodyKind: 'text',
            text: `[tool exception] ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      return;
    }

    if (text.startsWith('/ai ')) {
      const prompt = text.slice(4);
      if (peer) {
        await peer.sendChat({ to: '', bodyKind: 'text', text: `/ai ${prompt}` });
      }
      if (!llm || llm.status.phase !== 'ready') {
        if (peer) {
          await peer.sendChat({
            to: '',
            bodyKind: 'text',
            text: `[error] /ai requested but local LLM is "${llm?.status.phase ?? 'absent'}".`,
          });
        }
        return;
      }
      const selfDetok = selfDetokRef.current;
      if (selfDetok) selfDetok.reset();
      setAiStreams((prev) => {
        const next = new Map(prev);
        next.set(peer?.selfId ?? 'me', { text: '', frameCount: 0, byteCount: 0, done: false });
        return next;
      });
      try {
        await llm.streamFrames(prompt, (frame) => {
          if (peer) {
            void peer.sendFrame(frame as unknown as CodecMsgpackFrame);
          }
          if (selfDetok) {
            const delta =
              frame.ids.length > 0
                ? selfDetok.render(frame.ids, { partial: !frame.done })
                : '';
            setAiStreams((prev) => {
              const next = new Map(prev);
              const key = peer?.selfId ?? 'me';
              const cur = next.get(key) ?? {
                text: '',
                frameCount: 0,
                byteCount: 0,
                done: false,
              };
              next.set(key, {
                text: cur.text + delta,
                frameCount: cur.frameCount + 1,
                byteCount:
                  cur.byteCount + estimateFrameBytes(frame as unknown as CodecMsgpackFrame),
                done: frame.done,
              });
              return next;
            });
          }
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (peer) {
          await peer.sendChat({
            to: '',
            bodyKind: 'text',
            text: `[/ai error] ${errMsg}`,
          });
        }
      }
      return;
    }

    const decision = await send(text);
    if (decision.kind === 'blocked') {
      setPending({
        text,
        decision: decision as Extract<typeof decision, { kind: 'blocked' }>,
      });
    }
  };

  return (
    <section className="ul-chat">
      <h3>Chat</h3>
      {mapError && <div className="ul-warn">tokenizer map load failed: {mapError}</div>}
      <div className="ul-msgs">
        {messages.length === 0 && aiStreams.size === 0 ? (
          <p className="ul-muted">
            no messages yet. <code>/ai &lt;prompt&gt;</code> invokes the local
            WebGPU LLM; <code>/tool &lt;peer&gt; &lt;name&gt;</code> invokes a peer
            tool.
          </p>
        ) : (
          <>
            {messages.map((m, i) => (
              <div key={`m${i}`} className="ul-msg">
                <span className="ul-from">{shortenFrom(m.from, peer?.selfId)}</span>
                <span className="ul-body">{m.text}</span>
                {m.safety?.category && (
                  <span className="ul-badge">{m.safety.category}</span>
                )}
              </div>
            ))}
            {[...aiStreams.entries()].map(([peerId, state]) => (
              <div key={`ai-${peerId}`} className="ul-msg ul-msg-ai">
                <span className="ul-from">
                  {shortenFrom(peerId, peer?.selfId)} <em>(ai)</em>
                </span>
                <span className="ul-body">
                  {state.text || <em className="ul-muted">(awaiting tokens…)</em>}
                </span>
                <span className="ul-badge ul-badge-ok">
                  {state.frameCount} frames · {state.byteCount} B
                </span>
              </div>
            ))}
          </>
        )}
      </div>
      <form onSubmit={onSubmit} className="ul-composer">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder ?? 'message the mesh… or /ai <prompt>'}
          autoComplete="off"
        />
        <button type="submit" disabled={!draft.trim() || !peer}>send</button>
      </form>
      {pending && (
        <SafetyDialog
          decision={pending.decision}
          onRedact={async () => {
            await send(pending.text, { safety: { policy: 'redact-auto' } });
            setPending(null);
          }}
          onSendAnyway={async () => {
            if (peer) {
              await peer.sendChat({ to: '', bodyKind: 'text', text: pending.text });
            }
            setPending(null);
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </section>
  );
}
