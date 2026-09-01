/**
 * P1 — session-state snapshots, so a stage can move between peers.
 *
 * Churn is already handled and already correct. `onPeerLeave` feeds the
 * roster, `stageOrchestrator.ts` aborts on host death, graceful leave or
 * stall, and the driver recovers with a continue-from-history replan
 * against a fresh session. A conversation survives a peer dropping today.
 *
 * What it does not survive cheaply. Continue-from-history rebuilds the lost
 * stage's KV cache by re-prefilling the entire conversation. Every churn
 * event costs a full prefill and that cost grows with the context. This
 * module is the cheaper path for the cases where it is cheaper: move the
 * state instead of recomputing it, and fall back to the replan that already
 * works whenever moving it is not worth the bytes. `planSnapshotHandoff`
 * below is exactly that decision, and its `reprefill` verdict means "use
 * the existing continue-from-history path", never "give up".
 *
 * Every prior use of the word "snapshot" in this package means a roster
 * snapshot, which is a different thing entirely.
 *
 * The shape here is lifted from colibrì's `c/segment_runtime.h`, which
 * solved the same problem for a native segment host (docs/segment-runtime.md
 * in JustVugg/colibri, and the review in
 * `docs/colibri-mesh-llm-integration-plan.md`). Two ideas are worth
 * copying exactly:
 *
 *   1. **The restore gate is an identity, not a version number.** A
 *      snapshot is compatible only when the model identity, the state
 *      schema, the numeric class and the segment range all match. colibrì
 *      keeps the snapshot format private to an adapter and tells the
 *      network layer to "put those fields in its own snapshot envelope
 *      before accepting a restore". That envelope is what this module is.
 *      `numericClass` is the load-bearing one: two peers running different
 *      precisions or different reduction orders produce states that are
 *      individually valid and mutually useless, and nothing about the
 *      bytes reveals it.
 *
 *   2. **Snapshots stream.** colibrì's callbacks emit bytes in pieces "so
 *      neither side needs a second full-state allocation". A KV cache for
 *      a handful of layers is tens to hundreds of megabytes; a browser tab
 *      that has to hold the whole thing twice to hand it over is a tab
 *      that will not hand it over. `encodeSnapshotChunk` frames one piece
 *      at a time over the existing `sf` binary action.
 *
 * Recurrent and hybrid families make this mechanism 100x to 660x more
 * expensive (mesh-llm's mobility table puts Falcon-H1 at 663.5x and RWKV6
 * at 112.5x its baseline) and they do not change its shape. Dense
 * transformers need it first, which is why this milestone is dense-only.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const MAX_ID_BYTES = 0xffff;

/**
 * The compatibility identity a restore is gated on. Every field must match
 * between the snapshot and the peer adopting it.
 */
export interface SnapshotIdentity {
  /** Model the session is running. */
  modelId: string;
  /**
   * Identifies the activation and snapshot layout. Two builds sharing a
   * `stateSchema` agree on what the bytes mean.
   */
  stateSchema: string;
  /**
   * Identifies builds whose results AND snapshots are interchangeable. A
   * stage runtime must fold every precision, reduction-order and backend
   * rule that affects its numbers into this string. Two peers on the same
   * `stateSchema` but different `numericClass` produce states that decode
   * cleanly and generate divergent tokens, which is the failure this field
   * exists to make impossible.
   */
  numericClass: string;
  /** Inclusive first layer of the segment this state belongs to. */
  layerStart: number;
  /** Exclusive last layer of the segment. */
  layerEnd: number;
}

