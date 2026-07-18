/**
 * Phase 2 — int8 activation wire, entirely self-contained inside mesh-core.
 *
 * WHY NOT EXTEND @unstable-legion/stage-runtime OR @codecai/web: both are
 * external repos this workstream is explicitly forbidden from touching
 * (legion-stage-runtime is a pinned read-only sibling checkout;
 * `@codecai/web` — `codec-local` — is a whole separate product with its
 * own consumers, well outside this task's blast radius). Their `WireDtype`
 * type is `Extract<ActivationDtype, 'f32' | 'f16'>` and their
 * `ActivationStreamEncoder`'s raw pipeline treats `dtype: 'int8'` as a
 * NAIVE 1:1 round-and-clamp to [-128,127] with no scale factor at all —
 * useless for real transformer activations, whose magnitude varies wildly
 * per token and would either clip to nothing or waste the whole int8
 * range on a handful of outlier elements.
 *
 * Since BOTH ends of an `i8` route (the driver's `stageOrchestrator.ts`
 * and the host's `useStageHost.ts`) are code this repo owns, there's no
 * need to speak the upstream codec's wire format for this dtype at all —
 * only mesh-core's own driver and host ever need to agree on it. This
 * module implements a minimal, purpose-built symmetric int8 codec with a
 * PER-TOKEN-ROW abs-max scale (one scale per token in the frame — for the
 * hot decode-step path, tokenCount is always 1, so this is effectively
 * "per-frame"; for a multi-token prefill chunk, per-row preserves far more
 * precision than one scale for the whole chunk would, since different
 * tokens' activation magnitudes vary).
 *
 * Wire shape (msgpack, mirroring the shape `LatentFrame`/`LatentStreamHeader`
 * carry in the f32/f16 path closely enough that a future point release
 * could fold this into that codec if `@codecai/web` ever grows a real
 * per-row-adaptive activation pipeline):
 *
 *   Header: { wireCodec: 'legion-i8-v1', modelId, nEmbd }
 *   Frame:  { seq, done, finish_reason?, tokenCount, posStart?, tokens?,
 *             stageIndex?, keyframe: boolean, scales: number[] (length
 *             tokenCount, one per-token abs-max), data: Uint8Array
 *             (Int8Array bytes, length tokenCount * nEmbd) }
 *
 * Dequantization (keyframe): `activation[t*nEmbd+i] = data[t*nEmbd+i] * (scales[t] / 127)`.
 *
 * ── Delta pre-pass (decode-step frames only) ────────────────────────────
 *
 * `tokenCount > 1` frames (prefill chunks) are ALWAYS keyframes — there's
 * no clean per-row temporal analog across a multi-token batch. A
 * `tokenCount === 1` frame (the hot decode-step path) is a keyframe only
 * when the encoder/decoder has no prior decode-step state (session start,
 * or the first decode step after a prefill/replan); every subsequent
 * decode-step frame in the streak is a DELTA: its `data` is a saturating
 * int8 residual against the ORIGINAL KEYFRAME's quantized bytes (not the
 * immediately-previous frame), quantized using the keyframe's OWN fixed
 * scale (not a fresh per-frame abs-max) — `q_i = quantize(activation_i,
 * keyframeScale)`, wire carries `residual_i = saturatingDiff(q_i,
 * keyframeQ, 127)`, reconstruction is `q_i = saturatingAdd(keyframeQ,
 * residual_i, 127)` then the normal dequantize. This mirrors
 * `@codecai/web`'s own `delta+int8` LATENT pipeline precedent exactly
 * (see `node_modules/@codecai/web/src/latent-frame.ts`'s `encodePipeline`/
 * `decodeFrame` for `p === 'delta+int8'`) — deliberately NOT a literal
 * "delta vs the immediately-previous frame" chain: anchoring every delta
 * to the fixed keyframe means a single lost/corrupted delta frame can't
 * propagate corruption into every frame after it, since each delta is
 * independently reconstructible from (keyframe, thisResidual) alone.
 * Verified safe to add given this repo's actual wire protocol: `sf`
 * traffic is already lockstep request/response (the driver's
 * `sendFrameAndAwaitToken` never sends frame N+1 before frame N's
 * `stage.token` reply arrives — see `stageOrchestrator.ts`), so there is
 * no reordering hazard to guard against, and a replan already discards the
 * old encoder/decoder pair and builds a fresh one, naturally resetting any
 * delta streak at exactly the same boundary a KV-cache reset happens.
 * Delta by itself does NOT shrink wire bytes (a residual is still 1
 * byte/element, same as a fresh keyframe) — its entire value is enabling a
 * downstream entropy coder (deflate) to compress runs of near-zero
 * residuals better than raw quantized noise. See `measureDeflateRatio`
 * below and docs/WIRE-DTYPE.md's Phase 2 section for the measured verdict
 * on whether that actually pays off for this data.
 *
 * `createLegionActivationWireEncoder`/`createLegionActivationWireDecoder`
 * (activationWireCodec.ts) dispatch to this module for `dtype === 'i8'`
 * and to `@unstable-legion/stage-runtime`'s codec for `'f32'`/`'f16'` —
 * `stageOrchestrator.ts`/`useStageHost.ts` call ONLY the dispatcher, never
 * this module directly, so they stay dtype-agnostic.
 */
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import type { WireFrameMeta, DecodedWireFrame } from '@unstable-legion/stage-runtime';

