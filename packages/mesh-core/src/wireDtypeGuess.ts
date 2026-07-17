/**
 * wireDtypeGuess — best-effort dtype inference from a captured `sf` frame's
 * BYTE SIZE alone, for observability surfaces that only ever see
 * `bytes.byteLength` (e.g. `useCommunalChat.ts`'s `loggedPeer.sendStageFrame`
 * wrapper) and never a plumbed-through dtype field. This is deliberate —
 * see the pipeline-handoff UI brief: deriving from the actual wire bytes is
 * the HONEST answer (what really went out), rather than trusting a
 * caller-supplied hint that could drift from what a peer actually
 * negotiated/sent for a given hop.
 *
 * A single-token activation-wire DATA frame (the shape a decode step emits
 * per hop, one per generated token — see `activationWireCodec.ts` /
 * `legionActivationBytes(1, nEmbd, dtype)`) is `nEmbd * bytesPerElement`
 * raw element bytes PLUS msgpack/envelope overhead: the activation-wire
 * frame's own msgpack keys, `stageFrameEnvelope.ts`'s sessionId wrapper,
 * and Trystero's `sf` action framing. Empirically that overhead lands
 * around 100-140 bytes, so this solves `bytes ≈ nEmbd * bytesPerElement +
 * overhead` for whichever of 1/2/4 bytes/element ('i8'/'f16'/'f32') comes
 * closest, within a tolerance band wide enough to absorb the overhead
 * without also matching an adjacent dtype. Returns '?' when nothing is
 * close enough to trust (junk input, or a frame that isn't a single-token
 * decode frame at all — e.g. a multi-token prefill chunk).
 */
export type WireDtypeGuess = 'i8' | 'f16' | 'f32' | '?';

/** Wider than the observed ~100-140 byte overhead so real frames always
 * land inside the band, but still narrow enough that i8 (1 byte/elem) and
 * f16 (2 bytes/elem) never collide for any nEmbd this repo ships
 * (>=4096 -> their expected byte counts are thousands of bytes apart). */
const OVERHEAD_TOLERANCE_BYTES = 160;

const CANDIDATES: readonly { dtype: WireDtypeGuess; bytesPerElement: number }[] = [
  { dtype: 'i8', bytesPerElement: 1 },
  { dtype: 'f16', bytesPerElement: 2 },
  { dtype: 'f32', bytesPerElement: 4 },
];

export function wireDtypeFromFrameBytes(bytes: number, nEmbd: number): WireDtypeGuess {
  if (!(bytes > 0) || !(nEmbd > 0)) return '?';

  let best: { dtype: WireDtypeGuess; diff: number } | undefined;
  for (const candidate of CANDIDATES) {
    const expected = nEmbd * candidate.bytesPerElement;
    const diff = Math.abs(bytes - expected);
    if (diff <= OVERHEAD_TOLERANCE_BYTES && (!best || diff < best.diff)) {
      best = { dtype: candidate.dtype, diff };
    }
  }
  return best?.dtype ?? '?';
}
