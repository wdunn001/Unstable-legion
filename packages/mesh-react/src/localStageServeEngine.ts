/**
 * localStageServeEngine — the pure(-ish), ADOPTED-mode serving core behind
 * `useLocalStageServe.ts` (REUSE-STAGE0 Phase 1). Split out from that hook
 * for the same reason `stageSessionAdmission.ts` is its own module: no
 * React, so it's cheap to unit-test with a fake client/peer instead of
 * rendering a hook.
 *
 * ── ADOPTED mode vs `useStageHost.ts`'s OWNING mode ──────────────────────
 *
 * `useStageHost.ts` OWNS the worker it serves from: it loads it
 * (`ensureWorkerLoaded`), disposes it, reloads it on a config mismatch,
 * and adds its own "+1 fused lane" to the native `maxSessions` it passes
 * at load time. This engine does none of that. It is handed an ALREADY
 * loaded, ALREADY warm `client` (`useCommunalChat.ts`'s resident stage-0
 * worker — see that file's `ResidentStageZero`) and a fixed `config`
 * describing what that client has loaded, and it NEVER calls anything that
 * would load, dispose, or reset it. Every `handleSessionOpen` asserts the
 * incoming request's stage range/model/ctx/dtype matches `config` exactly
 * (`sameServedConfig`) — a mismatch is a hard refusal (`stage.stop`), never
 * a reload. This is the whole point of the reuse design: the resident
 * worker already has embeddings (loaded `[0, driverLayers)` WITH
 * `includeEmbeddings: true` — see `useCommunalChat.ts`), so the
 * `token_embd` bug a separate isFirst communal claim hit cannot recur, and
 * a served client costs no second download.
 *
 * ── The off-by-one (see `ResidentStageZero.serveMaxSessions`'s doc) ──────
 *
 * `useStageHost.ts` adds `+1` to its own admission ceiling because IT owns
 * the load and reserves the fused lane itself. Here `useCommunalChat.ts`
 * already reserved that fused lane at load time (`maxSessions: 1 + N`), so
 * this engine's `maxSessions` option is `N` UNMODIFIED — adding another +1
 * here would silently steal a servable lane's worth of capacity.
 *
 * ── Phase 1 scope note ────────────────────────────────────────────────
 *
 * The relay-forward branch (`handleStageFrame`'s `!isFinal` path) is
 * COPIED from `useStageHost.ts`'s `onStageFrame`, not shared — Phase 2 is
 * expected to extract a common `stageServe.ts` core both hooks call
 * through. Do not let this copy drift silently; if the forward logic in
 * `useStageHost.ts` changes, check whether this needs the same fix.
 */
import {
  createLegionActivationWireDecoder,
  createLegionActivationWireEncoder,
  decodeStageFrameEnvelope,
  encodeStageControl,
  encodeStageFrameEnvelope,
  extractIncrementalTextDelta,
  INITIAL_TEXT_CURSOR,
  makeStageSessionAccept,
  makeStageSessionBusy,
  makeStageStop,
  makeStageToken,
  type IncrementalTextCursor,
  type LegionActivationWireDecoder,
  type LegionActivationWireEncoder,
  type MeshLoadedStage,
  type Peer,
  type StageSessionOpenPayload,
  type StandingLedger,
} from '@unstable-legion/core';
import { type StageWorkerLog } from './stageWorkerClient.js';
import type { WireActivationFrame } from './stageWorkerProtocol.js';
import type { UseStageHostSession } from './useStageHost.js';
import {
  canAdmitNow,
  enqueue,
  expireQueue,
  isSessionIdle,
  popNextByPriority,
  DEFAULT_IDLE_EVICT_MS,
  DEFAULT_QUEUE_CAP,
  DEFAULT_QUEUE_TTL_MS,
  type PriorityScoreFn,
  type QueueEntry,
} from './stageSessionAdmission.js';

