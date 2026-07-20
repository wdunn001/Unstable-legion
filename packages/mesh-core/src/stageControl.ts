/**
 * Phase C — stage-control messages for pipeline-split inference, carried
 * over the EXISTING `tc` Trystero action (no new control-plane action —
 * unlike the legion-stage-runtime harness's Phase B PoC, which used a
 * dedicated `sc` action; mesh-core reuses `tc` + `PendingToolCallTracker`
 * + `newCallId` from `tools.ts` so a stage session is just another kind
 * of tool traffic on the wire a v1 peer already understands).
 *
 * Ports the harness's proven Phase B protocol shapes
 * (H:\dev\legion-stage-runtime\harness\src\p2p\control.ts) — same seven
 * message kinds, same request/response correlation discipline — onto the
 * `MeshToolFrame` union instead of a bespoke `ControlMessage` union:
 *
 *   - "request" kinds (stage.load, stage.ping, stage.stop) encode as
 *     `{kind: 'call', toolName: <kind>, args: <payload>}`.
 *   - "response/push" kinds (stage.ready, stage.pong, stage.progress,
 *     stage.token) encode as `{kind: 'result', status: 'ok', result:
 *     {stageKind: <kind>, payload}}`.
 *
 * `stage.token` has no preceding `tc` call — a decode step is triggered
 * by an `sf` activation frame, not a tool call — so the driver mints a
 * callId per decode step (`stageTokenCallId(seq)`) and the responding
 * host echoes that same callId on its `stage.token` result. This mirrors
 * the harness's `tokenTracker.expect(String(seq))` pattern exactly, just
 * carried over `tc` instead of `sc`.
 *
 * Every payload interface repeats `sessionId` even though the envelope
 * also carries it — matches the shape asked for in the workstream spec
 * and keeps each payload independently guardable/testable without the
 * envelope.
 */
import type { MeshToolCall, MeshToolFrame, MeshToolResult } from './types.js';
import { MESH_PROTOCOL_VERSION } from './types.js';
import { newCallId } from './tools.js';

// ── Payload shapes ──────────────────────────────────────────────────────

export interface StageLoadPayload {
  sessionId: string;
  modelId: string;
  layerStart: number;
  layerEnd: number;
  totalLayers: number;
  includeEmbeddings: boolean;
  includeOutput: boolean;
  /** One of these two must be present — manifest-based (Phase C target
   * per-layer artifacts) or a flat shard-URL list (Phase A/B convenience,
   * see SLICING.md §2). */
  manifestUrl?: string;
  shardUrls?: readonly string[];
  wireDtype: 'f32' | 'f16' | 'i8';
  ctxSize: number;
}

export interface StageReadyPayload {
  sessionId: string;
  isFirst: boolean;
  isFinal: boolean;
  nEmbd: number;
}

export interface StageStopPayload {
  sessionId: string;
  reason: string;
}

export interface StagePingPayload {
  sessionId: string;
  sentAtMs: number;
}

export interface StagePongPayload {
  sessionId: string;
  sentAtMs: number;
  pongAtMs: number;
}

export interface StageProgressPayload {
  sessionId: string;
  tokensDecoded: number;
  seq: number;
}

/**
 * Unsolicited host→driver push emitted WHILE the host is loading a stage
 * in answer to a `stage.load` / `stage.session.open` — the multi-GB shard
 * download + native `legion_stage_open` + WebGPU warm-up that can take many
 * minutes on an ordinary link. Before this frame existed the driver saw
 * NOTHING between "sent stage.load" and "got stage.ready ~8 min later",
 * so its load wait was a single flat timeout that (a) fired spuriously
 * mid-download (the 5-minute `loadMs` stall → forced replan seen live) and
 * (b) left the chat UI frozen with no "shard 24/36…" feedback. The driver
 * resets its no-progress stall clock on each of these (see
 * `PendingToolCallTracker.resetTimeout`) and surfaces the counts to the UI.
 *
 * Its envelope `callId` is a FRESH id (never the load's) so it can never
 * settle the `stage.ready`/`stage.session.accept` waiter registered under
 * the load's callId; correlation to the in-flight load is by source peer +
 * `sessionId`. `phase` lets the UI label the silent tail of the load
 * (`opening` = native open after the last shard, `warming` = WebGPU
 * warm-up) instead of showing a stuck "shard N/N".
 */
