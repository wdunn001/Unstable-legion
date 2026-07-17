/**
 * Activation wire dispatcher — the ONE seam `stageOrchestrator.ts` (driver
 * side) and `useStageHost.ts` (host side, in mesh-react) call through,
 * so neither needs to know whether a given `wireDtype` is handled by
 * `@unstable-legion/stage-runtime`'s codec (`'f32'`/`'f16'`) or this
 * repo's own self-contained one (`'i8'` — see `activationWireI8.ts`'s doc
 * comment for why that dtype can't live in the upstream package).
 *
 * Both encoder/decoder shapes returned here are structurally identical to
 * `@unstable-legion/stage-runtime`'s `ActivationWireEncoder`/
 * `ActivationWireDecoder` (same `headerBytes()`/`encodeFrame()` and
 * `modelId`/`nEmbd`/`dtype`/`decodeFrameBytes()` members) — just widened
 * to accept `'i8'` in `dtype`. Existing callers that only ever used
 * `'f32'`/`'f16'` see no behavior change.
 */
import {
  createActivationWireEncoder,
  createActivationWireDecoder,
  activationBytes as activationBytesUpstream,
  type ActivationWireEncoder,
  type ActivationWireDecoder,
  type WireFrameMeta,
  type DecodedWireFrame,
} from '@unstable-legion/stage-runtime';
import { createI8ActivationWireEncoder, createI8ActivationWireDecoder, isLegionI8Header } from './activationWireI8.js';

export type LegionWireDtype = 'f32' | 'f16' | 'i8';

export interface LegionActivationWireEncoder {
  headerBytes(): Uint8Array;
  encodeFrame(activations: Float32Array, meta: WireFrameMeta): Uint8Array;
}

export interface LegionActivationWireDecoder {
  readonly modelId: string;
  readonly nEmbd: number;
  readonly dtype: LegionWireDtype;
  decodeFrameBytes(bytes: Uint8Array): DecodedWireFrame;
}

export interface LegionActivationWireOptions {
  modelId: string;
  stageIndex: number;
  nEmbd: number;
  dtype: LegionWireDtype;
  /** i8-only — see `activationWireI8.ts`'s `I8EncoderOptions.delta` doc
   * comment. Ignored for `'f32'`/`'f16'`. Default `true`. */
  i8Delta?: boolean;
}

/** `ActivationWireEncoder`/`I8ActivationWireEncoder` are already
 * structurally compatible with `LegionActivationWireEncoder` (same two
 * members, same signatures) — no adapter object needed, TypeScript's
 * structural typing accepts either return value directly. Same for the
 * decoder types below. */
export function createLegionActivationWireEncoder(opts: LegionActivationWireOptions): LegionActivationWireEncoder {
  if (opts.dtype === 'i8') {
    return createI8ActivationWireEncoder({ modelId: opts.modelId, stageIndex: opts.stageIndex, nEmbd: opts.nEmbd, delta: opts.i8Delta });
  }
  return createActivationWireEncoder({ modelId: opts.modelId, stageIndex: opts.stageIndex, nEmbd: opts.nEmbd, dtype: opts.dtype });
}

/**
 * Dispatches on the HEADER's own shape, not a caller-supplied hint — the
 * header bytes are the first (and only) thing available when a receiver
 * needs to build a decoder, exactly mirroring how
 * `createActivationWireDecoder` itself works (dtype comes from the
 * decoded header, never a parameter). `isLegionI8Header` peeks the
 * header's `wireCodec` marker field; the upstream codec's header shape
 * never has that field, so a false-positive match is not possible short
 * of a spoofed/malicious frame — no different a trust boundary than any
 * other wire content in this protocol.
 */
export function createLegionActivationWireDecoder(headerBytes: Uint8Array): LegionActivationWireDecoder {
  if (isLegionI8Header(headerBytes)) {
    return createI8ActivationWireDecoder(headerBytes);
  }
  return createActivationWireDecoder(headerBytes);
}

// Re-exported so callers that only need the encoder/decoder SHAPE (e.g.
// stageOrchestrator.ts's `encoder: LegionActivationWireEncoder | undefined`
// field) don't also need to import stage-runtime's type directly.
export type { ActivationWireEncoder, ActivationWireDecoder };

/**
 * Planning-only byte-size ESTIMATE (raw element bytes, no msgpack/envelope
 * overhead — same level of approximation `communalTopology.ts`'s existing
 * `(wireDtype === 'f16' ? 2 : 4) * nEmbd` hop-cost estimate already uses)
 * for capacity/hop-cost math in `stagePlanner.ts`/`stagePipelinePlanning.ts`.
 * Delegates to `@unstable-legion/stage-runtime`'s own `activationBytes` for
 * `'f32'`/`'f16'` (that package's `ActivationDtype` type has no `'i8'`
 * member to delegate to, so this repo's `'i8'` case is computed locally:
 * 1 byte/element, matching this module's own symmetric-int8 wire shape).
 */
export function legionActivationBytes(tokenCount: number, nEmbd: number, dtype: LegionWireDtype): number {
  if (dtype === 'i8') return tokenCount * nEmbd;
  return activationBytesUpstream(tokenCount, nEmbd, dtype);
}
