/**
 * Phase C — driver-side stage-session orchestrator.
 *
 * Ports the harness's proven Phase B driver protocol
 * (H:\dev\legion-stage-runtime\harness\src\p2p\driver.ts) onto mesh-core's
 * `Peer` (tc for control, sf for activation frames — see `stageControl.ts`
 * and `peer.ts`) and generalizes it with the chaos-resilience behaviors
 * `docs/CHAOS.md` describes as "Phase C orchestrator" work:
 *
 *   preflight ping every planned host → downstream-first stage.load
 *   (final stage first, walking upstream) → readiness barrier → decode
 *   loop (hooks injected — mesh-core stays engine-agnostic; the actual
 *   wasm/WebGPU stage runtime is wired by the demo layer) → on host
 *   death/graceful-leave/stall, abort → continue-from-history replan.
 *
 * SCOPE NOTE (read before extending): this module always assumes the
 * local peer runs stage 0 (the harness's exact proven topology — local
 * stage-A + N remote stages). It talks directly to `plan.stages[1]`'s
 * peer for outbound `sf` frames and expects `stage.token` to arrive
 * DIRECTLY from `plan.stages[stages.length-1]`'s peer ("direct token
 * return", matching the harness comment in host.ts — no relay hop). For
 * a 2-stage plan (1 local + 1 remote) this is exactly Phase B, proven.
 * For N>2 stages, the intermediate hosts (stage 1..N-2) are each
 * expected to run their OWN mesh-core-based host-loop that receives an
 * `sf` frame, computes its slice, and forwards the boundary activation
 * to the next stage's peer — that host-role loop is NOT implemented in
 * this pass (out of mesh-core's boundary per the workstream brief:
 * "driver's local stage-A execution is wired by the demo layer", and by
 * the same logic, other stages' engine execution is also demo/host-layer
 * work). Follow-up: a symmetric `runStageHostSession` counterpart.
 *
 * VERSION NOTE: this stays MESH_PROTOCOL_VERSION-compatible (v1,
 * additive) — no subprotocol/generation bump (assessment doc §2.4) is
 * implemented here; that's explicitly out of scope for this pass.
 */
import {
  createActivationWireEncoder,
  type ActivationWireEncoder,
} from '@unstable-legion/stage-runtime';
import { PendingToolCallTracker } from './tools.js';
import {
  decodeStageControl,
  encodeStageControl,
  isStageControlFrame,
  makeStageLoad,
  makeStagePing,
  makeStageStop,
  newSessionId,
  stageTokenCallId,
  type StageControlMessage,
  type StageLoadPayload,
} from './stageControl.js';
import type { MeshToolFrame } from './types.js';
import type { StagePlan } from './stagePlanner.js';

// ── Injected hooks (engine-agnostic boundary) ───────────────────────────

/**
 * Local stage-0 execution, injected by the caller (the demo layer owns
 * the actual wasm/WebGPU `StageHandle`). The orchestrator never imports
 * `@unstable-legion/stage-runtime`'s `StageHandle` directly — it only
 * needs activations in/out.
 */
export interface DriverStageHooks {
  readonly nEmbd: number;
  tokenize(text: string): Promise<number[]>;
  detokenize(tokens: readonly number[]): Promise<string>;
  /** Drop local KV state; called before the first prefill and again
   * before every continue-from-history re-prefill. */
  reset(): Promise<void>;
  /** Prefill a chunk of tokens (full prompt on first run; prompt+history
   * on a continue-from-history restart), return the boundary activation. */
  prefill(tokens: readonly number[], positions: readonly number[]): Promise<{ activation: Float32Array }>;
  /** One local decode step for `token`, return the boundary activation. */
  decode(token: number): Promise<{ activation: Float32Array }>;
}

// ── Options ──────────────────────────────────────────────────────────────

export interface StageOrchestratorTimeouts {
  /** Preflight stage.ping -> stage.pong timeout. Default 10_000. */
  pingMs?: number;
  /** stage.load -> stage.ready timeout (model fetch across LAN/WAN). Default 120_000. */
  loadMs?: number;
  /** Per-step decode timeout before a TPOT estimate exists. Default 20_000. */
  bootstrapStepMs?: number;
  /** Floor for the adaptive 10x-TPOT per-step timeout. Default 5_000. */
  stepTimeoutFloorMs?: number;
}

/** Minimal `Peer` surface the orchestrator needs — kept narrow so tests
 * can supply a mock without implementing the full mesh-core `Peer`. */