export interface StageLoadProgressPayload {
  sessionId: string;
  shardsFetched: number;
  totalShards: number;
  bytesFetched: number;
  totalBytes?: number;
  phase?: 'downloading' | 'opening' | 'warming';
}

export interface StageTokenPayload {
  sessionId: string;
  token: number;
  seq: number;
  done: boolean;
  finishReason?: string;
  /**
   * TEXT-RELAY (additive, v1-safe — absent ⇒ unchanged pre-textRelay
   * behavior, numeric `token` id only). Set by an `isFinal` host that was
   * opened with `StageSessionOpenPayload.textOutput: true` — the
   * INCREMENTAL decoded-text delta for this step, already UTF-8-safe
   * (never splits a multi-byte character or holds a dangling partial
   * grapheme — see mesh-react's `useStageHost.ts` / `incrementalTextStream.ts`'s
   * buffering). A driver with no local tokenizer accumulates these deltas
   * instead of calling `detokenize()` itself. Can be an empty string or
   * absent on a step whose token didn't complete a safely-emittable
   * chunk (the host is holding it back pending more tokens).
   */
  text?: string;
}

/**
 * M2 — open a new driver session against a stage the host may already
 * have loaded (multi-session: N sessions over ONE loaded stage, see
 * legion-stage-runtime's docs/MULTI-SESSION.md). Distinct from the legacy
 * `stage.load` (which the host answers by loading/reloading its worker
 * AND creating exactly one implicit session, tearing down any prior one):
 * `stage.session.open` only ever creates a NEW session — never tears down
 * an existing one — and carries `wireHeader` up front so the host can
 * build this session's activation-wire decoder at accept time instead of
 * relying on "the first `sf` frame after open is the header" (fragile
 * once multiple sessions interleave `sf` traffic on one host).
 */
export interface StageSessionOpenPayload {
  sessionId: string;
  modelId: string;
  /** The layer ISLAND this session serves. For a singleton multi-range host
   * (#63) this is a sub-range of what the host loads; the host runs it as a
   * per-session stage-range override on its own seq lane. */
  layerStart: number;
  layerEnd: number;
  /** Singleton multi-range (#63): the contiguous SPAN the host should load to
   * cover all islands it serves (one model / one unified-KV context). Absent ⇒
   * the host loads exactly [layerStart, layerEnd) — the pre-#63 single-range
   * behaviour (island === loaded stage). When present, [layerStart, layerEnd)
   * must be within [loadLayerStart, loadLayerEnd). */
  loadLayerStart?: number;
  loadLayerEnd?: number;
  totalLayers: number;
  ctxSize: number;
  wireDtype: 'f32' | 'f16' | 'i8';
  /** Base64 of `ActivationWireEncoder.headerBytes()` — the once-per-stream
   * activation-wire header this session's `sf` frames will be decoded
   * against. Sent up front (not as the first `sf` frame) precisely so a
   * host serving several concurrent sessions never has to guess which
   * inbound `sf` frame is "the header" for a session it just opened.
   *
   * RELAY: only the FIRST remote hop (stage 1) gets a header here — it's the
   * DRIVER's encoder header. For a hop ≥2 this is omitted, so the host sets
   * `awaitingHeader` and takes its upstream relay's own header from the first
   * `sf` frame (the legacy header path), since each relay re-encodes with its
   * own encoder. Absent ⇒ expect the header inline. */
  wireHeader?: string;
  /** RELAY (additive, v1-safe — absent ⇒ the pre-relay 2-stage assumption:
   * stageIndex 1, isFinal true, prevPeerId = the driver, no nextPeerId).
   *
   * This host's position in the pipeline, DRIVER-ASSIGNED and authoritative.
   * Pre-relay the host self-declared finality from its own artifacts and the
   * driver ignored it; a relay needs the driver to say who is final. */
  stageIndex?: number;
  /** Whether this host samples the next token and returns `stage.token`
   * (true), or forwards its boundary activation to `nextPeerId` (false). */
  isFinal?: boolean;
  /** The downstream peer this host forwards its boundary activation to.
   * Present iff `isFinal === false`. */
  nextPeerId?: string;
  /** The upstream peer whose `sf` frames this host must accept — the driver
   * for stage 1, the previous relay for a hop ≥2. Without it the host's
   * spoof guard (sender must equal driverPeerId) drops relayed frames. */
  prevPeerId?: string;
  /**
   * TEXT-RELAY (additive, v1-safe — absent ⇒ unchanged pre-textRelay
   * behavior: the host trusts the first `sf` frame's own `tokens`
   * sideband, as always). The prompt — or, on a continue-from-history
   * reattach, the prompt plus everything generated so far — as RAW TEXT,
   * for a driver with no local tokenizer at all (memory-constrained
   * devices that can't hold a wasm tokenizer runtime). Only ever sent to
   * the FIRST remote stage (`stageIndex === 1`): the isFirst host
   * tokenizes it server-side with its own vocab (every stage's shards
   * preserve full tokenizer metadata regardless of which tensors were
   * sliced — see stage-runtime's `fragmentsForRange` doc) and uses the
   * result for this session's very first prefill, IN PLACE OF the
   * placeholder `tokens` sideband the driver's first `sf` frame carries
   * (a driver with no tokenizer can't populate that sideband itself — see
   * `stageOrchestrator.ts`'s `textRelay` mode). Continue-from-history
   * detok→retok is not always token-identical for a BPE tokenizer — a
   * known, accepted minor drift on the (rare) replan path, not solved
   * perfectly here.
   */
  promptText?: string;
  /**
   * TEXT-RELAY (additive, v1-safe — absent/false ⇒ unchanged behavior,
   * numeric token id only). When true, this host — expected to be
   * `isFinal` for this session — DETOKENIZES every token it samples and
   * streams the incremental decoded text back via `stage.token`'s `text`
   * field, in addition to the numeric `token` id it always returns.
   */
  textOutput?: boolean;
}

