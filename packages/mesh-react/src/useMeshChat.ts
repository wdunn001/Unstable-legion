/**
 * useMeshChat — send/receive chat messages over the mesh.
 *
 * Returns a `messages` array that grows on each inbound `cm` payload,
 * plus a `send` function that runs the safety prefilter and emits over
 * Trystero. The hook keeps a local capped history; consumers wanting
 * persistence can wire their own observer with `peer.onChat`.
 *
 * Send semantics by `OutboundDecision.kind`:
 *   - `clean`    — body untouched, sent immediately.
 *   - `redacted` — `policy: 'redact-auto'` was set; redacted body is
 *                  sent (verdict attached); host UI may surface a chip.
 *   - `blocked`  — match fired with default policy. Hook does NOT send.
 *                  Host UI inspects the decision (typically opens a
 *                  redact / send-anyway / cancel dialog) and either
 *                  re-calls `send(text, { safety: { policy: 'redact-auto' }})`
 *                  or skips.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  prefilterOutbound,
  type MeshChatMessage,
  type OutboundDecision,
  type OutboundSafetyOptions,
} from '@unstable-legion/core';

import { useMeshContext } from './provider.js';

export interface ChatHook {
  /** Recent messages, oldest first. Capped at `historyLimit`. */
  messages: readonly MeshChatMessage[];
  /**
   * Send a chat message. Returns the prefilter `OutboundDecision`. A
   * `blocked` decision short-circuits the actual send so the host UI
   * can prompt the user; a `clean` or `redacted` decision is sent and
   * locally echoed.
   */
  send: (text: string, opts?: SendOptions) => Promise<OutboundDecision>;
  /** Drop the local history (does not affect remote peers). */
  clear: () => void;
}

export interface SendOptions {
  /** Empty / undefined = broadcast; otherwise a specific peer's selfId. */
  to?: string;
  /** Override prefilter behavior for this send. */
  safety?: OutboundSafetyOptions;
}

const DEFAULT_HISTORY = 256;

export function useMeshChat(opts: { historyLimit?: number } = {}): ChatHook {
  const { peer } = useMeshContext();
  const [messages, setMessages] = useState<readonly MeshChatMessage[]>([]);
  const cap = opts.historyLimit ?? DEFAULT_HISTORY;
  const capRef = useRef(cap);
  capRef.current = cap;

  useEffect(() => {
    if (!peer) return;
    const unsub = peer.onChat((msg) => {
      setMessages((prev) => {
        const next = prev.length >= capRef.current ? prev.slice(1) : prev;
        return [...next, msg];
      });
    });
    return () => {
      unsub();
    };
  }, [peer]);

  const send = useCallback<ChatHook['send']>(
    async (text, sendOpts) => {
      if (!peer) {
        return { kind: 'clean', text, verdict: { source: 'prefilter' } };
      }
      const decision = prefilterOutbound(text, sendOpts?.safety);

      if (decision.kind === 'blocked') {
        return decision;
      }

      const body = decision.kind === 'redacted' ? decision.text : text;

      const msg: Omit<MeshChatMessage, 'v' | 'ts' | 'from'> = {
        to: sendOpts?.to ?? '',
        bodyKind: 'text',
        text: body,
        ...(decision.kind === 'redacted'
          ? {
              safety: {
                category: decision.categories[0],
                confidence: 1.0,
                source: 'prefilter' as const,
              },
            }
          : {}),
      };
      await peer.sendChat(msg, sendOpts?.to || undefined);

      // Optimistic local echo so the sender sees their own message.
      const localMsg: MeshChatMessage = {
        v: 1,
        ts: Date.now(),
        from: peer.selfId,
        ...msg,
      };
      setMessages((prev) => {
        const next = prev.length >= capRef.current ? prev.slice(1) : prev;
        return [...next, localMsg];
      });

      return decision;
    },
    [peer],
  );

  const clear = useCallback(() => setMessages([]), []);

  return { messages, send, clear };
}