// ── base64 <-> bytes (browser main-thread; Buffer fallback for Node test hosts) ──
// Duplicated from `useStageHost.ts` (tiny, self-contained — see this
// module's Phase-1-scope note above for the "not shared yet" rationale).
function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  // eslint-disable-next-line no-undef
  const buf = (globalThis as unknown as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (buf) return buf.from(b64, 'base64');
  throw new Error('no base64 decoder available in this environment');
}

/**
 * Structural subset of `StageWorkerClient` this engine needs — a real
 * `StageWorkerClient` instance satisfies this directly (no adapter); tests
 * pass a fake that tracks whether `load`/`dispose`/`reset` were ever
 * called (they must NEVER be, in adopted mode — this interface doesn't
 * even expose those methods, so a test double naturally can't accidentally
 * satisfy a call site that isn't there).
 */
export interface ServedStageClient {
  readonly isFirst: boolean;
  readonly isFinal: boolean;
  readonly nEmbd: number;
  sessionCreate(sessionId: string): Promise<void>;
  sessionFree(sessionId: string): Promise<void>;
  tokenize(text: string, addSpecial: boolean): Promise<number[]>;
  detokenize(tokens: number[]): Promise<string>;
  tokenIsEog(token: number): Promise<boolean>;
  prefill(
    tokens: number[],
    positions: number[],
    input?: WireActivationFrame,
    sessionId?: string,
  ): Promise<{ activation?: WireActivationFrame; predictedToken?: number }>;
  decode(
    token: number,
    input?: WireActivationFrame,
    sessionId?: string,
  ): Promise<{ activation?: WireActivationFrame; predictedToken?: number }>;
}

export interface ServedStageConfig {
  modelId: string;
  layerStart: number;
  layerEnd: number;
  totalLayers: number;
  ctxSize: number;
  wireDtype: 'f32' | 'f16' | 'i8';
}

/** Exact-match only — an adopted-mode serve NEVER reloads to satisfy a
 * mismatched request (that's the whole point: no second load). */
export function sameServedConfig(a: ServedStageConfig, b: ServedStageConfig): boolean {
  return (
    a.modelId === b.modelId &&
    a.layerStart === b.layerStart &&
    a.layerEnd === b.layerEnd &&
    a.totalLayers === b.totalLayers &&
    a.ctxSize === b.ctxSize &&
    a.wireDtype === b.wireDtype
  );
}

export interface LocalStageServeEngineOptions {
  meshPeer: Pick<Peer, 'sendTool' | 'sendStageFrame' | 'selfId'>;
  /** ALREADY loaded, ALREADY warm — this engine never loads/disposes/
   * resets it. See this module's doc comment. */
  client: ServedStageClient;
  /** What `client` has loaded — every `handleSessionOpen` request is
   * asserted against this exactly (`sameServedConfig`). */
  config: ServedStageConfig;
  /** Ceiling on SERVED (non-fused) lanes. NOT incremented by 1 here — see
   * this module's "off-by-one" doc section. */
  maxSessions: number;
  /** Epoch to report in `getLoadedStageEntry()` — threaded from
   * `ResidentStageZero.epoch` so a fresh resident load is distinguishable
   * from stale cap data on the wire. */
  epoch: number;
  priorityScore?: PriorityScoreFn;
  standingLedger?: StandingLedger;
  /** Send `stage.progress` every N decoded tokens (per session), mirroring
   * `useStageHost.ts`'s identical option. Default 8. */
  progressEveryN?: number;
  log?: StageWorkerLog;
  /** Called after any session/queue-count change — a caller (the
   * `useLocalStageServe` hook) wires this to a re-render/republish. */
  onChange?: () => void;
}

