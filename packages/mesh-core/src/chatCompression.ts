/**
 * Codec compression for the user-to-user room chat wire.
 *
 * ## Why a trained dictionary (and not plain zstd/gzip)
 *
 * `docs/DISTRIBUTION.md` makes the point that a trained dict-zstd does
 * ~nothing for model *weights* but IS the right tool for TEXT / structured
 * payloads. Chat frames are the textbook case: tiny (a msgpack chat frame
 * is ~40–60 bytes) and highly repetitive (same map keys, same version
 * byte, the same handful of nicks, "lgtm"/"brb"/"on my way" over and
 * over). On payloads that small a *stateless* compressor LOSES — its frame
 * header alone is bigger than what it saves, so plain zstd/gzip/deflate
 * makes a short chat frame BIGGER than the raw bytes (measured: plain
 * deflate ≈ 1.06× on our corpus, i.e. +6%). A preset dictionary changes
 * that: the compressor starts with a warm LZ window full of exactly those
 * repeated tokens, so a 50-byte frame drops to ~18 bytes — the opposite of
 * the weight case, and precisely why DISTRIBUTION.md flags text as where a
 * dict pays off.
 *
 * ## What ships
 *
 * A preset dictionary built deterministically from an embedded
 * representative corpus (`CHAT_DICT_CORPUS`) — transparent and
 * regenerable, not an opaque blob, so any peer builds the byte-identical
 * dict at import and both ends of the wire agree without a fetch. The
 * transport is RFC-1951 DEFLATE with that preset dictionary (via `fflate`,
 * pure-JS + isomorphic so the browser runtime and the Node test harness
 * exercise the *same* code path). DEFLATE-with-preset-dictionary is the
 * same warm-start-window technique dict-zstd uses; we use DEFLATE only
 * because it has a portable pure-JS implementation with dictionary support
 * that runs identically in Chrome and Node today (native
 * `CompressionStream` ships no dictionary hook). Swapping in dict-zstd
 * later is a drop-in behind this same API — see docs/USER-CHAT.md.
 *
 * ## Self-describing wire
 *
 * Every compressed payload is prefixed with a one-byte codec tag, so a
 * receiver never has to be told out-of-band how a frame was compressed
 * (this is the lightweight activation of the compression-negotiation
 * surface `webrtc-codec.ts` declares but leaves inert for the broadcast
 * chat path — a per-message tag instead of a per-stream HELLO/READY, which
 * a fan-out room chat has no place to run):
 *
 *   byte 0 = 0x00  → identity (compression didn't help; body is raw)
 *   byte 0 = 0x01  → dict-deflate (body is DEFLATE w/ the preset dict)
 *
 * The encoder picks whichever is smaller, so a pathological
 * incompressible frame is never inflated by more than the 1 tag byte.
 */
import { deflateSync, inflateSync } from 'fflate';
import { encode as msgpackEncode } from '@msgpack/msgpack';

// ── Codec tags ───────────────────────────────────────────────────────────────

export const CHAT_CODEC = {
  IDENTITY: 0x00,
  DICT_DEFLATE: 0x01,
} as const;
export type ChatCodecTag = (typeof CHAT_CODEC)[keyof typeof CHAT_CODEC];

// ── Training corpus ──────────────────────────────────────────────────────────

/**
 * Representative short room-chat traffic, ordered least → most useful.
 * DEFLATE weights the TAIL of a preset dictionary most heavily (bytes
 * nearest the end are the cheapest back-references), so the most common
 * fragments — the msgpack framing a real `encodeUserChatWire` emits, the
 * shortest/most-repeated phrases — go LAST.
 *
 * This is a corpus of *message bodies + framing fragments*, not a hand-
 * tuned blob: `buildChatDict` turns each entry into the exact wire bytes a
 * real chat frame uses, so the dictionary matches production traffic
 * byte-for-byte. Regenerate/extend by editing this array — the dict and
 * its hash follow deterministically.
 */
export const CHAT_DICT_CORPUS: readonly string[] = [
  // Longer, rarer phrases first (least valuable position).
  'has anyone seen the latest capacity numbers?',
  'the mesh looks healthy from here',
  'who is hosting the middle layers right now?',
  'compression on the chat wire is working nicely',
  'let me know if you need me to spin up a host',
  'i can take the next range if someone drops',
  'reconnecting, one sec',
  'what model are we assembling today?',
  'standing looks good, thanks for contributing',
  'be right back',
  'on my way',
  'sounds good to me',
  'works for me',
  'can you check the roster?',
  'good morning everyone',
  'see you tomorrow',
  'nice work',
  'thanks!',
  'thank you',
  'no problem',
  'agreed',
  'same here',
  'not sure',
  'maybe later',
  'one moment',
  'standby',
  'ready when you are',
  // Shortest / most-repeated last (most valuable position).
  'hey',
  'hi',
  'yes',
  'no',
  'ok',
  'okay',
  'lgtm',
  'gg',
  'brb',
  'ty',
  'np',
  '+1',
  'wdyt',
  'hello',
];

