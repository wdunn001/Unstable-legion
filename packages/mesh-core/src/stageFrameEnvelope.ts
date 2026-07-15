/**
 * M2 — sessionId envelope for the `sf` activation-frame channel.
 *
 * The `sf` Trystero action (peer.ts's sendStageFrame/onStageFrame) carries
 * raw activation-wire bytes with no sessionId — fine for M1's single-
 * session-per-host convention, but once one host serves N concurrent
 * driver sessions (M2), inbound `sf` bytes must say WHICH session they
 * belong to before `useStageHost.ts` can route them to that session's
 * decoder.
 *
 * Two ways to thread that through were on the table (see the M2 workstream
 * brief): add `sessionId` to the Codec activation-profile frame itself
 * (packages/web/src/latent-frame.ts in the separate Codec repo, a v0.7
 * bump requiring a rebuild + robocopy into this repo's node_modules), or
 * wrap the `sf` payload in a small envelope entirely within mesh-core.
 * This module implements the SECOND option — chosen because it keeps the
 * whole change inside unstable-legion (no cross-repo Codec edit, no dist
 * rebuild/robocopy dance) while being just as effective: the envelope is
 * stripped before the inner bytes ever reach the Codec/stage-runtime wire
 * decoder, so `frames.ts` (legion-stage-runtime, read-only for this repo)
 * never needs to know sessions exist.
 *
 * Wire shape (little-endian): [uint16 sessionId byte-length][sessionId
 * UTF-8 bytes][opaque payload bytes — the pre-M2 `sf` content unchanged:
 * either the once-per-stream wire header or one activation-wire frame].
 *
 * Callers: `stageOrchestrator.ts` wraps every outbound `sf` send (driver
 * side); `useStageHost.ts` unwraps every inbound `sf` receive (host side).
 * Both ends of this repo's Phase C protocol are updated together in the
 * same milestone, so there's no mixed-version envelope/non-envelope
 * traffic to tolerate — `sf` is already a Phase C-only action a v1 peer
 * never listens on (see peer.ts's action-mapping doc comment).
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const MAX_SESSION_ID_BYTES = 0xffff;

/** Wrap `payload` (a wire header or activation-wire frame, opaque here)
 * with a length-prefixed `sessionId` so the receiver can route it before
 * handing the inner bytes to a per-session activation-wire decoder. */
export function encodeStageFrameEnvelope(sessionId: string, payload: Uint8Array): Uint8Array {
  const idBytes = textEncoder.encode(sessionId);
  if (idBytes.byteLength === 0) {
    throw new RangeError('sessionId must not be empty');
  }
  if (idBytes.byteLength > MAX_SESSION_ID_BYTES) {
    throw new RangeError(`sessionId too long to envelope (${idBytes.byteLength} bytes, max ${MAX_SESSION_ID_BYTES})`);
  }
  const out = new Uint8Array(2 + idBytes.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint16(0, idBytes.byteLength, true);
  out.set(idBytes, 2);
  out.set(payload, 2 + idBytes.byteLength);
  return out;
}

export interface DecodedStageFrameEnvelope {
  sessionId: string;
  /** The inner opaque bytes — still needs the caller's own header-vs-frame
   * handling (per-session `awaitingHeader` state), unchanged from pre-M2. */
  payload: Uint8Array;
}

/** Unwrap an enveloped `sf` payload. Returns `null` on anything malformed
 * (too short, truncated sessionId, empty sessionId) — additive-safe
 * tolerance matching `decodeStageControl`'s "never throw on garbage"
 * idiom, since `sf` traffic from a stale/buggy peer shouldn't crash the
 * receiver's frame-handling loop. */
export function decodeStageFrameEnvelope(bytes: Uint8Array): DecodedStageFrameEnvelope | null {
  if (bytes.byteLength < 2) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLen = view.getUint16(0, true);
  if (idLen === 0 || bytes.byteLength < 2 + idLen) return null;
  const idBytes = bytes.subarray(2, 2 + idLen);
  let sessionId: string;
  try {
    sessionId = textDecoder.decode(idBytes);
  } catch {
    return null;
  }
  if (!sessionId) return null;
  const payload = bytes.subarray(2 + idLen);
  return { sessionId, payload };
}