export const LEGION_I8_CODEC_MARKER = 'legion-i8-v1';

export interface I8ActivationWireEncoder {
  headerBytes(): Uint8Array;
  encodeFrame(activations: Float32Array, meta: WireFrameMeta): Uint8Array;
}

export interface I8ActivationWireDecoder {
  readonly modelId: string;
  readonly nEmbd: number;
  readonly dtype: 'i8';
  decodeFrameBytes(bytes: Uint8Array): DecodedWireFrame;
}

interface I8Header {
  wireCodec: typeof LEGION_I8_CODEC_MARKER;
  modelId: string;
  nEmbd: number;
}

interface I8FrameWire {
  seq: number;
  done: boolean;
  finish_reason?: string;
  tokenCount: number;
  posStart?: number;
  tokens?: number[];
  stageIndex?: number;
  /** `true` — `data`/`scales` are a full quantization. `false` — `data` is
   * a saturating int8 RESIDUAL against the current decode-step streak's
   * keyframe (see this module's doc comment); `scales` still carries the
   * (fixed, keyframe-inherited) scale so the decoder never needs its own
   * separate side-channel for it. Always `true` when `tokenCount > 1`. */
  keyframe: boolean;
  /** Per-token abs-max (keyframe) or the keyframe's inherited scale
   * (delta) — length === tokenCount. */
  scales: number[];
  /** Int8Array bytes: a full quantization (keyframe) or a saturating
   * residual against the streak's keyframe (delta) — length ===
   * tokenCount * nEmbd either way. */
  data: Uint8Array;
}

/** True when `headerBytes` is this module's own header shape — lets
 * `activationWireCodec.ts` dispatch WITHOUT needing to know the dtype
 * ahead of time (the header IS the first thing decoded). */
export function isLegionI8Header(bytes: Uint8Array): boolean {
  try {
    const obj = msgpackDecode(bytes) as Record<string, unknown>;
    return !!obj && typeof obj === 'object' && obj.wireCodec === LEGION_I8_CODEC_MARKER;
  } catch {
    return false;
  }
}

// ── Quantize / dequantize ───────────────────────────────────────────────

/** Symmetric per-row (per-token) int8 quantization: each token's
 * nEmbd-wide row is scaled independently by its own abs-max so a
 * high-magnitude token doesn't blow the quantization step for every other
 * token in the same frame. maxQ=127 (not 128) keeps the mapping symmetric
 * — matches the convention `@codecai/web`'s own `quantizeSymmetric` uses
 * for its (unrelated, latent-profile) adaptive pipelines. */
