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
  wireDtype: 'f32' | 'f16';
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

export interface StageTokenPayload {
  sessionId: string;
  token: number;
  seq: number;
  done: boolean;
  finishReason?: string;
}

export type StageControlKind =
  | 'stage.load'
  | 'stage.ready'
  | 'stage.stop'
  | 'stage.ping'
  | 'stage.pong'
  | 'stage.progress'
  | 'stage.token';

/** "call"-shaped kinds — the asking side initiates these. */
const CALL_KINDS: ReadonlySet<StageControlKind> = new Set(['stage.load', 'stage.ping', 'stage.stop']);
/** "result"-shaped kinds — a response or unsolicited push from a host. */
const RESULT_KINDS: ReadonlySet<StageControlKind> = new Set([
  'stage.ready',
  'stage.pong',
  'stage.progress',
  'stage.token',
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
  | StageControlMessageOf<'stage.token', StageTokenPayload>;

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
  if (x.wireDtype !== 'f32' && x.wireDtype !== 'f16') return false;
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

export function isStageTokenPayload(x: unknown): x is StageTokenPayload {
  if (!isRecord(x)) return false;
  if (typeof x.sessionId !== 'string') return false;
  if (!Number.isInteger(x.token)) return false;
  if (!Number.isInteger(x.seq)) return false;
  if (typeof x.done !== 'boolean') return false;
  if (x.finishReason !== undefined && typeof x.finishReason !== 'string') return false;
  return true;
}

const PAYLOAD_GUARDS: { [K in StageControlKind]: (x: unknown) => boolean } = {
  'stage.load': isStageLoadPayload,
  'stage.ready': isStageReadyPayload,
  'stage.stop': isStageStopPayload,
  'stage.ping': isStagePingPayload,
  'stage.pong': isStagePongPayload,
  'stage.progress': isStageProgressPayload,
  'stage.token': isStageTokenPayload,
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
export function makeStageToken(
  sessionId: string,
  token: number,
  seq: number,
  done: boolean,
  finishReason?: string,
): StageControlMessageFor<'stage.token'> {
  return {
    kind: 'stage.token',
    callId: stageTokenCallId(sessionId, seq),
    sessionId,
    payload: { sessionId, token, seq, done, ...(finishReason !== undefined ? { finishReason } : {}) },
  };
}