export interface LocalStageServeEngine {
  /** Handle an inbound `stage.session.open` for THIS engine's fixed stage
   * range. Admits immediately when a lane is free, enqueues (bounded,
   * TTL'd — reuses `stageSessionAdmission.ts` verbatim) when at ceiling,
   * or refuses outright on a config mismatch. NEVER loads/disposes/resets
   * `client`. */
  handleSessionOpen(payload: StageSessionOpenPayload, peerId: string, callId: string): Promise<void>;
  /** Handle an inbound `sf` activation frame. Fire-and-forget internally
   * (async work happens in the background; errors free the session and
   * notify the driver, mirroring `useStageHost.ts`'s `onStageFrame`). */
  handleStageFrame(bytes: Uint8Array, fromPeerId: string): void;
  /** Handle an inbound `stage.stop` for a session this engine holds. */
  handleStop(sessionId: string, peerId: string, reason: string): Promise<void>;
  /** Evict sessions idle longer than `idleEvictMs` (default
   * `DEFAULT_IDLE_EVICT_MS`) as of `now`. */
  idleSweep(now: number, idleEvictMs?: number): void;
  /** Free any session whose driver/upstream/downstream peer left the mesh
   * (`presentPeerIds` = the roster snapshot's current peer ids). */
  onRosterChange(presentPeerIds: ReadonlySet<string>): void;
  /** Force-free every session this engine holds (teardown/toggle-off). */
  stopAll(reason: string): Promise<void>;
  getSessions(): readonly UseStageHostSession[];
  getQueueLength(): number;
  getLastError(): string | undefined;
  /** This engine's `cap.stageHost.loadedStages` entry — always defined
   * (this engine only exists while its stage is genuinely adopted/served);
   * the caller decides whether/when to publish it. */
  getLoadedStageEntry(): MeshLoadedStage;
}

interface HostSessionState {
  sessionId: string;
  driverPeerId: string;
  decoder?: LegionActivationWireDecoder;
  awaitingHeader: boolean;
  decodedCount: number;
  createdAt: number;
  lastFrameAt: number;
  isFirst: boolean;
  isFinal: boolean;
  layerStart: number;
  layerEnd: number;
  totalLayers: number;
  prevPeerId: string;
  nextPeerId?: string;
  forwardEncoder?: LegionActivationWireEncoder;
  forwardHeaderSent?: boolean;
  modelId: string;
  stageIndex: number;
  wireDtype: 'f32' | 'f16' | 'i8';
  pendingPromptTokens?: number[];
  textOutput: boolean;
  sampledTokens?: number[];
  textCursor?: IncrementalTextCursor;
}

interface PendingOpen {
  payload: StageSessionOpenPayload;
  peerId: string;
  callId: string;
}