function quantizeRows(activations: Float32Array, tokenCount: number, nEmbd: number): { data: Uint8Array; scales: number[] } {
  const q = new Int8Array(activations.length);
  const scales: number[] = new Array(tokenCount);
  for (let t = 0; t < tokenCount; t++) {
    const off = t * nEmbd;
    let m = 0;
    for (let i = 0; i < nEmbd; i++) {
      const a = Math.abs(activations[off + i]!);
      if (a > m) m = a;
    }
    scales[t] = m;
    const inv = m > 0 ? 127 / m : 0;
    for (let i = 0; i < nEmbd; i++) {
      const r = Math.round(activations[off + i]! * inv);
      q[off + i] = r > 127 ? 127 : r < -127 ? -127 : r;
    }
  }
  return { data: new Uint8Array(q.buffer, q.byteOffset, q.byteLength), scales };
}

function dequantizeRows(data: Uint8Array, scales: readonly number[], tokenCount: number, nEmbd: number): Float32Array {
  const q = new Int8Array(data.buffer, data.byteOffset, data.byteLength);
  const out = new Float32Array(tokenCount * nEmbd);
  for (let t = 0; t < tokenCount; t++) {
    const off = t * nEmbd;
    const factor = (scales[t] ?? 0) / 127;
    for (let i = 0; i < nEmbd; i++) out[off + i] = q[off + i]! * factor;
  }
  return out;
}

/** Quantize a SINGLE token row (nEmbd elements) against an EXPLICIT
 * (already-known) scale — the delta path's building block: a decode-step
 * frame past the first in a streak reuses the keyframe's scale rather than
 * computing a fresh abs-max, so its quantized bytes are directly
 * diffable against the keyframe's. */
function quantizeRowWithScale(activation: Float32Array, scale: number, nEmbd: number): Int8Array {
  const q = new Int8Array(nEmbd);
  const inv = scale > 0 ? 127 / scale : 0;
  for (let i = 0; i < nEmbd; i++) {
    const r = Math.round(activation[i]! * inv);
    q[i] = r > 127 ? 127 : r < -127 ? -127 : r;
  }
  return q;
}

/** Symmetric saturating int8 diff/add — same shape as
 * `@codecai/web`'s (unrelated, latent-profile) `saturatingDiff`/
 * `saturatingAdd`, reimplemented here in a few lines rather than reaching
 * into that package's internals (not exported, and out of scope to touch
 * either way — see this module's top doc comment). */
function saturatingDiffI8(a: Int8Array, b: Int8Array): Int8Array {
  const out = new Int8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    out[i] = d > 127 ? 127 : d < -127 ? -127 : d;
  }
  return out;
}
function saturatingAddI8(a: Int8Array, b: Int8Array): Int8Array {
  const out = new Int8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const s = a[i]! + b[i]!;
    out[i] = s > 127 ? 127 : s < -127 ? -127 : s;
  }
  return out;
}

/** View an `Int8Array`'s bytes as a `Uint8Array` without copying — same
 * buffer/byteOffset/byteLength reinterpretation `quantizeRows` already uses
 * for its own `data` field; needed wherever a saturating diff/add result
 * (typed `Int8Array` — signed arithmetic) is stored into `I8FrameWire.data`
 * or handed to `dequantizeRows` (both typed `Uint8Array`, matching the wire
 * shape's actual byte payload). */