export interface SessionSnapshotEnvelope extends SnapshotIdentity {
  /** Session the state was captured from. */
  sessionId: string;
  /**
   * Decode steps completed at capture time. The adopting peer resumes at
   * this position, and the driver uses it to decide whether a snapshot is
   * fresher than a re-prefill would be.
   */
  tokensDecoded: number;
  /** Total snapshot payload size across every chunk. */
  totalBytes: number;
  /** Number of chunks the payload was split into. */
  chunkCount: number;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

export function isSnapshotIdentity(x: unknown): x is SnapshotIdentity {
  if (!isRecord(x)) return false;
  if (!isNonEmptyString(x.modelId)) return false;
  if (!isNonEmptyString(x.stateSchema)) return false;
  if (!isNonEmptyString(x.numericClass)) return false;
  if (!Number.isInteger(x.layerStart) || (x.layerStart as number) < 0) return false;
  if (!Number.isInteger(x.layerEnd) || (x.layerEnd as number) <= (x.layerStart as number)) return false;
  return true;
}

export function isSessionSnapshotEnvelope(x: unknown): x is SessionSnapshotEnvelope {
  if (!isSnapshotIdentity(x)) return false;
  const r = x as unknown as Record<string, unknown>;
  if (!isNonEmptyString(r.sessionId)) return false;
  if (!Number.isInteger(r.tokensDecoded) || (r.tokensDecoded as number) < 0) return false;
  if (!Number.isInteger(r.totalBytes) || (r.totalBytes as number) < 0) return false;
  if (!Number.isInteger(r.chunkCount) || (r.chunkCount as number) < 0) return false;
  // A zero-length payload must arrive in zero chunks, and a non-empty one
  // in at least one. Anything else is a truncated or padded transfer.
  const empty = (r.totalBytes as number) === 0;
  if (empty !== ((r.chunkCount as number) === 0)) return false;
  return true;
}

/** Why a restore was refused. `null` reason means it was accepted. */
export type RestoreRefusal =
  | 'model-mismatch'
  | 'state-schema-mismatch'
  | 'numeric-class-mismatch'
  | 'range-mismatch';

export interface RestoreVerdict {
  ok: boolean;
  reason: RestoreRefusal | null;
  /** Human-readable detail, for logs and for `stage.restore.ack`. */
  detail: string;
}

const ACCEPTED: RestoreVerdict = { ok: true, reason: null, detail: 'compatible' };

/**
 * colibrì's restore gate. A snapshot is adoptable only when the model, the
 * state schema, the numeric class and the exact segment range all match.
 *
 * Range equality is deliberate rather than containment. A peer holding
 * layers 8 to 24 cannot adopt a snapshot captured over layers 8 to 16 even
 * though it owns every one of those layers, because the state is a cache
 * of a specific stack of layers and the missing half was never computed.
 * Splitting or merging a range means re-prefilling, and this function's
 * job is to refuse rather than to paper over that.
 */
export function snapshotRestoreVerdict(
  snapshot: SnapshotIdentity,
  target: SnapshotIdentity,
): RestoreVerdict {
  if (snapshot.modelId !== target.modelId) {
    return {
      ok: false,
      reason: 'model-mismatch',
      detail: `snapshot is ${snapshot.modelId}, target runs ${target.modelId}`,
    };
  }
  if (snapshot.stateSchema !== target.stateSchema) {
    return {
      ok: false,
      reason: 'state-schema-mismatch',
      detail: `snapshot schema ${snapshot.stateSchema}, target schema ${target.stateSchema}`,
    };
  }
  if (snapshot.numericClass !== target.numericClass) {
    return {
      ok: false,
      reason: 'numeric-class-mismatch',
      detail: `snapshot numeric class ${snapshot.numericClass}, target ${target.numericClass}`,
    };
  }
  if (snapshot.layerStart !== target.layerStart || snapshot.layerEnd !== target.layerEnd) {
    return {
      ok: false,
      reason: 'range-mismatch',
      detail: `snapshot covers [${snapshot.layerStart},${snapshot.layerEnd}), target covers [${target.layerStart},${target.layerEnd})`,
    };
  }
  return ACCEPTED;
}

// ── Chunk framing ───────────────────────────────────────────────────────

/**
 * Wire shape, little-endian, mirroring `stageFrameEnvelope.ts` so both
 * binary channels stay readable by the same eye:
 *
 *   [uint16 sessionId len][sessionId UTF-8][uint32 chunkIndex]
 *   [uint32 chunkCount][opaque chunk bytes]
 *
 * The index and count travel on every chunk rather than in a preamble so a
 * receiver can size its reassembly buffer from the first piece that
 * arrives, in any order, and can detect a short transfer without a
 * timeout.
 */
export interface SnapshotChunk {
  sessionId: string;
  chunkIndex: number;
  chunkCount: number;
  bytes: Uint8Array;
}

const HEADER_FIXED_BYTES = 2 + 4 + 4;

export function encodeSnapshotChunk(chunk: SnapshotChunk): Uint8Array {
  const idBytes = textEncoder.encode(chunk.sessionId);
  if (idBytes.byteLength === 0) {
    throw new RangeError('sessionId must not be empty');
  }
  if (idBytes.byteLength > MAX_ID_BYTES) {
    throw new RangeError(`sessionId too long to envelope (${idBytes.byteLength} bytes, max ${MAX_ID_BYTES})`);
  }
  if (!Number.isInteger(chunk.chunkCount) || chunk.chunkCount <= 0) {
    throw new RangeError('chunkCount must be a positive integer');
  }
  if (!Number.isInteger(chunk.chunkIndex) || chunk.chunkIndex < 0 || chunk.chunkIndex >= chunk.chunkCount) {
    throw new RangeError(`chunkIndex ${chunk.chunkIndex} out of range for chunkCount ${chunk.chunkCount}`);
  }
  const out = new Uint8Array(HEADER_FIXED_BYTES + idBytes.byteLength + chunk.bytes.byteLength);
  const view = new DataView(out.buffer);
  view.setUint16(0, idBytes.byteLength, true);
  out.set(idBytes, 2);
  view.setUint32(2 + idBytes.byteLength, chunk.chunkIndex, true);
  view.setUint32(6 + idBytes.byteLength, chunk.chunkCount, true);
  out.set(chunk.bytes, HEADER_FIXED_BYTES + idBytes.byteLength);
  return out;
}

/**
 * Returns `null` on anything malformed, matching `decodeStageControl` and
 * `decodeStageFrameEnvelope`. Snapshot traffic arrives from a peer that
 * may be mid-teardown, and a truncated final chunk must not throw inside
 * the receiver's frame loop.
 */
export function decodeSnapshotChunk(bytes: Uint8Array): SnapshotChunk | null {
  if (bytes.byteLength < HEADER_FIXED_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLen = view.getUint16(0, true);
  if (idLen === 0 || bytes.byteLength < HEADER_FIXED_BYTES + idLen) return null;
  let sessionId: string;
  try {
    sessionId = textDecoder.decode(bytes.subarray(2, 2 + idLen));
  } catch {
    return null;
  }
  if (!sessionId) return null;
  const chunkIndex = view.getUint32(2 + idLen, true);
  const chunkCount = view.getUint32(6 + idLen, true);
  if (chunkCount === 0 || chunkIndex >= chunkCount) return null;
  return {
    sessionId,
    chunkIndex,
    chunkCount,
    bytes: bytes.subarray(HEADER_FIXED_BYTES + idLen),
  };
}

/**
 * Reassembles chunks arriving in any order without holding a second copy
 * of the finished state. Chunks are retained by reference until the set is
 * complete, and `take()` concatenates once and drops them.
 */
export class SnapshotReassembler {
  private readonly parts = new Map<number, Uint8Array>();
  private expected: number | null = null;

  /** Returns false if the chunk contradicts what is already held. */
  accept(chunk: SnapshotChunk): boolean {
    if (this.expected === null) {
      this.expected = chunk.chunkCount;
    } else if (this.expected !== chunk.chunkCount) {
      return false;
    }
    if (chunk.chunkIndex >= this.expected) return false;
    this.parts.set(chunk.chunkIndex, chunk.bytes);
    return true;
  }

  get complete(): boolean {
    return this.expected !== null && this.parts.size === this.expected;
  }

  get receivedBytes(): number {
    let n = 0;
    for (const p of this.parts.values()) n += p.byteLength;
    return n;
  }

  /** Concatenate and reset. Returns null while chunks are still missing. */
  take(): Uint8Array | null {
    if (!this.complete || this.expected === null) return null;
    const out = new Uint8Array(this.receivedBytes);
    let offset = 0;
    for (let i = 0; i < this.expected; i++) {
      const part = this.parts.get(i);
      if (!part) return null;
      out.set(part, offset);
      offset += part.byteLength;
    }
    this.parts.clear();
    this.expected = null;
    return out;
  }
}

// ── Handoff policy ──────────────────────────────────────────────────────

export interface HandoffDecision {
  action: 'restore' | 'reprefill';
  /** Why, in words, for logs and telemetry. */
  reason: string;
  /**
   * Decode steps the adopting peer must replay after restoring. Zero when
   * the snapshot is current. Meaningless when the action is `reprefill`,
   * where the whole context is replayed by definition.
   */
  replaySteps: number;
}

export interface HandoffOptions {
  /**
   * Minimum decode steps a restore must save before it is worth the
   * transfer. Below this the snapshot costs more to ship than the replay
   * it avoids. Defaults to 16, which is deliberately conservative until
   * there are measured transfer numbers to set it from.
   */
  minStepsSaved?: number;
}

const DEFAULT_MIN_STEPS_SAVED = 16;

/**
 * Decide whether a departing host's snapshot is worth adopting, or whether
 * the replacement should re-prefill from the conversation history.
 *
 * Restoring is not automatically better. A snapshot captured twenty tokens
 * into a two-thousand-token conversation saves almost nothing and still
 * costs a full state transfer over WebRTC, so this returns `reprefill` for
 * it. The mesh already knows how to re-prefill; that path is the fallback
 * and it always works.
 *
 * A snapshot from ahead of the current position is treated as garbage
 * rather than clamped. It means the driver's position and the host's
 * disagree, and guessing which is right would silently corrupt a
 * conversation.
 */
export function planSnapshotHandoff(
  snapshot: SessionSnapshotEnvelope | null,
  target: SnapshotIdentity,
  currentTokens: number,
  opts: HandoffOptions = {},
): HandoffDecision {
  const minStepsSaved = opts.minStepsSaved ?? DEFAULT_MIN_STEPS_SAVED;

  if (!snapshot) {
    return { action: 'reprefill', reason: 'no snapshot available', replaySteps: 0 };
  }
  const verdict = snapshotRestoreVerdict(snapshot, target);
  if (!verdict.ok) {
    return { action: 'reprefill', reason: verdict.detail, replaySteps: 0 };
  }
  if (snapshot.totalBytes === 0) {
    return { action: 'reprefill', reason: 'snapshot carries no state', replaySteps: 0 };
  }
  if (snapshot.tokensDecoded > currentTokens) {
    return {
      action: 'reprefill',
      reason: `snapshot is ahead of the session (${snapshot.tokensDecoded} > ${currentTokens})`,
      replaySteps: 0,
    };
  }
  if (snapshot.tokensDecoded < minStepsSaved) {
    return {
      action: 'reprefill',
      reason: `snapshot saves only ${snapshot.tokensDecoded} steps, below the ${minStepsSaved} threshold`,
      replaySteps: 0,
    };
  }
  return {
    action: 'restore',
    reason: `snapshot covers ${snapshot.tokensDecoded} of ${currentTokens} steps`,
    replaySteps: currentTokens - snapshot.tokensDecoded,
  };
}