export function createLocalStageServeEngine(opts: LocalStageServeEngineOptions): LocalStageServeEngine {
  const { meshPeer, client, config, maxSessions, epoch, progressEveryN = 8, log = () => undefined, onChange = () => undefined } = opts;
  const priorityScore = opts.priorityScore ?? (() => 0);
  const standingLedger = opts.standingLedger;

  const hostSessions = new Map<string, HostSessionState>();
  let queue: readonly QueueEntry<PendingOpen>[] = [];
  let lastError: string | undefined;

  function notify(): void {
    onChange();
  }

  async function failOpen(req: PendingOpen, message: string): Promise<void> {
    lastError = message;
    log(`[local-stage-serve] open FAILED sessionId=${req.payload.sessionId} peer=${req.peerId}: ${message}`);
    await meshPeer.sendTool(encodeStageControl(makeStageStop(req.payload.sessionId, message)), req.peerId).catch(() => undefined);
  }

  async function openNow(req: PendingOpen): Promise<void> {
    const { payload, peerId, callId } = req;
    try {
      const want: ServedStageConfig = {
        modelId: payload.modelId,
        layerStart: payload.layerStart,
        layerEnd: payload.layerEnd,
        totalLayers: payload.totalLayers,
        ctxSize: payload.ctxSize,
        wireDtype: payload.wireDtype,
      };
      // ADOPTED MODE — assert, never reload. See this module's doc comment.
      if (!sameServedConfig(config, want)) {
        throw new Error(
          `local stage-0 serve: requested [${want.layerStart},${want.layerEnd}) does not match the resident ` +
            `worker's loaded [${config.layerStart},${config.layerEnd}) — refusing rather than reloading`,
        );
      }
      await client.sessionCreate(payload.sessionId);
      let decoder: LegionActivationWireDecoder | undefined;
      let awaitingHeader = true;
      if (payload.wireHeader) {
        decoder = createLegionActivationWireDecoder(base64ToBytes(payload.wireHeader));
        awaitingHeader = false;
      }
      // TEXT-RELAY: tokenize `promptText` server-side NOW, at accept time —
      // mirrors `useStageHost.ts`'s `openNow` exactly (see that function's
      // doc comment for why this can't wait for the first `sf` frame).
      let pendingPromptTokens: number[] | undefined;
      if (payload.promptText !== undefined && client.isFirst) {
        pendingPromptTokens = await client.tokenize(payload.promptText, true);
      }
      const state: HostSessionState = {
        sessionId: payload.sessionId,
        driverPeerId: peerId,
        decoder,
        awaitingHeader,
        decodedCount: 0,
        createdAt: Date.now(),
        lastFrameAt: Date.now(),
        isFirst: client.isFirst,
        isFinal: payload.isFinal ?? client.isFinal,
        layerStart: payload.layerStart,
        layerEnd: payload.layerEnd,
        totalLayers: payload.totalLayers,
        prevPeerId: payload.prevPeerId ?? peerId,
        nextPeerId: payload.nextPeerId,
        modelId: payload.modelId,
        stageIndex: payload.stageIndex ?? 1,
        wireDtype: payload.wireDtype,
        pendingPromptTokens,
        textOutput: payload.textOutput ?? false,
      };
      hostSessions.set(payload.sessionId, state);
      notify();
      await meshPeer.sendTool(
        encodeStageControl(
          makeStageSessionAccept(
            payload.sessionId,
            { nEmbd: client.nEmbd, isFirst: state.isFirst, isFinal: state.isFinal, activeSessions: hostSessions.size, maxSessions },
            callId,
          ),
        ),
        peerId,
      );
      log(`[local-stage-serve] session OPEN sessionId=${payload.sessionId} peer=${peerId} active=${hostSessions.size}/${maxSessions}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await failOpen(req, message);
    }
  }

  async function admitNextQueued(): Promise<void> {
    for (;;) {
      if (!canAdmitNow(hostSessions.size, maxSessions)) return;
      const { queue: rest, next } = popNextByPriority(queue, priorityScore);
      queue = rest;
      notify();
      if (!next) return;
      await openNow(next.request);
    }
  }

  async function admitOrEnqueue(req: PendingOpen): Promise<void> {
    const now = Date.now();
    const { queue: alive, expired } = expireQueue(queue, now, DEFAULT_QUEUE_TTL_MS);
    queue = alive;
    for (const e of expired) {
      log(`[local-stage-serve] queued session-open for ${e.sessionId} expired (TTL ${DEFAULT_QUEUE_TTL_MS}ms) — dropping`);
      await failOpen(e.request, `queued session-open request expired after ${DEFAULT_QUEUE_TTL_MS}ms`);
    }

    if (canAdmitNow(hostSessions.size, maxSessions)) {
      await openNow(req);
      return;
    }

    const { queue: q2, accepted, queuePosition } = enqueue(
      queue,
      { sessionId: req.payload.sessionId, peerId: req.peerId, enqueuedAt: now, request: req },
      DEFAULT_QUEUE_CAP,
    );
    queue = q2;
    notify();
    if (accepted) {
      log(`[local-stage-serve] session-open QUEUED sessionId=${req.payload.sessionId} position=${queuePosition}`);
      await meshPeer.sendTool(encodeStageControl(makeStageSessionBusy(req.payload.sessionId, { queuePosition }, req.callId)), req.peerId);
    } else {
      log(`[local-stage-serve] session-open REJECTED (queue full) sessionId=${req.payload.sessionId}`);
      await meshPeer.sendTool(encodeStageControl(makeStageSessionBusy(req.payload.sessionId, {}, req.callId)), req.peerId).catch(() => undefined);
    }
  }

  async function freeSession(sessionId: string, reason: string, notifyDriver: boolean): Promise<void> {
    const state = hostSessions.get(sessionId);
    if (!state) return;
    hostSessions.delete(sessionId);
    notify();
    await client.sessionFree(sessionId).catch(() => undefined);
    log(`[local-stage-serve] session FREED sessionId=${sessionId} reason=${reason} active=${hostSessions.size}/${maxSessions}`);
    if (standingLedger) {
      const now = Date.now();
      standingLedger.recordConsumption(
        {
          consumerPeerId: state.driverPeerId,
          layersConsumed: state.layerEnd - state.layerStart,
          framesConsumed: state.decodedCount,
          consumingMs: Math.max(0, now - state.createdAt),
        },
        now,
      );
    }
    if (notifyDriver) {
      const targets = new Set<string>([state.driverPeerId]);
      if (state.nextPeerId) targets.add(state.nextPeerId);
      for (const target of targets) {
        await meshPeer.sendTool(encodeStageControl(makeStageStop(sessionId, reason)), target).catch(() => undefined);
      }
    }
    await admitNextQueued();
  }

  // ── `sf` activation-frame handling — COPIED from `useStageHost.ts`'s
  // `onStageFrame` (see this module's Phase-1-scope doc note). ───────────
  function handleStageFrame(raw: Uint8Array, fromPeerId: string): void {
    const envelope = decodeStageFrameEnvelope(raw);
    if (!envelope) {
      log(`[local-stage-serve] onStageFrame DROPPED — malformed envelope from ${fromPeerId} (${raw.byteLength} bytes)`);
      return;
    }
    const { sessionId, payload: bytes } = envelope;
    const state = hostSessions.get(sessionId);
    if (!state) {
      // NOT an error, so NOT logged (see #55): `peer.onStageFrame` broadcasts
      // every inbound frame to ALL listeners. A tab that runs both this
      // stage-0 serve engine AND useStageHost's body-host engine (the solo
      // whole-model / serveFirstStage case) sees the sibling engine's frames
      // — and its own selfId loopback frames — here too. A sessionId absent
      // from THIS engine's map simply belongs to another engine or was
      // already freed: a filter-miss, not a drop. Warning on it (the old
      // "DROPPED — unknown sessionId" spam, one line per token) made real
      // diagnosis harder. A genuinely orphaned frame surfaces as a
      // generation stall at the orchestrator, not as noise here.
      return;
    }
    if (fromPeerId !== state.prevPeerId) {
      // Co-located routing artifact, not a spoof: when this peer serves this
      // stage AND hosts a sibling stage, its own forward to the sibling (and
      // the driver's frames for the sibling) are dispatched to THIS handler
      // too and dropped here. Only warn for a genuinely unknown sender.
      const knownParticipant = fromPeerId === state.driverPeerId || fromPeerId === state.nextPeerId || fromPeerId === meshPeer.selfId;
      if (!knownParticipant) {
        log(`[local-stage-serve] onStageFrame DROPPED — peerId=${fromPeerId} is not the upstream of sessionId=${sessionId} (expected=${state.prevPeerId})`);
      }
      return;
    }
    state.lastFrameAt = Date.now();
    void (async () => {
      try {
        if (state.awaitingHeader) {
          state.decoder = createLegionActivationWireDecoder(bytes);
          state.awaitingHeader = false;
          log(`[local-stage-serve] wire header sessionId=${sessionId}: modelId=${state.decoder.modelId} nEmbd=${state.decoder.nEmbd} dtype=${state.decoder.dtype}`);
          return;
        }
        if (!state.decoder) return;
        const frame = state.decoder.decodeFrameBytes(bytes);
        let wireFrame: WireActivationFrame = {
          dtype: 'f32',
          layout: 'token-major',
          tokenCount: frame.tokenCount,
          payload: frame.activations.buffer.slice(
            frame.activations.byteOffset,
            frame.activations.byteOffset + frame.activations.byteLength,
          ) as ArrayBuffer,
        };
        let tokens: readonly number[] = frame.tokens ?? [];
        const isPrefill = frame.seq === 0;
        if (isPrefill && state.pendingPromptTokens) {
          tokens = state.pendingPromptTokens;
          state.pendingPromptTokens = undefined;
        }
        // An isFirst stage EMBEDS tokens. Its SESSION prefill/decode
        // (`legion_prefill_s`) rejects ANY activation input ("this stage
        // expects token input, not activation input") — unlike the driver's
        // own FUSED `stage.prefill`, which merely ignores a dummy. So for an
        // isFirst served stage, pass NO activation and let it embed `tokens`
        // (matching useCommunalChat's own stage-0 prefill). A non-first
        // (relay-middle) served stage still consumes the incoming activation.
        const stageInput = client.isFirst ? undefined : wireFrame;
        const positions = tokens.map((_, i) => (frame.posStart ?? 0) + i);
        const result = isPrefill
          ? await client.prefill(tokens as number[], positions, stageInput, sessionId)
          : await client.decode((tokens[0] as number) ?? 0, stageInput, sessionId);

        if (!state.isFinal) {
          if (!state.nextPeerId) throw new Error('relay stage has no nextPeerId — cannot forward');
          if (!result.activation) throw new Error('relay stage produced no boundary activation to forward');
          if (!state.forwardEncoder) {
            state.forwardEncoder = createLegionActivationWireEncoder({
              modelId: state.modelId,
              stageIndex: state.stageIndex,
              nEmbd: client.nEmbd,
              dtype: state.wireDtype,
            });
          }
          if (!state.forwardHeaderSent) {
            await meshPeer.sendStageFrame(encodeStageFrameEnvelope(sessionId, state.forwardEncoder.headerBytes()), state.nextPeerId);
            state.forwardHeaderSent = true;
          }
          const activationF32 = new Float32Array(result.activation.payload);
          // Forward the tokens THIS stage actually embedded, not `frame.tokens`.
          // A text-relay thin driver sends promptText and NO tokens (frame.tokens
          // is null), so the isFirst stage tokenized server-side into `tokens`
          // (pendingPromptTokens). Forwarding `frame.tokens` here read `.length`
          // on null and freed the session; downstream also needs the real token
          // count to derive positions. On decode steps `tokens` === frame.tokens.
          const outBytes = state.forwardEncoder.encodeFrame(activationF32, {
            seq: frame.seq,
            posStart: frame.posStart ?? 0,
            tokens: [...tokens],
            done: frame.done,
            ...(frame.finishReason !== undefined ? { finishReason: frame.finishReason } : {}),
          });
          await meshPeer.sendStageFrame(encodeStageFrameEnvelope(sessionId, outBytes), state.nextPeerId);
          state.decodedCount += 1;
          notify();
          return;
        }

        // ── FINAL stage (unlikely for stage-0 in practice — driverLayers
        // is always < totalLayers — but supported for correctness/parity
        // with useStageHost.ts's identical branch). ─────────────────────
        if (result.predictedToken === undefined) {
          throw new Error('final-stage serve produced no predictedToken');
        }
        state.decodedCount += 1;
        notify();
        const isEog = await client.tokenIsEog(result.predictedToken);
        let textDelta: string | undefined;
        if (state.textOutput) {
          state.sampledTokens = state.sampledTokens ?? [];
          // Stop token (e.g. ChatML <|im_end|>) is a control signal, not
          // content — folding it in leaks the literal "<|im_end|>" into the
          // text (parity with useStageHost.ts's final-stage branch).
          if (!isEog) state.sampledTokens.push(result.predictedToken);
          const fullText = await client.detokenize(state.sampledTokens);
          const { delta, cursor } = extractIncrementalTextDelta(fullText, state.textCursor ?? INITIAL_TEXT_CURSOR, { flush: isEog });
          state.textCursor = cursor;
          if (delta.length > 0) textDelta = delta;
        }
        await meshPeer.sendTool(
          encodeStageControl(makeStageToken(sessionId, result.predictedToken, frame.seq, isEog, isEog ? 'eos' : undefined, textDelta)),
          state.driverPeerId,
        );
        if (progressEveryN > 0 && state.decodedCount % progressEveryN === 0) {
          // Parity note: unlike `useStageHost.ts`, this engine doesn't emit
          // `stage.progress` (no test/consumer needs it for Phase 1's
          // stage-0-is-never-final common case) — left as a documented gap
          // rather than dead code, since the final-stage branch above is
          // itself the unlikely path.
        }
        if (isEog) {
          await freeSession(sessionId, 'generation finished (eos)', false);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastError = message;
        log(`[local-stage-serve] frame handling FAILED sessionId=${sessionId}: ${message}`);
        await freeSession(sessionId, `host error: ${message}`, true);
      }
    })();
  }

  return {
    async handleSessionOpen(payload, peerId, callId) {
      await admitOrEnqueue({ payload, peerId, callId });
    },
    handleStageFrame,
    async handleStop(sessionId, peerId, reason) {
      const state = hostSessions.get(sessionId);
      if (!state || (peerId !== state.driverPeerId && peerId !== state.prevPeerId && peerId !== state.nextPeerId)) return;
      log(`[local-stage-serve] stage.stop from ${peerId} sessionId=${sessionId}: ${reason}`);
      await freeSession(sessionId, reason, true);
    },
    idleSweep(now, idleEvictMs = DEFAULT_IDLE_EVICT_MS) {
      for (const sessionId of [...hostSessions.keys()]) {
        const state = hostSessions.get(sessionId);
        if (state && isSessionIdle(state.lastFrameAt, now, idleEvictMs)) {
          void freeSession(sessionId, 'idle-evicted', true);
        }
      }
    },
    onRosterChange(presentPeerIds) {
      for (const [sessionId, state] of hostSessions) {
        const goneDriver = !presentPeerIds.has(state.driverPeerId);
        const gonePrev = !presentPeerIds.has(state.prevPeerId);
        const goneNext = state.nextPeerId !== undefined && !presentPeerIds.has(state.nextPeerId);
        if (goneDriver || gonePrev || goneNext) {
          const who = goneDriver ? 'driver' : gonePrev ? 'upstream' : 'downstream';
          void freeSession(sessionId, `${who} left the mesh`, true);
        }
      }
    },
    async stopAll(reason) {
      const ids = [...hostSessions.keys()];
      for (const sessionId of ids) {
        await freeSession(sessionId, reason, true);
      }
    },
    getSessions(): readonly UseStageHostSession[] {
      return Array.from(hostSessions.values()).map((s) => ({
        sessionId: s.sessionId,
        driverPeerId: s.driverPeerId,
        layerStart: s.layerStart,
        layerEnd: s.layerEnd,
        totalLayers: s.totalLayers,
        isFirst: s.isFirst,
        isFinal: s.isFinal,
        decodedCount: s.decodedCount,
        createdAt: s.createdAt,
        lastFrameAt: s.lastFrameAt,
      }));
    },
    getQueueLength() {
      return queue.length;
    },
    getLastError() {
      return lastError;
    },
    getLoadedStageEntry(): MeshLoadedStage {
      return {
        modelId: config.modelId,
        layerStart: config.layerStart,
        layerEnd: config.layerEnd,
        includeEmbeddings: client.isFirst,
        includeOutput: client.isFinal,
        ctxSize: config.ctxSize,
        wireDtype: config.wireDtype,
        maxSessions,
        activeSessions: hostSessions.size,
        epoch,
      };
    },
  };
}