function i8AsU8(bytes: Int8Array): Uint8Array {
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// ── Encoder / decoder ────────────────────────────────────────────────────

export interface I8ActivationWireOptions {
  modelId: string;
  stageIndex: number;
  nEmbd: number;
}

export interface I8EncoderOptions extends I8ActivationWireOptions {
  /** Enable the decode-step delta pre-pass (see this module's top doc
   * comment). Default `true` — the wire protocol's lockstep
   * request/response discipline makes it safe, and it costs nothing when
   * `deflate` isn't also enabled downstream (a delta frame is the same
   * byte length as a keyframe; this flag exists mainly so tests/measurement
   * code can isolate "keyframe-only" behavior for an apples-to-apples
   * byte-size comparison). */
  delta?: boolean;
}

export function createI8ActivationWireEncoder(opts: I8EncoderOptions): I8ActivationWireEncoder {
  if (!Number.isInteger(opts.nEmbd) || opts.nEmbd <= 0) {
    throw new RangeError(`nEmbd must be a positive integer, got ${opts.nEmbd}`);
  }
  const deltaEnabled = opts.delta ?? true;
  let lastSeq = -1;
  // Decode-step delta-streak state — see this module's top doc comment.
  // Only ever populated from a tokenCount===1 frame; a prefill frame
  // (tokenCount>1) neither reads nor writes it, so the decode-step frame
  // immediately following a prefill always starts a fresh keyframe.
  let streakKeyframeQ: Int8Array | undefined;
  let streakKeyframeScale = 0;

  return {
    headerBytes: () => msgpackEncode({ wireCodec: LEGION_I8_CODEC_MARKER, modelId: opts.modelId, nEmbd: opts.nEmbd } satisfies I8Header),
    encodeFrame: (activations, meta) => {
      if (activations.length % opts.nEmbd !== 0) {
        throw new RangeError(`activations length ${activations.length} is not a multiple of nEmbd ${opts.nEmbd}`);
      }
      if (meta.seq <= lastSeq) {
        throw new Error(`seq must be monotonically increasing; got ${meta.seq} after ${lastSeq}`);
      }
      lastSeq = meta.seq;
      const tokenCount = activations.length / opts.nEmbd;
      if (meta.tokens !== undefined && meta.tokens.length !== tokenCount) {
        throw new Error(`tokens length ${meta.tokens.length} does not match derived tokenCount ${tokenCount}`);
      }

      let keyframe: boolean;
      let scales: number[];
      let data: Uint8Array;

      if (tokenCount > 1) {
        // Prefill chunk — always a keyframe, and never participates in the
        // decode-step streak (see field doc comments above).
        const q = quantizeRows(activations, tokenCount, opts.nEmbd);
        keyframe = true;
        scales = q.scales;
        data = q.data;
        streakKeyframeQ = undefined;
      } else if (!deltaEnabled || !streakKeyframeQ) {
        // Fresh keyframe: session start, or the first decode step after a
        // prefill/replan (streakKeyframeQ was just cleared, or never set).
        const q = quantizeRows(activations, 1, opts.nEmbd);
        keyframe = true;
        scales = q.scales;
        data = q.data;
        streakKeyframeQ = new Int8Array(q.data.buffer, q.data.byteOffset, q.data.byteLength);
        streakKeyframeScale = q.scales[0]!;
      } else {
        // Delta: quantize against the streak's FIXED keyframe scale, wire
        // the saturating residual against the streak's FIXED keyframe
        // bytes (not the previous delta frame — see top doc comment).
        const qNow = quantizeRowWithScale(activations, streakKeyframeScale, opts.nEmbd);
        keyframe = false;
        scales = [streakKeyframeScale];
        data = i8AsU8(saturatingDiffI8(qNow, streakKeyframeQ));
      }

      const frame: I8FrameWire = {
        seq: meta.seq,
        done: meta.done ?? false,
        finish_reason: meta.finishReason,
        tokenCount,
        posStart: meta.posStart,
        tokens: meta.tokens ? [...meta.tokens] : undefined,
        stageIndex: opts.stageIndex,
        keyframe,
        scales,
        data,
      };
      return msgpackEncode(frame);
    },
  };
}

export function createI8ActivationWireDecoder(headerBytes: Uint8Array): I8ActivationWireDecoder {
  const header = msgpackDecode(headerBytes) as I8Header;
  if (!header || header.wireCodec !== LEGION_I8_CODEC_MARKER) {
    throw new Error(`expected a legion-i8 activation header, got ${JSON.stringify(header)}`);
  }
  if (!Number.isInteger(header.nEmbd) || header.nEmbd <= 0) {
    throw new Error(`i8 activation header requires a positive integer nEmbd; got ${header.nEmbd}`);
  }
  // Mirrors the encoder's decode-step streak state exactly — see this
  // module's top doc comment. A delta frame is meaningless without it
  // (there is nothing to reconstruct against).
  let streakKeyframeQ: Int8Array | undefined;

  return {
    modelId: header.modelId,
    nEmbd: header.nEmbd,
    dtype: 'i8',
    decodeFrameBytes: (bytes) => {
      const frame = msgpackDecode(bytes) as I8FrameWire;
      if (typeof frame.tokenCount !== 'number') {
        throw new Error('i8 activation frame is missing required field: tokenCount');
      }
      const expectedBytes = frame.tokenCount * header.nEmbd;
      if (frame.data.length !== expectedBytes) {
        throw new Error(
          `i8 activation frame payload length ${frame.data.length} does not match ` +
            `tokenCount(${frame.tokenCount}) * nEmbd(${header.nEmbd}) = ${expectedBytes}`,
        );
      }

      let activations: Float32Array;
      if (frame.tokenCount > 1) {
        // Prefill chunk — always a keyframe, never touches streak state.
        activations = dequantizeRows(frame.data, frame.scales, frame.tokenCount, header.nEmbd);
        streakKeyframeQ = undefined;
      } else if (frame.keyframe) {
        activations = dequantizeRows(frame.data, frame.scales, 1, header.nEmbd);
        streakKeyframeQ = new Int8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
      } else {
        if (!streakKeyframeQ) {
          throw new Error(
            `i8 delta frame (seq=${frame.seq}) arrived with no prior keyframe in this decode-step streak — ` +
              'a frame was likely lost; the driver should replan rather than the decoder guessing',
          );
        }
        const qNow = saturatingAddI8(streakKeyframeQ, new Int8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength));
        activations = dequantizeRows(i8AsU8(qNow), frame.scales, 1, header.nEmbd);
        // Deliberately does NOT update streakKeyframeQ to qNow — every
        // delta in the streak reconstructs against the SAME original
        // keyframe (see top doc comment's robustness rationale), so the
        // keyframe reference stays fixed until the next real keyframe.
      }

      return {
        activations,
        tokenCount: frame.tokenCount,
        seq: frame.seq,
        done: frame.done,
        posStart: frame.posStart,
        tokens: frame.tokens,
        stageIndex: frame.stageIndex,
        finishReason: frame.finish_reason,
      };
    },
  };
}