export interface StageSessionAcceptPayload {
  sessionId: string;
  nEmbd: number;
  isFirst: boolean;
  isFinal: boolean;
  /** Sessions occupying a lane on this stage AFTER this accept, including
   * this one — lets the driver see how close the host is to its ceiling. */
  activeSessions: number;
  /** The lane ceiling this host committed to when it loaded the stage
   * (fixed at load time — see StageDescriptor.maxSessions upstream). */
  maxSessions: number;
}

/**
 * The host is at `maxSessions` capacity. `queuePosition` present means the
 * request was queued (bounded, TTL'd — see `stageSessionAdmission.ts`) and
 * will get a `stage.session.accept` (or a later `stage.session.busy` if it
 * expires) once a lane frees; absent means the queue itself was full and
 * this request was rejected outright — the driver should try a different
 * host, not wait.
 */
export interface StageSessionBusyPayload {
  sessionId: string;
  queuePosition?: number;
  estWaitMs?: number;
}

export type StageControlKind =
  | 'stage.load'
  | 'stage.ready'
  | 'stage.stop'
  | 'stage.ping'
  | 'stage.pong'
  | 'stage.progress'
  | 'stage.load.progress'
  | 'stage.token'
  | 'stage.session.open'
  | 'stage.session.accept'
  | 'stage.session.busy';

/** "call"-shaped kinds — the asking side initiates these. */
const CALL_KINDS: ReadonlySet<StageControlKind> = new Set(['stage.load', 'stage.ping', 'stage.stop', 'stage.session.open']);
/** "result"-shaped kinds — a response or unsolicited push from a host. */
const RESULT_KINDS: ReadonlySet<StageControlKind> = new Set([
  'stage.ready',
  'stage.pong',
  'stage.progress',
  'stage.load.progress',
  'stage.token',
  'stage.session.accept',
  'stage.session.busy',
]);

// A genuine discriminated union (one interface per `kind`) so TS narrows
// `msg.payload` from a `msg.kind === '...'` check — same rationale as the
// harness's `ControlMessageOf` (see control.ts's comment on this).
interface StageControlMessageOf<K extends StageControlKind, P> {
  kind: K;
  callId: string;
  sessionId: string;
  payload: P;
}

