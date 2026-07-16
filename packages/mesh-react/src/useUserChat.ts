/**
 * useUserChat — the human, user-to-user room chat, wholly separate from the
 * AI/LLM path (`useCommunalChat` / `useMeshChat`'s `/ai` streams). Peers in
 * the room exchange short text messages over the mesh's dedicated `uc`
 * binary action, with four protections layered on:
 *
 *   1. Codec compression — every frame is dict-deflate compressed
 *      (`encodeUserChatWire`), the DISTRIBUTION.md-sanctioned use of a
 *      trained dictionary on small, repetitive text.
 *   2. Outbound safety prefilter — the SAME `prefilterOutbound` gate the AI
 *      chat uses, so nothing is transmitted before a local scan.
 *   3. Standing-gated rate limiting — a per-peer token bucket on BOTH
 *      directions, sized by the sender's contribution standing (see
 *      `rateLimiter.ts` + `standing.ts`): established contributors get more
 *      chat headroom, newcomers less, debtors least — never a hard block.
 *   4. Dedup / replay suppression — a `SeenSet` keyed on the (sender, id)
 *      pair drops duplicated or replayed frames.
 *
 * Nothing here touches the AI-activation wire.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  PerPeerRateLimiter,
  SeenSet,
  createUserChatIdSequencer,
  decodeUserChatWire,
  encodeUserChatWire,
  prefilterOutbound,
  userChatDedupKey,
  type OutboundSafetyOptions,
  type RateLimitConfig,
  type UserChatMessage,
} from '@unstable-legion/core';
import { encode as msgpackEncode } from '@msgpack/msgpack';

import { useMeshContext } from './provider.js';

export interface UseUserChatOptions {
  /** This operator's display nick (from `usePersona`). */
  nick: string;
  /**
   * Standing score resolver — wire the app's `bindPriorityScore(ledger, …)`
   * here so chat headroom tracks the contribution economy. Optional; absent
   * ⇒ every peer sits in the newcomer lane.
   */
  standingOf?: (peerId: string) => number;
  /** Local message-history cap. Default 300. */
  historyLimit?: number;
  /** Override the rate-limit lanes. */
  rateLimitConfig?: RateLimitConfig;
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number;
}

export type UserChatSendResult =
  | { kind: 'sent'; message: UserChatMessage; rawBytes: number; wireBytes: number }
  | { kind: 'empty' }
  | { kind: 'throttled'; retryAfterMs: number }
  | { kind: 'blocked'; categories: readonly string[] };

export interface UserChatWireStats {
  /** Frames this peer has SENT. */
  framesSent: number;
  /** Sum of raw (pre-compression) msgpack bytes across sent frames. */
  rawBytesSent: number;
  /** Sum of on-wire (compressed) bytes across sent frames. */
  wireBytesSent: number;
  /** wireBytesSent / rawBytesSent — the live measured ratio (< 1 ⇒ win). */
  ratio: number;
  /** Inbound frames dropped by the rate limiter (flood control). */
  droppedFlood: number;
  /** Inbound frames dropped as duplicates / replays. */
  droppedDup: number;
  /** Inbound frames dropped as undecodable. */
  droppedDecode: number;
}

export interface UseUserChatHandle {
  /** Room messages, oldest first, capped at `historyLimit`. */
  messages: readonly UserChatMessage[];
  /** Send a text message. Runs safety + outbound rate limit, then compresses
   * and transmits. Returns the outcome so the UI can surface throttle /
   * block feedback. */
  send: (text: string, opts?: { safety?: OutboundSafetyOptions }) => Promise<UserChatSendResult>;
  /** Live compression + drop counters. */
  stats: UserChatWireStats;
  /** Drop local history (does not affect remote peers). */
  clear: () => void;
}

const DEFAULT_HISTORY = 300;

