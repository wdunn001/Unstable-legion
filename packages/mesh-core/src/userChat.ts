/**
 * User-to-user room chat — the human-typed text channel, distinct from the
 * AI/LLM streaming path (`cf`/`sf` frames) and from the AI-oriented `cm`
 * metadata action. Peers in a room exchange short text messages that are
 * msgpack-framed, dict-deflate-compressed (`chatCompression.ts`), and
 * shipped as opaque bytes over a dedicated Trystero action (`uc`).
 *
 * This module owns the pure, testable pieces:
 *   - the compact wire shape (short keys, to maximise dictionary overlap),
 *   - encode → msgpack → compress and its exact inverse,
 *   - message-id minting + a replay/dedup `SeenSet`.
 *
 * The React binding (`@unstable-legion/react`'s `useUserChat`) wires these
 * to the peer, the safety prefilter, and the standing-gated rate limiter.
 */
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';

import { compressChatBytes, decompressChatBytes, CHAT_DICT } from './chatCompression.js';
import { MESH_PROTOCOL_VERSION } from './types.js';

// ── Message shape ────────────────────────────────────────────────────────────

export interface UserChatMessage {
  v: typeof MESH_PROTOCOL_VERSION;
  /** Per-message id for dedup/replay suppression. Room-unique. */
  id: string;
  /** Sender wall-clock millis (display only; clocks aren't assumed synced). */
  ts: number;
  /** Sender's Trystero selfId — the transport identity, for rate-limit keying. */
  from: string;
  /** Sender's chosen display nick (from `usePersona`). */
  nick: string;
  /** Empty = broadcast to the room; non-empty = a specific peer's selfId. */
  to: string;
  /** The human-typed text (UTF-8). */
  text: string;
  /**
   * Optional safety verdict the sender ran locally before transmit — same
   * informational shape as `MeshChatMessage.safety`, so a receiver UI can
   * badge without re-classifying.
   */
  safety?: {
    category?: string;
    confidence?: number;
    source: 'prefilter' | 'classifier' | 'clean';
  };
}

// ── Compact wire form ────────────────────────────────────────────────────────
// Short keys (v/i/n/o/x/s) — every byte saved is a byte the tiny-frame
// compressor doesn't have to encode. Crucially, `from` and `ts` are NOT on
// the wire: Trystero already hands the receiver the sender's peerId out-of-
// band (the `onUserChat(cb)` callback's `peerId` arg), and the receive
// clock is an adequate display time — so shipping the ~20-char random
// selfId and a 13-digit epoch in every tiny frame would be pure
// incompressible overhead (it dominated the ratio in testing). They're
// injected at decode from the transport instead. The remaining keys line up
// with the dictionary corpus framing in `chatCompression.ts` so the preset
// dict overlaps real traffic byte-for-byte.

interface UserChatWire {
  v: number;
  i: string;
  n: string;
  o: string;
  x: string;
  s?: UserChatMessage['safety'];
}

function toWire(m: UserChatMessage): UserChatWire {
  const w: UserChatWire = { v: m.v, i: m.id, n: m.nick, o: m.to, x: m.text };
  if (m.safety) w.s = m.safety;
  return w;
}

/** Transport-supplied context injected at decode — the sender identity and
 * receive time the wire deliberately omits. */
export interface UserChatDecodeContext {
  /** Sender's Trystero selfId, from the `onUserChat` callback's peerId arg. */
  from: string;
  /** Receive-clock millis to stamp the message with. Defaults to `Date.now()`. */
  ts?: number;
}

function fromWire(w: unknown, ctx: UserChatDecodeContext): UserChatMessage | null {
  if (typeof w !== 'object' || w === null) return null;
  const r = w as Record<string, unknown>;
  if (r.v !== MESH_PROTOCOL_VERSION) return null;
  if (typeof r.i !== 'string' || !r.i) return null;
  if (typeof r.n !== 'string') return null;
  if (typeof r.o !== 'string') return null;
  if (typeof r.x !== 'string') return null;
  const msg: UserChatMessage = {
    v: MESH_PROTOCOL_VERSION,
    id: r.i,
    ts: ctx.ts ?? Date.now(),
    from: ctx.from,
    nick: r.n,
    to: r.o,
    text: r.x,
  };
  if (r.s !== undefined) {
    if (typeof r.s !== 'object' || r.s === null) return null;
    const s = r.s as Record<string, unknown>;
    if (s.source !== 'prefilter' && s.source !== 'classifier' && s.source !== 'clean') return null;
    msg.safety = {
      source: s.source,
      ...(typeof s.category === 'string' ? { category: s.category } : {}),
      ...(typeof s.confidence === 'number' ? { confidence: s.confidence } : {}),
    };
  }
  return msg;
}