export type StageControlMessage =
  | StageControlMessageOf<'stage.load', StageLoadPayload>
  | StageControlMessageOf<'stage.ready', StageReadyPayload>
  | StageControlMessageOf<'stage.stop', StageStopPayload>
  | StageControlMessageOf<'stage.ping', StagePingPayload>
  | StageControlMessageOf<'stage.pong', StagePongPayload>
  | StageControlMessageOf<'stage.progress', StageProgressPayload>
  | StageControlMessageOf<'stage.load.progress', StageLoadProgressPayload>
  | StageControlMessageOf<'stage.token', StageTokenPayload>
  | StageControlMessageOf<'stage.session.open', StageSessionOpenPayload>
  | StageControlMessageOf<'stage.session.accept', StageSessionAcceptPayload>
  | StageControlMessageOf<'stage.session.busy', StageSessionBusyPayload>;

export type StageControlMessageFor<K extends StageControlKind> = Extract<StageControlMessage, { kind: K }>;

// ── Id helpers (reuse tools.ts's mint, don't reinvent) ──────────────────

export { newCallId };

/**
 * Deterministic per-decode-step callId — the driver mints this before
 * sending the `sf` frame for step `seq`, and the responding host's
 * `stage.token` result echoes the same value (no `tc` call ever precedes
 * `stage.token`; this is the correlation token instead).
 *
 * Scoped by `sessionId`, not just `seq`: a continue-from-history replan
 * (`stageOrchestrator.ts`) restarts `seq` at 0 against a NEW session, so
 * without the session scope a late/stray `stage.token` from a since-
 * abandoned (possibly dead, possibly just slow) old session could
 * collide with the new session's seq=0 waiter and get misattributed —
 * exactly the kind of chaos CHAOS.md's seq/idempotency design is meant
 * to rule out.
 */
export function stageTokenCallId(sessionId: string, seq: number): string {
  return `stagetok-${sessionId}-${seq}`;
}