/**
 * Build the preset dictionary from `corpus` using `frame`, the same wire
 * framer real messages go through. The frames are concatenated in corpus
 * order (least-useful → most-useful, matching DEFLATE's tail-weighting).
 *
 * `frame` defaults to a minimal msgpack shape that mirrors
 * `userChat.ts`'s wire keys; `userChat.ts` passes its own framer so the
 * dict tracks the real on-wire encoding exactly.
 */
export function buildChatDict(
  corpus: readonly string[] = CHAT_DICT_CORPUS,
  frame: (text: string) => Uint8Array = defaultDictFrame,
): Uint8Array {
  const parts = corpus.map(frame);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Minimal default framer — the exact compact msgpack shape user-chat
 * frames put on the wire (short keys `v/i/n/o/x`, no `from`/`ts` — those
 * are supplied by the transport at decode time; see `userChat.ts`'s
 * `toWire`). Building the dictionary through the identical framer is what
 * makes the preset dict overlap real traffic byte-for-byte. */
function defaultDictFrame(text: string): Uint8Array {
  return msgpackEncode({ v: 1, i: '0', n: 'peer', o: '', x: text });
}

/** The shipped dictionary — every peer builds the byte-identical value at
 * import (deterministic function of the constant corpus). */
export const CHAT_DICT: Uint8Array = buildChatDict();

// ── Compress / decompress ────────────────────────────────────────────────────

/**
 * Compress raw payload bytes for the chat wire. Returns a self-describing
 * buffer: `[tag][body]`. The encoder tries dict-deflate and falls back to
 * identity when the compressed form isn't strictly smaller, so the worst
 * case is raw + 1 tag byte (never a multiplicative expansion).
 */
export function compressChatBytes(raw: Uint8Array, dict: Uint8Array = CHAT_DICT): Uint8Array {
  const deflated = deflateSync(raw, { level: 9, dictionary: dict });
  if (deflated.length < raw.length) {
    const out = new Uint8Array(deflated.length + 1);
    out[0] = CHAT_CODEC.DICT_DEFLATE;
    out.set(deflated, 1);
    return out;
  }
  const out = new Uint8Array(raw.length + 1);
  out[0] = CHAT_CODEC.IDENTITY;
  out.set(raw, 1);
  return out;
}

/**
 * Inverse of `compressChatBytes`. Reads the tag byte and either inflates
 * (dict-deflate) or strips the tag (identity). Returns null on a malformed
 * buffer or a decompression failure (a wrong dict yields corrupt bytes or
 * throws — either way the caller treats it as an undecodable frame and
 * drops it rather than feeding garbage to msgpack).
 */
export function decompressChatBytes(
  bytes: unknown,
  dict: Uint8Array = CHAT_DICT,
): Uint8Array | null {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1) return null;
  const tag = bytes[0];
  const body = bytes.subarray(1);
  try {
    if (tag === CHAT_CODEC.DICT_DEFLATE) return inflateSync(body, { dictionary: dict });
    if (tag === CHAT_CODEC.IDENTITY) return body.slice();
  } catch {
    return null;
  }
  return null;
}

// ── Measurement (for tests + the ratio the PR reports) ───────────────────────

export interface CompressionStats {
  /** Number of frames measured. */
  count: number;
  /** Total raw msgpack bytes across all frames. */
  rawBytes: number;
  /** Total dict-deflate wire bytes (incl. the 1-byte tag). */
  dictBytes: number;
  /** Total plain-deflate bytes (no dictionary) — the "why the dict matters"
   * baseline that EXPANDS short frames. */
  plainBytes: number;
  /** dictBytes / rawBytes. < 1 ⇒ net win. */
  dictRatio: number;
  /** plainBytes / rawBytes. > 1 on short frames ⇒ stateless compression
   * loses, which is the whole point. */
  plainRatio: number;
  /** Mean raw frame size in bytes. */
  avgRawBytes: number;
  /** Mean compressed (dict) frame size in bytes. */
  avgDictBytes: number;
}

/**
 * Measure dict-deflate vs plain-deflate vs raw over a set of already-
 * encoded (msgpack) frames. Used by the compression test and quoted in the
 * PR / docs so the reported ratio is reproducible, not asserted from
 * memory.
 */
export function measureCompression(
  rawFrames: readonly Uint8Array[],
  dict: Uint8Array = CHAT_DICT,
): CompressionStats {
  let rawBytes = 0;
  let dictBytes = 0;
  let plainBytes = 0;
  for (const raw of rawFrames) {
    rawBytes += raw.length;
    dictBytes += compressChatBytes(raw, dict).length;
    plainBytes += deflateSync(raw, { level: 9 }).length;
  }
  const count = rawFrames.length;
  return {
    count,
    rawBytes,
    dictBytes,
    plainBytes,
    dictRatio: rawBytes > 0 ? dictBytes / rawBytes : 1,
    plainRatio: rawBytes > 0 ? plainBytes / rawBytes : 1,
    avgRawBytes: count > 0 ? rawBytes / count : 0,
    avgDictBytes: count > 0 ? dictBytes / count : 0,
  };
}