export interface StageOrchestratorPeer {
  readonly selfId: string;
  sendTool(frame: MeshToolFrame, peers?: string | string[]): Promise<void>;
  onTool(cb: (frame: MeshToolFrame, peerId: string) => void): () => void;
  sendStageFrame(bytes: Uint8Array, peers?: string | string[]): Promise<void>;
  onStageFrame(cb: (bytes: Uint8Array, peerId: string) => void): () => void;
}

/**
 * Called when the orchestrator needs a replacement plan (host died,
 * graceful leave, or stall). Real callers wire this to `planPipeline`
 * with the original request + a fresh roster snapshot + `excludePeerIds:
 * [lostPeerId]` — `planPipeline`'s capacity/stability ranking naturally
 * re-selects the previous plan's `hotSparePeerId` whenever it's still
 * the best remaining candidate, so "prefer hotSpare" falls out of
 * re-ranking rather than needing a special-cased first-try-the-spare
 * path. Returns `null` when no feasible replacement exists (clean-abort
 * case).
 */
export type ReplanFn = (lostPeerId: string | undefined, graceful: boolean) => StagePlan | null;

export interface DriverStageSessionOptions {
  peer: StageOrchestratorPeer;
  plan: StagePlan;
  modelId: string;
  prompt: string;
  maxDecodeTokens: number;
  wireDtype: 'f32' | 'f16';
  localHooks: DriverStageHooks;
  replan: ReplanFn;
  /** manifestUrl/shardUrls to send in stage.load for each remote stage —
   * keyed by stageIndex. The orchestrator doesn't know artifact URLs
   * (that's planner/catalog knowledge upstream of it). */
  loadExtras: (stageIndex: number, plan: StagePlan) => Pick<StageLoadPayload, 'manifestUrl' | 'shardUrls' | 'ctxSize'>;
  timeouts?: StageOrchestratorTimeouts;
}

// ── Events ───────────────────────────────────────────────────────────────

export type StageOrchestratorEvent =
  | { type: 'planCreated'; plan: StagePlan }
  | { type: 'stageReady'; stageIndex: number; peerId: string }
  | { type: 'token'; token: number; seq: number; done: boolean }
  | { type: 'progress'; stageIndex: number; tokensDecoded: number }
  | { type: 'stall'; reason: string }
  | { type: 'replan'; lostPeerId?: string; graceful: boolean; plan: StagePlan; restartCount: number }
  | { type: 'aborted'; reason: string }
  | { type: 'finished'; tokens: readonly number[]; restartCount: number };

export type StageOrchestratorListener = (ev: StageOrchestratorEvent) => void;

export interface StageSessionResult {
  aborted: boolean;
  abortReason?: string;
  tokens: readonly number[];
  restartCount: number;
}

export interface StageSessionHandle {
  readonly sessionId: string;
  on(listener: StageOrchestratorListener): () => void;
  /** Full token history so far — prompt + everything generated,
   * including across replans (continue-from-history). */
  tokenHistory(): { promptTokens: readonly number[]; generatedTokens: readonly number[] };
  restartCount(): number;
  /** Resolves when the session finishes or hard-aborts. Never rejects —
   * abort is reported via `.aborted`/`.abortReason`, matching the
   * harness's `PhaseBReport` shape. */
  result(): Promise<StageSessionResult>;
  /** Abort the session for an external reason (e.g. caller cancellation). */
  abort(reason: string): void;
}

// ── Tiny emitter ─────────────────────────────────────────────────────────