export function newSessionId(): string {
  return `stagesess-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
}

// ── Guards ───────────────────────────────────────────────────────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isStringArr(x: unknown): x is readonly string[] {
  return Array.isArray(x) && x.every((s) => typeof s === 'string');
}

export function isStageLoadPayload(x: unknown): x is StageLoadPayload {
  if (!isRecord(x)) return false;
  if (typeof x.sessionId !== 'string' || !x.sessionId) return false;
  if (typeof x.modelId !== 'string' || !x.modelId) return false;
  if (!Number.isInteger(x.layerStart) || (x.layerStart as number) < 0) return false;
  if (!Number.isInteger(x.layerEnd) || (x.layerEnd as number) <= (x.layerStart as number)) return false;
  if (!Number.isInteger(x.totalLayers) || (x.totalLayers as number) < (x.layerEnd as number)) return false;
  if (typeof x.includeEmbeddings !== 'boolean') return false;
  if (typeof x.includeOutput !== 'boolean') return false;
  if (x.manifestUrl === undefined && x.shardUrls === undefined) return false;
  if (x.manifestUrl !== undefined && typeof x.manifestUrl !== 'string') return false;
  if (x.shardUrls !== undefined && !isStringArr(x.shardUrls)) return false;
  if (x.wireDtype !== 'f32' && x.wireDtype !== 'f16' && x.wireDtype !== 'i8') return false;
  if (!Number.isInteger(x.ctxSize) || (x.ctxSize as number) <= 0) return false;
  return true;
}

export function isStageReadyPayload(x: unknown): x is StageReadyPayload {
  if (!isRecord(x)) return false;
  return (
    typeof x.sessionId === 'string' &&
    typeof x.isFirst === 'boolean' &&
    typeof x.isFinal === 'boolean' &&
    Number.isInteger(x.nEmbd) &&
    (x.nEmbd as number) > 0
  );
}

export function isStageStopPayload(x: unknown): x is StageStopPayload {
  if (!isRecord(x)) return false;
  return typeof x.sessionId === 'string' && typeof x.reason === 'string';
}

export function isStagePingPayload(x: unknown): x is StagePingPayload {
  if (!isRecord(x)) return false;
  return typeof x.sessionId === 'string' && typeof x.sentAtMs === 'number';
}

export function isStagePongPayload(x: unknown): x is StagePongPayload {
  if (!isRecord(x)) return false;
  return (
    typeof x.sessionId === 'string' &&
    typeof x.sentAtMs === 'number' &&
    typeof x.pongAtMs === 'number'
  );
}

export function isStageProgressPayload(x: unknown): x is StageProgressPayload {
  if (!isRecord(x)) return false;
  return (
    typeof x.sessionId === 'string' &&
    Number.isInteger(x.tokensDecoded) &&
    Number.isInteger(x.seq)
  );
}

export function isStageLoadProgressPayload(x: unknown): x is StageLoadProgressPayload {
  if (!isRecord(x)) return false;
  if (typeof x.sessionId !== 'string' || !x.sessionId) return false;
  if (!Number.isInteger(x.shardsFetched) || (x.shardsFetched as number) < 0) return false;
  if (!Number.isInteger(x.totalShards) || (x.totalShards as number) < 0) return false;
  if (typeof x.bytesFetched !== 'number' || (x.bytesFetched as number) < 0) return false;
  if (x.totalBytes !== undefined && (typeof x.totalBytes !== 'number' || (x.totalBytes as number) < 0)) return false;
  if (x.phase !== undefined && x.phase !== 'downloading' && x.phase !== 'opening' && x.phase !== 'warming') return false;
  return true;
}

export function isStageTokenPayload(x: unknown): x is StageTokenPayload {
  if (!isRecord(x)) return false;
  if (typeof x.sessionId !== 'string') return false;
  if (!Number.isInteger(x.token)) return false;
  if (!Number.isInteger(x.seq)) return false;
  if (typeof x.done !== 'boolean') return false;
  if (x.finishReason !== undefined && typeof x.finishReason !== 'string') return false;
  if (x.text !== undefined && typeof x.text !== 'string') return false;
  return true;
}

export function isStageSessionOpenPayload(x: unknown): x is StageSessionOpenPayload {
  if (!isRecord(x)) return false;
  if (typeof x.sessionId !== 'string' || !x.sessionId) return false;
  if (typeof x.modelId !== 'string' || !x.modelId) return false;
  if (!Number.isInteger(x.layerStart) || (x.layerStart as number) < 0) return false;
  if (!Number.isInteger(x.layerEnd) || (x.layerEnd as number) <= (x.layerStart as number)) return false;
  if (!Number.isInteger(x.totalLayers) || (x.totalLayers as number) < (x.layerEnd as number)) return false;
  if (!Number.isInteger(x.ctxSize) || (x.ctxSize as number) <= 0) return false;
  if (x.wireDtype !== 'f32' && x.wireDtype !== 'f16' && x.wireDtype !== 'i8') return false;
  // wireHeader is now optional (a hop ≥2 omits it — see the field doc); when
  // present it must still be a non-empty base64 string.
  if (x.wireHeader !== undefined && (typeof x.wireHeader !== 'string' || !x.wireHeader)) return false;
  // Relay fields (all optional, additive):
  if (x.stageIndex !== undefined && (!Number.isInteger(x.stageIndex) || (x.stageIndex as number) < 0)) return false;
  if (x.isFinal !== undefined && typeof x.isFinal !== 'boolean') return false;
  if (x.nextPeerId !== undefined && (typeof x.nextPeerId !== 'string' || !x.nextPeerId)) return false;
  if (x.prevPeerId !== undefined && (typeof x.prevPeerId !== 'string' || !x.prevPeerId)) return false;
  // TEXT-RELAY fields (all optional, additive):
  if (x.promptText !== undefined && typeof x.promptText !== 'string') return false;
  if (x.textOutput !== undefined && typeof x.textOutput !== 'boolean') return false;
  return true;
}

export function isStageSessionAcceptPayload(x: unknown): x is StageSessionAcceptPayload {
  if (!isRecord(x)) return false;
  if (typeof x.sessionId !== 'string' || !x.sessionId) return false;
  if (!Number.isInteger(x.nEmbd) || (x.nEmbd as number) <= 0) return false;
  if (typeof x.isFirst !== 'boolean') return false;
  if (typeof x.isFinal !== 'boolean') return false;
  if (!Number.isInteger(x.activeSessions) || (x.activeSessions as number) < 0) return false;
  if (!Number.isInteger(x.maxSessions) || (x.maxSessions as number) <= 0) return false;
  return true;
}

export function isStageSessionBusyPayload(x: unknown): x is StageSessionBusyPayload {
  if (!isRecord(x)) return false;
  if (typeof x.sessionId !== 'string' || !x.sessionId) return false;
  if (x.queuePosition !== undefined && (!Number.isInteger(x.queuePosition) || (x.queuePosition as number) < 0)) return false;
  if (x.estWaitMs !== undefined && (typeof x.estWaitMs !== 'number' || (x.estWaitMs as number) < 0)) return false;
  return true;
}

const PAYLOAD_GUARDS: { [K in StageControlKind]: (x: unknown) => boolean } = {
  'stage.load': isStageLoadPayload,
  'stage.ready': isStageReadyPayload,
  'stage.stop': isStageStopPayload,
  'stage.ping': isStagePingPayload,
  'stage.pong': isStagePongPayload,
  'stage.progress': isStageProgressPayload,
  'stage.load.progress': isStageLoadProgressPayload,
  'stage.token': isStageTokenPayload,
  'stage.session.open': isStageSessionOpenPayload,
  'stage.session.accept': isStageSessionAcceptPayload,
  'stage.session.busy': isStageSessionBusyPayload,
};

// ── Encode ───────────────────────────────────────────────────────────────

/** Encode a `StageControlMessage` as a `MeshToolFrame` ready for `peer.sendTool`. */
export function encodeStageControl(msg: StageControlMessage): MeshToolFrame {
  const ts = Date.now();
  if (CALL_KINDS.has(msg.kind)) {
    const call: MeshToolCall = {
      v: MESH_PROTOCOL_VERSION,
      ts,
      callId: msg.callId,
      toolName: msg.kind,
      args: msg.payload as unknown as Record<string, unknown>,
    };
    return { kind: 'call', ...call };
  }
  const result: MeshToolResult = {
    v: MESH_PROTOCOL_VERSION,
    ts,
    callId: msg.callId,
    status: 'ok',
    result: { stageKind: msg.kind, payload: msg.payload as unknown as Record<string, unknown> },
  };
  return { kind: 'result', ...result };
}

// ── Decode ───────────────────────────────────────────────────────────────

/**
 * Decode a `MeshToolFrame` back into a `StageControlMessage`, or `null`
 * if it isn't one (not a stage frame at all, or a malformed one — v1
 * additive tolerance: never throw on garbage, just reject it).
 */
export function decodeStageControl(frame: MeshToolFrame): StageControlMessage | null {
  if (frame.kind === 'call') {
    const kind = frame.toolName as StageControlKind;
    if (!CALL_KINDS.has(kind)) return null;
    const guard = PAYLOAD_GUARDS[kind];
    if (!guard(frame.args)) return null;
    const payload = frame.args as unknown as StageControlMessage['payload'];
    return { kind, callId: frame.callId, sessionId: (frame.args as { sessionId: string }).sessionId, payload } as StageControlMessage;
  }
  // kind === 'result'
  if (frame.status !== 'ok' || !isRecord(frame.result)) return null;
  const stageKind = frame.result.stageKind;
  if (typeof stageKind !== 'string' || !RESULT_KINDS.has(stageKind as StageControlKind)) return null;
  const kind = stageKind as StageControlKind;
  const guard = PAYLOAD_GUARDS[kind];
  const payload = frame.result.payload;
  if (!guard(payload)) return null;
  const typedPayload = payload as unknown as StageControlMessage['payload'];
  return {
    kind,
    callId: frame.callId,
    sessionId: (payload as { sessionId: string }).sessionId,
    payload: typedPayload,
  } as StageControlMessage;
}

/** True iff a `MeshToolFrame` is (or claims to be) any stage-control message —
 * cheap pre-filter for a shared `onTool` handler that also carries ordinary
 * tool calls/results, before paying for the full decode + payload guard. */
export function isStageControlFrame(frame: MeshToolFrame): boolean {
  if (frame.kind === 'call') return CALL_KINDS.has(frame.toolName as StageControlKind);
  return isRecord(frame.result) && typeof frame.result.stageKind === 'string' && RESULT_KINDS.has(frame.result.stageKind as StageControlKind);
}

// ── Convenience constructors ─────────────────────────────────────────────
// Thin builders so callers (stageOrchestrator.ts, host-role code, tests)
// don't hand-assemble the discriminated union.

export function makeStageLoad(sessionId: string, payload: Omit<StageLoadPayload, 'sessionId'>, callId = newCallId()): StageControlMessageFor<'stage.load'> {
  return { kind: 'stage.load', callId, sessionId, payload: { ...payload, sessionId } };
}
export function makeStageReady(sessionId: string, payload: Omit<StageReadyPayload, 'sessionId'>, callId: string): StageControlMessageFor<'stage.ready'> {
  return { kind: 'stage.ready', callId, sessionId, payload: { ...payload, sessionId } };
}
export function makeStageStop(sessionId: string, reason: string, callId = newCallId()): StageControlMessageFor<'stage.stop'> {
  return { kind: 'stage.stop', callId, sessionId, payload: { sessionId, reason } };
}
export function makeStagePing(sessionId: string, callId = newCallId()): StageControlMessageFor<'stage.ping'> {
  return { kind: 'stage.ping', callId, sessionId, payload: { sessionId, sentAtMs: Date.now() } };
}
export function makeStagePong(sessionId: string, sentAtMs: number, callId: string): StageControlMessageFor<'stage.pong'> {
  return { kind: 'stage.pong', callId, sessionId, payload: { sessionId, sentAtMs, pongAtMs: Date.now() } };
}
export function makeStageProgress(sessionId: string, tokensDecoded: number, seq: number, callId = newCallId()): StageControlMessageFor<'stage.progress'> {
  return { kind: 'stage.progress', callId, sessionId, payload: { sessionId, tokensDecoded, seq } };
}
/**
 * Load-progress push. `callId` defaults to a FRESH id on purpose (never
 * the load's callId) so this frame can't settle the load's ready/accept
 * waiter — see `StageLoadProgressPayload`'s doc.
 */
export function makeStageLoadProgress(
  sessionId: string,
  payload: Omit<StageLoadProgressPayload, 'sessionId'>,
  callId = newCallId(),
): StageControlMessageFor<'stage.load.progress'> {
  return { kind: 'stage.load.progress', callId, sessionId, payload: { ...payload, sessionId } };
}
export function makeStageToken(
  sessionId: string,
  token: number,
  seq: number,
  done: boolean,
  finishReason?: string,
  /** TEXT-RELAY — see `StageTokenPayload.text`'s doc comment. */
  text?: string,
): StageControlMessageFor<'stage.token'> {
  return {
    kind: 'stage.token',
    callId: stageTokenCallId(sessionId, seq),
    sessionId,
    payload: {
      sessionId,
      token,
      seq,
      done,
      ...(finishReason !== undefined ? { finishReason } : {}),
      ...(text !== undefined ? { text } : {}),
    },
  };
}

export function makeStageSessionOpen(
  sessionId: string,
  payload: Omit<StageSessionOpenPayload, 'sessionId'>,
  callId = newCallId(),
): StageControlMessageFor<'stage.session.open'> {
  return { kind: 'stage.session.open', callId, sessionId, payload: { ...payload, sessionId } };
}
export function makeStageSessionAccept(
  sessionId: string,
  payload: Omit<StageSessionAcceptPayload, 'sessionId'>,
  callId: string,
): StageControlMessageFor<'stage.session.accept'> {
  return { kind: 'stage.session.accept', callId, sessionId, payload: { ...payload, sessionId } };
}
export function makeStageSessionBusy(
  sessionId: string,
  payload: Omit<StageSessionBusyPayload, 'sessionId'>,
  callId: string,
): StageControlMessageFor<'stage.session.busy'> {
  return { kind: 'stage.session.busy', callId, sessionId, payload: { ...payload, sessionId } };
}