export function useUserChat(opts: UseUserChatOptions): UseUserChatHandle {
  const { peer } = useMeshContext();
  const nowFn = opts.now ?? (() => Date.now());
  const historyLimit = opts.historyLimit ?? DEFAULT_HISTORY;

  const [messages, setMessages] = useState<readonly UserChatMessage[]>([]);
  const [stats, setStats] = useState<UserChatWireStats>({
    framesSent: 0,
    rawBytesSent: 0,
    wireBytesSent: 0,
    ratio: 1,
    droppedFlood: 0,
    droppedDup: 0,
    droppedDecode: 0,
  });

  // Stable per-mount machinery.
  const seqRef = useRef<() => string>(createUserChatIdSequencer());
  const seenRef = useRef<SeenSet>(new SeenSet());
  const inboundRlRef = useRef<PerPeerRateLimiter | null>(null);
  const outboundRlRef = useRef<PerPeerRateLimiter | null>(null);
  const standingRef = useRef<(peerId: string) => number>(opts.standingOf ?? (() => 1));
  standingRef.current = opts.standingOf ?? (() => 1);
  const nickRef = useRef(opts.nick);
  nickRef.current = opts.nick;

  if (inboundRlRef.current === null) {
    inboundRlRef.current = new PerPeerRateLimiter({
      config: opts.rateLimitConfig,
      standingOf: (p) => standingRef.current(p),
    });
  }
  if (outboundRlRef.current === null) {
    outboundRlRef.current = new PerPeerRateLimiter({
      config: opts.rateLimitConfig,
      standingOf: (p) => standingRef.current(p),
    });
  }

  const capRef = useRef(historyLimit);
  capRef.current = historyLimit;

  const append = useCallback((m: UserChatMessage) => {
    setMessages((prev) => {
      const next = prev.length >= capRef.current ? prev.slice(1) : prev;
      return [...next, m];
    });
  }, []);

  // ── Inbound wiring ──────────────────────────────────────────────────
  useEffect(() => {
    if (!peer) return;
    const unsub = peer.onUserChat((bytes, peerId) => {
      // Never trust our own echo (Trystero doesn't echo to self, but a
      // relay re-broadcast could) — dedup handles it too, but skip early.
      if (peerId === peer.selfId) return;
      const now = nowFn();
      // 1. Flood control BEFORE decompression work — a spamming peer costs
      //    us as little as possible.
      const admit = inboundRlRef.current!.check(peerId, now);
      if (!admit.allowed) {
        setStats((s) => ({ ...s, droppedFlood: s.droppedFlood + 1 }));
        return;
      }
      // 2. Decode (decompress + msgpack + validate).
      const msg = decodeUserChatWire(bytes, { from: peerId, ts: now });
      if (!msg) {
        setStats((s) => ({ ...s, droppedDecode: s.droppedDecode + 1 }));
        return;
      }
      // 3. Directed message not for us? Ignore (broadcast `to:''` always shown).
      if (msg.to && msg.to !== peer.selfId) return;
      // 4. Dedup / replay suppression.
      if (!seenRef.current.check(userChatDedupKey(msg.from, msg.id))) {
        setStats((s) => ({ ...s, droppedDup: s.droppedDup + 1 }));
        return;
      }
      append(msg);
    });
    return () => {
      unsub();
    };
  }, [peer, append, nowFn]);

  // (A peer's stale buckets are reclaimed by the limiter's own idle
  // eviction — the `Peer` handle exposes no onPeerLeave, so no explicit
  // forget path is wired here.)

  // ── Send ────────────────────────────────────────────────────────────
  const send = useCallback<UseUserChatHandle['send']>(
    async (text, sendOpts) => {
      const trimmed = text.trim();
      if (!peer || !trimmed) return { kind: 'empty' };

      // 1. Safety prefilter — identical gate to the AI chat path.
      const decision = prefilterOutbound(trimmed, sendOpts?.safety);
      if (decision.kind === 'blocked') {
        return { kind: 'blocked', categories: decision.categories.map(String) };
      }
      const body = decision.kind === 'redacted' ? decision.text : trimmed;

      // 2. Outbound rate limit (keyed on self, sized by our own standing).
      const now = nowFn();
      const admit = outboundRlRef.current!.check(peer.selfId, now);
      if (!admit.allowed) {
        return { kind: 'throttled', retryAfterMs: admit.retryAfterMs };
      }

      // 3. Build + encode + transmit.
      const message: UserChatMessage = {
        v: 1,
        id: seqRef.current(),
        ts: now,
        from: peer.selfId,
        nick: nickRef.current,
        to: '',
        text: body,
        ...(decision.kind === 'redacted'
          ? { safety: { source: 'prefilter' as const, category: String(decision.categories[0]), confidence: 1 } }
          : {}),
      };
      const wire = encodeUserChatWire(message);
      const rawBytes = msgpackEncode({ v: 1, i: message.id, n: message.nick, o: message.to, x: message.text }).length;
      const wireBytes = wire.length;
      await peer.sendUserChat(wire);

      // Record our own id so a relay re-broadcast can't double-add it.
      seenRef.current.check(userChatDedupKey(message.from, message.id));
      append(message); // optimistic local echo
      setStats((s) => {
        const rawBytesSent = s.rawBytesSent + rawBytes;
        const wireBytesSent = s.wireBytesSent + wireBytes;
        return {
          ...s,
          framesSent: s.framesSent + 1,
          rawBytesSent,
          wireBytesSent,
          ratio: rawBytesSent > 0 ? wireBytesSent / rawBytesSent : 1,
        };
      });
      return { kind: 'sent', message, rawBytes, wireBytes };
    },
    [peer, append, nowFn],
  );

  const clear = useCallback(() => setMessages([]), []);

  return useMemo(
    () => ({ messages, send, stats, clear }),
    [messages, send, stats, clear],
  );
}