function makeEmitter(): { on: (l: StageOrchestratorListener) => () => void; emit: (ev: StageOrchestratorEvent) => void } {
  const listeners = new Set<StageOrchestratorListener>();
  return {
    on(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    emit(ev) {
      for (const l of listeners) l(ev);
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function meanOf(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

/**
 * Send a "call"-shaped stage-control message and await the correlated
 * "result"-shaped reply on the same callId — e.g. stage.load waits for
 * stage.ready, stage.ping waits for stage.pong. `tracker.settle()` is
 * fed by the caller's shared `onTool` handler (see `runDriverStageSession`).
 */
async function sendAndAwaitControl(
  peer: StageOrchestratorPeer,
  tracker: PendingToolCallTracker,
  msg: StageControlMessage,
  peerId: string,
  timeoutMs: number,
): Promise<StageControlMessage> {
  const waiter = tracker.expect(msg.callId, timeoutMs);
  await peer.sendTool(encodeStageControl(msg), peerId);
  const reply = await waiter;
  const decoded = decodeStageControl({ kind: 'result', ...reply });
  if (!decoded) throw new Error(`malformed reply to ${msg.kind} (callId=${msg.callId})`);
  return decoded;
}

// ── Driver session ───────────────────────────────────────────────────────

export function runDriverStageSession(opts: DriverStageSessionOptions): StageSessionHandle {
  const pingMs = opts.timeouts?.pingMs ?? 10_000;
  const loadMs = opts.timeouts?.loadMs ?? 120_000;
  const bootstrapStepMs = opts.timeouts?.bootstrapStepMs ?? 20_000;
  const stepTimeoutFloorMs = opts.timeouts?.stepTimeoutFloorMs ?? 5_000;

  const emitter = makeEmitter();
  let plan = opts.plan;
  let sessionId = newSessionId();
  let restartCountValue = 0;
  let promptTokens: number[] = [];
  const generatedTokens: number[] = [];
  let aborted = false;
  let abortReason: string | undefined;
  let encoder: ActivationWireEncoder | undefined;

  const controlTracker = new PendingToolCallTracker();
  const tokenTracker = new PendingToolCallTracker();

  let resolveResult!: (r: StageSessionResult) => void;
  const resultPromise = new Promise<StageSessionResult>((resolve) => {
    resolveResult = resolve;
  });
  let finished = false;

  // Peers we currently expect traffic from — used to detect "did the
  // peer that just left matter to us" without depending on Roster.
  let currentRemotePeerIds: Set<string> = new Set();
  let sessionAbortController: { cancelled: boolean } = { cancelled: false };

  const unsubTool = opts.peer.onTool((frame, peerId) => {
    if (!isStageControlFrame(frame)) return;
    if (frame.kind === 'result') {
      const settled = controlTracker.settle(frame) || tokenTracker.settle(frame);
      if (!settled) return; // stray/duplicate — ignore
      const decoded = decodeStageControl(frame);
      if (!decoded) return;
      if (decoded.kind === 'stage.token') {
        emitter.emit({ type: 'token', token: decoded.payload.token, seq: decoded.payload.seq, done: decoded.payload.done });
      } else if (decoded.kind === 'stage.progress') {
        const stageIndex = plan.stages.findIndex((s) => s.peerId === peerId);
        emitter.emit({ type: 'progress', stageIndex, tokensDecoded: decoded.payload.tokensDecoded });
      }
      return;
    }
    // 'call'-shaped inbound: only stage.stop matters to a driver (a host
    // announcing it's going away — pagehide etc.). Trigger an instant
    // replan, no timeout wait (CHAOS.md Layer 1/2).
    const decoded = decodeStageControl(frame);
    if (decoded?.kind === 'stage.stop' && currentRemotePeerIds.has(peerId)) {
      void triggerReplan(peerId, true, `host requested stop: ${decoded.payload.reason}`);
    }
  });

  async function finish(result: StageSessionResult): Promise<void> {
    if (finished) return;
    finished = true;
    unsubTool();
    resolveResult(result);
  }

  function doAbort(reason: string): void {
    if (aborted) return;
    aborted = true;
    abortReason = reason;
    sessionAbortController.cancelled = true;
    const stop = makeStageStop(sessionId, reason);
    for (const peerId of currentRemotePeerIds) {
      void opts.peer.sendTool(encodeStageControl(stop), peerId).catch(() => {});
    }
    controlTracker.abortAll(reason);
    tokenTracker.abortAll(reason);
    emitter.emit({ type: 'aborted', reason });
    void finish({ aborted: true, abortReason: reason, tokens: [...promptTokens, ...generatedTokens], restartCount: restartCountValue });
  }

  /** Preflight-ping every remote stage host in `p`. Rejects on the first failure. */
  async function preflightAll(p: StagePlan): Promise<void> {
    const remoteStages = p.stages.filter((s) => s.stageIndex > 0);
    await Promise.all(
      remoteStages.map(async (stage) => {
        const ping = makeStagePing(sessionId);
        const reply = await sendAndAwaitControl(opts.peer, controlTracker, ping, stage.peerId, pingMs);
        if (reply.kind !== 'stage.pong') throw new Error(`unexpected reply to stage.ping from ${stage.peerId}: ${reply.kind}`);
      }),
    );
  }

  /** Downstream-first load: final stage first, walking upstream to stage 1. */
  async function loadDownstreamFirst(p: StagePlan): Promise<void> {
    const remoteStages = [...p.stages].filter((s) => s.stageIndex > 0).sort((a, b) => b.stageIndex - a.stageIndex);
    for (const stage of remoteStages) {
      const extras = opts.loadExtras(stage.stageIndex, p);
      const load = makeStageLoad(sessionId, {
        modelId: opts.modelId,
        layerStart: stage.layerStart,
        layerEnd: stage.layerEnd,
        totalLayers: p.totalLayers,
        includeEmbeddings: stage.isFirst,
        includeOutput: stage.isFinal,
        wireDtype: opts.wireDtype,
        ...extras,
      });
      const reply = await sendAndAwaitControl(opts.peer, controlTracker, load, stage.peerId, loadMs);
      if (reply.kind !== 'stage.ready') throw new Error(`unexpected reply to stage.load from ${stage.peerId}: ${reply.kind}`);
      emitter.emit({ type: 'stageReady', stageIndex: stage.stageIndex, peerId: stage.peerId });
    }
  }

  function firstRemotePeerId(p: StagePlan): string {
    const s = p.stages.find((st) => st.stageIndex === 1);
    if (!s) throw new Error('plan has no remote stage 1 — nothing to send sf frames to');
    return s.peerId;
  }
  function finalPeerId(p: StagePlan): string {
    return p.stages[p.stages.length - 1]!.peerId;
  }

  async function startSession(p: StagePlan): Promise<void> {
    currentRemotePeerIds = new Set(p.stages.filter((s) => s.stageIndex > 0).map((s) => s.peerId));
    emitter.emit({ type: 'planCreated', plan: p });
    await preflightAll(p);
    await loadDownstreamFirst(p);
    await opts.localHooks.reset();
    encoder = createActivationWireEncoder({
      modelId: opts.modelId,
      stageIndex: 0,
      nEmbd: opts.localHooks.nEmbd,
      dtype: opts.wireDtype,
    });
    await opts.peer.sendStageFrame(encoder.headerBytes(), firstRemotePeerId(p));
  }

  /**
   * Send an `sf` activation frame and await its correlated `stage.token`
   * reply. The tracker waiter is registered BEFORE the send (same
   * discipline as `sendAndAwaitControl` / `skillResolver.ts`'s
   * `sendAndAwait`) — register-then-send, never send-then-register.
   * Reversing that order is a real hazard, not just tidiness: it races
   * the reply against the waiter's own registration whenever a reply
   * can arrive on the same microtask turn as the send (true of a mock
   * transport in tests, and not something the wire protocol should
   * silently depend on being false in production either).
   */
  async function sendFrameAndAwaitToken(
    bytes: Uint8Array,
    peerId: string,
    seq: number,
    timeoutMs: number,
  ): Promise<{ token: number; done: boolean; finishReason?: string }> {
    const waiter = tokenTracker.expect(stageTokenCallId(sessionId, seq), timeoutMs);
    await opts.peer.sendStageFrame(bytes, peerId);
    const reply = await waiter;
    const decoded = decodeStageControl({ kind: 'result', ...reply });
    if (!decoded || decoded.kind !== 'stage.token') throw new Error(`expected stage.token for seq=${seq}, got ${decoded?.kind ?? 'unparsable'}`);
    return { token: decoded.payload.token, done: decoded.payload.done, finishReason: decoded.payload.finishReason };
  }

  async function triggerReplan(lostPeerId: string | undefined, graceful: boolean, reason: string): Promise<void> {
    if (aborted || finished) return;
    sessionAbortController.cancelled = true; // stop the in-flight decode loop iteration
    emitter.emit({ type: 'stall', reason });
    controlTracker.abortAll(`replanning: ${reason}`);
    tokenTracker.abortAll(`replanning: ${reason}`);

    const newPlan = opts.replan(lostPeerId, graceful);
    if (!newPlan) {
      doAbort(`no eligible replacement plan after losing ${lostPeerId ?? '(unknown peer)'}: ${reason}`);
      return;
    }
    restartCountValue += 1;
    plan = newPlan;
    sessionId = newSessionId();
    sessionAbortController = { cancelled: false };
    emitter.emit({ type: 'replan', lostPeerId, graceful, plan: newPlan, restartCount: restartCountValue });

    try {
      await startSession(newPlan);
      // Continue-from-history: re-prefill the FULL history (prompt + every
      // token generated so far across all restarts) through the new
      // pipeline, then resume decode from where we left off.
      const history = [...promptTokens, ...generatedTokens];
      const positions = history.map((_, i) => i);
      const { activation } = await opts.localHooks.prefill(history, positions);
      const frame = encoder!.encodeFrame(activation, { seq: 0, posStart: 0, tokens: history, done: false });
      const tok = await sendFrameAndAwaitToken(frame, firstRemotePeerId(newPlan), 0, bootstrapStepMs);
      generatedTokens.push(tok.token);
      // No emitter.emit('token', ...) here — the shared onTool handler
      // already emits it for every inbound stage.token result.
      void runDecodeLoop(1); // resume from step 1 of THIS session's local seq counter
    } catch (err) {
      doAbort(err instanceof Error ? err.message : String(err));
    }
  }

  async function runDecodeLoop(startAt: number): Promise<void> {
    const myAbortController = sessionAbortController;
    let stepTimeoutMs = bootstrapStepMs;
    const tpotSamples: number[] = [];
    for (let seq = startAt; generatedTokens.length < opts.maxDecodeTokens; seq++) {
      if (aborted || myAbortController.cancelled) return; // superseded by a replan or hard abort
      const last = generatedTokens[generatedTokens.length - 1];
      if (last === undefined) return; // nothing to continue from (shouldn't happen post-prefill)
      try {
        const { activation } = await opts.localHooks.decode(last);
        const posStart = promptTokens.length + generatedTokens.length - 1;
        const frame = encoder!.encodeFrame(activation, {
          seq,
          posStart,
          tokens: [last],
          done: generatedTokens.length === opts.maxDecodeTokens - 1,
        });
        const sendStart = Date.now();
        const tok = await sendFrameAndAwaitToken(frame, firstRemotePeerId(plan), seq, stepTimeoutMs);
        if (myAbortController.cancelled) return; // a replan raced us while awaiting
        const stepMs = Date.now() - sendStart;
        tpotSamples.push(stepMs);
        stepTimeoutMs = Math.max(stepTimeoutFloorMs, 10 * meanOf(tpotSamples));
        generatedTokens.push(tok.token);
        if (tok.done) {
          void finish({ aborted: false, tokens: [...promptTokens, ...generatedTokens], restartCount: restartCountValue });
          emitter.emit({ type: 'finished', tokens: [...promptTokens, ...generatedTokens], restartCount: restartCountValue });
          return;
        }
      } catch (err) {
        if (myAbortController.cancelled) return; // already superseded, don't double-replan
        void triggerReplan(finalPeerId(plan), false, err instanceof Error ? err.message : String(err));
        return;
      }
    }
    if (!aborted && !finished) {
      void finish({ aborted: false, tokens: [...promptTokens, ...generatedTokens], restartCount: restartCountValue });
      emitter.emit({ type: 'finished', tokens: [...promptTokens, ...generatedTokens], restartCount: restartCountValue });
    }
  }

  // ── Kick off ─────────────────────────────────────────────────────────
  void (async () => {
    try {
      promptTokens = await opts.localHooks.tokenize(opts.prompt);
      await startSession(plan);
      const positions = promptTokens.map((_, i) => i);
      const { activation } = await opts.localHooks.prefill(promptTokens, positions);
      const frame = encoder!.encodeFrame(activation, { seq: 0, posStart: 0, tokens: promptTokens, done: false });
      const tok = await sendFrameAndAwaitToken(frame, firstRemotePeerId(plan), 0, bootstrapStepMs);
      generatedTokens.push(tok.token);
      if (tok.done) {
        void finish({ aborted: false, tokens: [...promptTokens, ...generatedTokens], restartCount: restartCountValue });
        emitter.emit({ type: 'finished', tokens: [...promptTokens, ...generatedTokens], restartCount: restartCountValue });
        return;
      }
      void runDecodeLoop(1);
    } catch (err) {
      if (!aborted) doAbort(err instanceof Error ? err.message : String(err));
    }
  })();

  return {
    get sessionId() {
      return sessionId;
    },
    on: emitter.on,
    tokenHistory: () => ({ promptTokens: [...promptTokens], generatedTokens: [...generatedTokens] }),
    restartCount: () => restartCountValue,
    result: () => resultPromise,
    abort: (reason) => doAbort(reason),
  };
}