// ── Deflate-gain measurement (evaluation only — NOT wired into the wire
//    path by default; see docs/WIRE-DTYPE.md's Phase 2 section for the
//    measured verdict) ────────────────────────────────────────────────────

export interface DeflateGainResult {
  originalBytes: number;
  compressedBytes: number;
  /** `1 - compressedBytes/originalBytes` — e.g. 0.10 = "10% smaller". */
  gainFraction: number;
}

/**
 * Measures how much `CompressionStream('deflate-raw')` shrinks `bytes` —
 * used to answer the Phase 2 brief's "measure whether it helps on int8
 * data; skip if <10% gain" question with REAL numbers instead of a guess.
 * `deflate-raw` (no zlib/gzip header) is what Chrome supports natively in
 * a worker context per docs/DISTRIBUTION.md's Phase D note; zstd isn't
 * available in a browser at all.
 *
 * Deliberately NOT called anywhere on the hot encode/decode path — this is
 * an offline measurement tool (unit tests, or an e2e spec logging real
 * captured wire bytes), because compressing+decompressing every frame
 * twice (once to measure, once for real) would itself be wasted work if
 * the answer turns out to be "skip it".
 */
export async function measureDeflateGain(bytes: Uint8Array): Promise<DeflateGainResult> {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  // `Uint8Array<ArrayBufferLike>` (the default `Uint8Array` type) isn't
  // structurally a `BufferSource` in TS's DOM lib (which requires
  // `ArrayBufferView<ArrayBuffer>`, excluding a `SharedArrayBuffer`-backed
  // view) — this module never hands out a SharedArrayBuffer-backed view,
  // so the cast is safe.
  void writer.write(bytes as Uint8Array<ArrayBuffer>).then(() => writer.close());
  const compressed = await new Response(cs.readable).arrayBuffer();
  const compressedBytes = compressed.byteLength;
  return {
    originalBytes: bytes.byteLength,
    compressedBytes,
    gainFraction: bytes.byteLength > 0 ? 1 - compressedBytes / bytes.byteLength : 0,
  };
}