// ── Encode / decode over the wire ────────────────────────────────────────────

/**
 * Encode a user-chat message to compressed wire bytes ready for the `uc`
 * Trystero action: compact-msgpack → dict-deflate (self-describing tag
 * byte). Only the wire subset (`v/i/n/o/x/s`) is encoded — `from`/`ts` are
 * transport-supplied at decode. The AI-activation wire is untouched; this
 * is a separate action with its own codec.
 */
export function encodeUserChatWire(m: UserChatMessage, dict: Uint8Array = CHAT_DICT): Uint8Array {
  const raw = msgpackEncode(toWire(m));
  return compressChatBytes(raw, dict);
}

/**
 * Decode inbound `uc` bytes back to a `UserChatMessage`, injecting the
 * transport-supplied `from` (peerId) and receive `ts`. Returns null on a
 * malformed/undecodable frame (wrong dict, truncated buffer, non-conforming
 * shape) — the caller drops it rather than trusting partial data.
 */
export function decodeUserChatWire(
  bytes: unknown,
  ctx: UserChatDecodeContext,
  dict: Uint8Array = CHAT_DICT,
): UserChatMessage | null {
  const raw = decompressChatBytes(bytes, dict);
  if (!raw) return null;
  let decoded: unknown;
  try {
    decoded = msgpackDecode(raw);
  } catch {
    return null;
  }
  return fromWire(decoded, ctx);
}

// ── Message id ───────────────────────────────────────────────────────────────

/**
 * A per-session monotonic id sequencer. Ids are short base-36 counters
 * (`"0"`, `"1"`, …, `"z"`, `"10"`, …) — one or two bytes on the wire, and
 * (unlike a random id) fully compressible, which matters enormously on a
 * ~40-byte frame. Uniqueness is provided by the (sender selfId, id) PAIR:
 * dedup keys on `${from}:${id}`, and `from` is the Trystero selfId which is
 * fresh per tab/session, so a counter that resets on reload can't collide
 * with pre-reload ids from the same human.
 *
 * The optional `start` seed lets a reconnecting session continue past its
 * prior high-water mark within the same selfId if a caller tracks one.
 */
export function createUserChatIdSequencer(start = 0): () => string {
  let n = start;
  return () => (n++).toString(36);
}

/**
 * Mint a standalone room-unique message id (random). Prefer
 * `createUserChatIdSequencer` on the hot path — a random id is
 * incompressible and inflates tiny frames. Kept for callers that need a
 * one-off id without holding a sequencer.
 */
export function newUserChatId(): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function'
      ? Array.from(crypto.getRandomValues(new Uint8Array(4)))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
      : Math.random().toString(16).slice(2, 10);
  return `${Date.now().toString(36)}-${rand}`;
}

/** Compose the dedup key for a message: the (sender, id) pair. The id alone
 * isn't globally unique (each sender has its own counter); the pair is. */
export function userChatDedupKey(from: string, id: string): string {
  return `${from}:${id}`;
}

// ── Dedup / replay suppression ───────────────────────────────────────────────

/**
 * Bounded FIFO set of recently-seen message ids. Trystero's data channel
 * is reliable+ordered per peer, but a broadcast can still reach a peer more
 * than once via distinct relay paths / re-broadcast, and a malicious peer
 * can replay a captured frame. `SeenSet.check` is add-if-absent: it returns
 * true the FIRST time an id is seen and false on every repeat, so the
 * caller both records and tests in one call.
 */
export class SeenSet {
  private readonly ids = new Set<string>();
  private readonly order: string[] = [];
  private readonly capacity: number;

  constructor(capacity = 2048) {
    this.capacity = Math.max(1, capacity);
  }

  /** True iff `id` has been seen before (does not record it). */
  has(id: string): boolean {
    return this.ids.has(id);
  }

  /**
   * Record `id`. Returns true if it was NEW (first sighting), false if it
   * was a duplicate/replay. Evicts the oldest id when at capacity.
   */
  check(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    this.order.push(id);
    if (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.ids.delete(evicted);
    }
    return true;
  }

  get size(): number {
    return this.ids.size;
  }
}
