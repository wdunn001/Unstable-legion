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
  makeStageSessionOpen,
  makeStageStop,
  newSessionId,
  stageTokenCallId,
  type StageControlMessage,
  type StageLoadPayload,
} from './stageControl.js';
import { encodeStageFrameEnvelope } from './stageFrameEnvelope.js';
import { deterministicHash, type CommunalHostStageAd } from './communalTopology.js';
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

  /**
   * M2: tell every currently-assigned remote stage host this session is
   * done, on a NATURAL (non-aborted) finish — not just on abort
   * (`doAbort` already does that). Pre-M2 this didn't matter much: a
   * single-session host just got torn down by the next `stage.load`
   * anyway. Post-M2, a host can serve several concurrent sessions on one
   * loaded stage (`useStageHost.ts`), so a session that finishes cleanly
   * (hits `maxDecodeTokens` without an explicit EOS token, or gets an
   * EOS the host itself already detects and frees on) should still
   * release its lane PROMPTLY instead of waiting out the host's 5-minute
   * idle-eviction sweep — best-effort, matching `doAbort`'s fire-and-forget
   * `sendTool` discipline (a session that finished successfully shouldn't
   * be held up by a flaky notify).
   */
  function notifyRemotesDone(reason: string): void {
    const stop = makeStageStop(sessionId, reason);
    for (const peerId of currentRemotePeerIds) {
      void opts.peer.sendTool(encodeStageControl(stop), peerId).catch(() => {});
    }
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
    // M2: envelope the wire header with this session's id (see
    // stageFrameEnvelope.ts) — a host serving several concurrent driver
    // sessions needs this to route inbound `sf` bytes before it can even
    // tell "is this a header or a frame" for the right session.
    await opts.peer.sendStageFrame(encodeStageFrameEnvelope(sessionId, encoder.headerBytes()), firstRemotePeerId(p));
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
    await opts.peer.sendStageFrame(encodeStageFrameEnvelope(sessionId, bytes), peerId);
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
          // Order matters: `finish()` first (sets `finished = true`,
          // unsubscribes OUR OWN onTool listener) THEN notify — a
          // self-hosted hop's `stage.stop` loops back through the SAME
          // `peer.onTool` this driver listens on (see peer.ts's
          // self-loopback doc comment), and the 'stage.stop' branch below
          // would otherwise misread our own outbound "session's done"
          // courtesy notice as an external host telling US to replan,
          // firing a spurious 'stall' event a tick after a clean finish.
          // Reversing this order is safe: notifyRemotesDone only needs
          // `currentRemotePeerIds`/`opts.peer.sendTool`, neither of which
          // `finish()` touches.
          void finish({ aborted: false, tokens: [...promptTokens, ...generatedTokens], restartCount: restartCountValue });
          notifyRemotesDone('driver finished generation (eos)');
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
      // See the tok.done branch above for why `finish()` must run BEFORE
      // notifyRemotesDone (self-hosted-hop stage.stop echo).
      void finish({ aborted: false, tokens: [...promptTokens, ...generatedTokens], restartCount: restartCountValue });
      notifyRemotesDone('driver finished generation (maxDecodeTokens reached)');
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
        // See runDecodeLoop's tok.done branch above for why `finish()`
        // must run BEFORE notifyRemotesDone (self-hosted-hop stage.stop echo).
        void finish({ aborted: false, tokens: [...promptTokens, ...generatedTokens], restartCount: restartCountValue });
        notifyRemotesDone('driver finished generation (eos)');
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

// ── M3: communal driver session ─────────────────────────────────────────
//
// Reuses this module's own private helpers (`makeEmitter`, `meanOf`,
// `sendAndAwaitControl`) — the "shared internals" the workstream brief
// asks for are already extracted at module scope (`runDriverStageSession`
// was built from them too); this function is a sibling in the same file,
// not a fork.
//
// The DECISIVE difference from `runDriverStageSession`: attaching to a
// remote stage never LOADS a host — `useCommunalHost.ts`'s assembly loop
// already loaded+warmed it before ever advertising `cap.stageHost.
// loadedStages`, and `stage.session.open` only ever creates a NEW session
// on an already-loaded stage (see `stageControl.ts`'s doc comment).
// Attaching therefore means: preflight ping, then `stage.session.open`
// carrying the wire header up front, and on `stage.session.busy` either
// wait out the host's own queue (same callId, a later
// `stage.session.accept` arrives asynchronously) or fall through to the
// next candidate in that segment's attach order
// (`communalTopology.ts#communalAttachOrder`) — never a bare failure the
// way a legacy `stage.load` rejection is, because a communal segment
// usually has warm spares to fall back to.
//
// SCOPE NOTE (same shape as `runDriverStageSession`'s, read that one
// first): this function talks directly to the FIRST remote stage in
// `route.plan` for outbound `sf` frames and expects `stage.token`
// directly from the FINAL remote stage — i.e. it only wires the
// 2-total-stage topology (local stage 0 + ONE remote stage) end to end.
// `planCommunalRoute` CAN express multiple covered segments (multi-hop),
// but no host-side relay loop exists in this repo to forward an
// activation from one remote stage to the next (`runDriverStageSession`'s
// own SCOPE NOTE flags the identical gap as unimplemented follow-up
// work). In practice this rarely bites here: `communalAssembly.ts`'s
// capacity-capped claim lets one sufficiently spacious host claim an
// entire gap, and CHAOS.md's "minimize stage count" bias means additional
// hosts become warm SPARES (duplicate candidates on the SAME segment,
// picked via the SAME attach-order fallback this function already
// handles) rather than partial-range co-owners — the common case is
// exactly one covered segment. A multi-segment route still gets attached
// stage-by-stage below (downstream-first, matching the legacy path's
// convention) so the code is ready for a future relay loop, but only the
// LAST attached stage's token stream is actually consumed.

export interface CommunalRoute {
  /** Same `StagePlan` shape `planCommunalRoute` returns — local driver
   * stage 0 plus one `PlannedStage` per covered segment. */
  plan: StagePlan;
  /** Per remote stage (`stageIndex >= 1`, keyed exactly as `plan.stages[i]
   * .stageIndex`), the full ranked candidate list — index 0 is the peer
   * `plan.stages[i].peerId` already names, followed by warm-spare
   * fallbacks. See `communalTopology.ts#communalAttachOrder`. */
  attachOrder: ReadonlyMap<number, readonly CommunalHostStageAd[]>;
}

/**
 * Called when the orchestrator needs a fresh route (host died, graceful
 * leave, stall, or every candidate in an attach order was exhausted).
 * Real callers wire this to `buildCommunalTopology` + `planCommunalRoute`
 * against a fresh roster snapshot with `excludePeerIds: [lostPeerId]` —
 * same "re-ranking naturally prefers the previous spare" property
 * `ReplanFn`'s doc comment describes for the legacy path. Returns `null`
 * when no feasible route exists (a gap exists mesh-wide right now —
 * clean-abort case, matching `ReplanFn`'s `null` contract).
 */
export type CommunalRouteFn = (lostPeerId: string | undefined, graceful: boolean) => CommunalRoute | null;

export interface CommunalDriverSessionOptions {
  peer: StageOrchestratorPeer;
  route: CommunalRoute;
  modelId: string;
  prompt: string;
  maxDecodeTokens: number;
  localHooks: DriverStageHooks;
  replanRoute: CommunalRouteFn;
  timeouts?: StageOrchestratorTimeouts;
  /** How long to wait for a QUEUED `stage.session.open` (host replied
   * `stage.session.busy` with a `queuePosition`) to resolve into an
   * eventual `stage.session.accept` before giving up on that candidate
   * and trying the next one in the attach order. Mirrors
   * `stageSessionAdmission.ts`'s `DEFAULT_QUEUE_TTL_MS` (30s) — a queued
   * request past that TTL is dropped host-side anyway, so waiting longer
   * here would just time out for nothing. Default 30_000. */
  queueWaitMs?: number;
  /** Base for the churn replan jitter (ms) — see `computeReplanJitterMs`.
   * Default 1500. */
  replanJitterMs?: number;
  /** Same injected-hook idiom as `stageSessionAdmission.ts` /
   * `communalAssembly.ts` — scores THIS driver's own peerId for the
   * replan-jitter formula (higher priority -> shorter jitter -> recovers
   * first). Default `() => 0` until M4. */
  priorityScore?: (peerId: string) => number;
  /**
   * OPTIONAL-STAGE0 (thin drivers): when `true`, this driver hosts NO stage
   * locally — the route's FIRST remote stage is an isFirst host `[0, X)`
   * that owns the embeddings and prefills from the token-ids carried in the
   * activation-frame `tokens` sideband (see `docs/OPTIONAL-STAGE0.md`). The
   * orchestrator therefore never asks `localHooks` for a real boundary
   * activation — it ships a zero-filled placeholder activation of the right
   * shape (the isFirst host ignores it and embeds from `tokens`), and skips
   * the local KV `reset`. `localHooks.tokenize`/`detokenize`/`nEmbd` are
   * still used (all CPU, no WebGPU); `prefill`/`decode`/`reset` are NOT
   * invoked. This is a MODE FLAG on the SAME session state machine, not a
   * forked function — churn/replan/attach-order all behave identically.
   * Default `false`. */
  thinDriver?: boolean;
}

/**
 * `replanJitterMs × (1 - normalizedPriority)`, spread by
 * `hash(sessionId:restartCount)` so several concurrent chats whose
 * sessions all lost the SAME host don't all retry in lockstep (CHAOS.md's
 * "deterministic spread not dog-pile"). `normalizedPriority` is a
 * heuristic /1000 clamp pending M4's real standing scale — `priorityScore`
 * is injected specifically so that scale can change without touching this
 * formula's shape.
 */
export function computeReplanJitterMs(
  sessionId: string,
  restartCount: number,
  selfPeerId: string,
  priorityScore: (peerId: string) => number,
  baseMs: number,
): number {
  const normalizedPriority = Math.max(0, Math.min(1, priorityScore(selfPeerId) / 1000));
  const spread = deterministicHash(`${sessionId}:${restartCount}`) % Math.max(1, Math.round(baseMs / 3));
  return Math.round(baseMs * (1 - normalizedPriority)) + spread;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    return btoa(bin);
  }
  // eslint-disable-next-line no-undef
  const buf = (globalThis as unknown as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (buf) return buf.from(bytes).toString('base64');
  throw new Error('no base64 encoder available in this environment');
}

export function runCommunalDriverSession(opts: CommunalDriverSessionOptions): StageSessionHandle {
  const pingMs = opts.timeouts?.pingMs ?? 10_000;
  const loadMs = opts.timeouts?.loadMs ?? 120_000;
  const bootstrapStepMs = opts.timeouts?.bootstrapStepMs ?? 20_000;
  const stepTimeoutFloorMs = opts.timeouts?.stepTimeoutFloorMs ?? 5_000;
  const queueWaitMs = opts.queueWaitMs ?? 30_000;
  const replanJitterMs = opts.replanJitterMs ?? 1500;
  const priorityScore = opts.priorityScore ?? (() => 0);
  const thinDriver = opts.thinDriver ?? false;

  // OPTIONAL-STAGE0: in thin mode the local hooks never touch a stage-0
  // worker — `prefill`/`decode` return a zero-filled activation of the wire
  // shape the isFirst remote host expects but IGNORES (it embeds from the
  // frame's `tokens` sideband instead), and `reset` is a no-op (no local KV
  // to drop). `tokenize`/`detokenize`/`nEmbd` pass through unchanged. This is
  // the whole of the "mode flag, not a function fork": the rest of the
  // session machine below is byte-for-byte the capable-driver path.
  const nEmbd = opts.localHooks.nEmbd;
  const hooks: DriverStageHooks = thinDriver
    ? {
        nEmbd,
        tokenize: (text) => opts.localHooks.tokenize(text),
        detokenize: (tokens) => opts.localHooks.detokenize(tokens),
        reset: async () => {},
        prefill: async (tokens) => ({ activation: new Float32Array(Math.max(1, tokens.length) * nEmbd) }),
        decode: async () => ({ activation: new Float32Array(nEmbd) }),
      }
    : opts.localHooks;

  const emitter = makeEmitter();
  let route = opts.route;
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

  let currentRemotePeerIds: Set<string> = new Set();
  let sessionAbortController: { cancelled: boolean } = { cancelled: false };

  const unsubTool = opts.peer.onTool((frame, peerId) => {
    if (!isStageControlFrame(frame)) return;
    if (frame.kind === 'result') {
      const settled = controlTracker.settle(frame) || tokenTracker.settle(frame);
      if (!settled) return;
      const decoded = decodeStageControl(frame);
      if (!decoded) return;
      if (decoded.kind === 'stage.token') {
        emitter.emit({ type: 'token', token: decoded.payload.token, seq: decoded.payload.seq, done: decoded.payload.done });
      } else if (decoded.kind === 'stage.progress') {
        const stageIndex = route.plan.stages.find((s) => s.peerId === peerId)?.stageIndex ?? -1;
        emitter.emit({ type: 'progress', stageIndex, tokensDecoded: decoded.payload.tokensDecoded });
      }
      return;
    }
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

  /** Same idea as the legacy path's `notifyRemotesDone` — extended here
   * to the session-open origin: `stage.stop` frees a session regardless
   * of whether it was opened via legacy `stage.load` or `stage.session.
   * open` (`useStageHost.ts`'s `handleStop` looks the session up by
   * sessionId alone, origin-agnostic), so no separate "session done"
   * control kind is needed — this is the SAME wire message, just sent on
   * every natural finish here too. */
  function notifyRemotesDone(reason: string): void {
    const stop = makeStageStop(sessionId, reason);
    for (const peerId of currentRemotePeerIds) {
      void opts.peer.sendTool(encodeStageControl(stop), peerId).catch(() => {});
    }
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

  interface Attached {
    peerId: string;
    wireDtype: 'f32' | 'f16';
    nEmbd: number;
    isFirst: boolean;
    isFinal: boolean;
    encoder: ActivationWireEncoder;
  }

  /** Attach to one remote stage: preflight ping -> `stage.session.open`
   * (wire header embedded, built fresh per candidate since candidates in
   * the SAME segment could in principle have committed different
   * wireDtypes) -> on `stage.session.busy` either wait out the host's own
   * queue (same callId) or fall through to the next candidate. Throws
   * only once every candidate in `candidates` has been tried and failed. */
  async function attachOneStage(stageIndex: number, candidates: readonly CommunalHostStageAd[]): Promise<Attached> {
    let lastErr: unknown;
    for (const cand of candidates) {
      if (sessionAbortController.cancelled) throw new Error('attach cancelled (superseded by a newer replan)');
      try {
        const ping = makeStagePing(sessionId);
        const pongReply = await sendAndAwaitControl(opts.peer, controlTracker, ping, cand.peerId, pingMs);
        if (pongReply.kind !== 'stage.pong') {
          lastErr = new Error(`unexpected reply to stage.ping from ${cand.peerId}: ${pongReply.kind}`);
          continue;
        }

        const candEncoder = createActivationWireEncoder({
          modelId: opts.modelId,
          stageIndex: 0,
          nEmbd: opts.localHooks.nEmbd,
          dtype: cand.wireDtype,
        });
        const open = makeStageSessionOpen(sessionId, {
          modelId: opts.modelId,
          layerStart: cand.layerStart,
          layerEnd: cand.layerEnd,
          totalLayers: route.plan.totalLayers,
          ctxSize: cand.ctxSize,
          wireDtype: cand.wireDtype,
          wireHeader: bytesToBase64(candEncoder.headerBytes()),
        });
        const reply = await sendAndAwaitControl(opts.peer, controlTracker, open, cand.peerId, loadMs);
        if (reply.kind === 'stage.session.accept') {
          return {
            peerId: cand.peerId,
            wireDtype: cand.wireDtype,
            nEmbd: reply.payload.nEmbd,
            isFirst: reply.payload.isFirst,
            isFinal: reply.payload.isFinal,
            encoder: candEncoder,
          };
        }
        if (reply.kind === 'stage.session.busy') {
          if (reply.payload.queuePosition !== undefined) {
            try {
              const queuedReply = await controlTracker.expect(open.callId, queueWaitMs);
              const decoded = decodeStageControl({ kind: 'result', ...queuedReply });
              if (decoded?.kind === 'stage.session.accept') {
                return {
                  peerId: cand.peerId,
                  wireDtype: cand.wireDtype,
                  nEmbd: decoded.payload.nEmbd,
                  isFirst: decoded.payload.isFirst,
                  isFinal: decoded.payload.isFinal,
                  encoder: candEncoder,
                };
              }
              lastErr = new Error(`queued session-open for ${cand.peerId} resolved to ${decoded?.kind ?? 'unparsable'} instead of accept`);
            } catch (err) {
              lastErr = err;
            }
          } else {
            lastErr = new Error(`${cand.peerId} rejected session-open (its queue is full)`);
          }
          continue; // fall through to the next candidate — a busy host is not a dead one
        }
        lastErr = new Error(`unexpected reply to stage.session.open from ${cand.peerId}: ${reply.kind}`);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`attach exhausted all ${candidates.length} candidate(s) for stage ${stageIndex}`);
  }

  function firstRemotePeerId(): string {
    if (currentRemotePeerIds.size === 0) throw new Error('no remote stage attached — nothing to send sf frames to');
    // SCOPE NOTE (top of this section): only the 2-total-stage topology is
    // wired end to end, so there is always exactly one remote peer once
    // attached.
    return [...currentRemotePeerIds][0]!;
  }

  async function startCommunalSession(r: CommunalRoute): Promise<void> {
    const remoteStages = [...r.plan.stages].filter((s) => s.stageIndex > 0).sort((a, b) => b.stageIndex - a.stageIndex);
    if (remoteStages.length === 0) throw new Error('communal route has no remote stages to attach');
    currentRemotePeerIds = new Set();
    emitter.emit({ type: 'planCreated', plan: r.plan });
    let winner: Attached | undefined;
    for (const stage of remoteStages) {
      const candidates = r.attachOrder.get(stage.stageIndex) ?? [];
      if (candidates.length === 0) throw new Error(`route has no attach candidates for stage ${stage.stageIndex}`);
      const attached = await attachOneStage(stage.stageIndex, candidates);
      currentRemotePeerIds.add(attached.peerId);
      emitter.emit({ type: 'stageReady', stageIndex: stage.stageIndex, peerId: attached.peerId });
      winner = attached;
    }
    await hooks.reset();
    // winner is defined: remoteStages.length > 0 was checked above, and
    // attachOneStage either returns or throws (never leaves it unset).
    encoder = winner!.encoder;
    // No header sf frame here — unlike the legacy path, `stage.session.
    // open`'s `wireHeader` field already carried it (see this section's
    // top doc comment); the very first `sf` send below is a real
    // prefill frame.
  }

  async function sendFrameAndAwaitToken(
    bytes: Uint8Array,
    peerId: string,
    seq: number,
    timeoutMs: number,
  ): Promise<{ token: number; done: boolean; finishReason?: string }> {
    const waiter = tokenTracker.expect(stageTokenCallId(sessionId, seq), timeoutMs);
    await opts.peer.sendStageFrame(encodeStageFrameEnvelope(sessionId, bytes), peerId);
    const reply = await waiter;
    const decoded = decodeStageControl({ kind: 'result', ...reply });
    if (!decoded || decoded.kind !== 'stage.token') throw new Error(`expected stage.token for seq=${seq}, got ${decoded?.kind ?? 'unparsable'}`);
    return { token: decoded.payload.token, done: decoded.payload.done, finishReason: decoded.payload.finishReason };
  }

  async function triggerReplan(lostPeerId: string | undefined, graceful: boolean, reason: string): Promise<void> {
    if (aborted || finished) return;
    sessionAbortController.cancelled = true;
    emitter.emit({ type: 'stall', reason });
    controlTracker.abortAll(`replanning: ${reason}`);
    tokenTracker.abortAll(`replanning: ${reason}`);

    // Churn-jitter (CHAOS.md "deterministic spread not dog-pile"): several
    // concurrent chats that all lost the SAME host shouldn't all hammer
    // `replanRoute`/re-attach in the same tick.
    const jitterMs = computeReplanJitterMs(sessionId, restartCountValue + 1, opts.peer.selfId, priorityScore, replanJitterMs);
    if (jitterMs > 0) await new Promise((resolve) => setTimeout(resolve, jitterMs));
    if (aborted || finished) return;

    const newRoute = opts.replanRoute(lostPeerId, graceful);
    if (!newRoute) {
      doAbort(`no eligible communal route after losing ${lostPeerId ?? '(unknown peer)'}: ${reason}`);
      return;
    }
    restartCountValue += 1;
    route = newRoute;
    sessionId = newSessionId();
    sessionAbortController = { cancelled: false };
    emitter.emit({ type: 'replan', lostPeerId, graceful, plan: newRoute.plan, restartCount: restartCountValue });

    try {
      await startCommunalSession(newRoute);
      // Continue-from-history: re-prefill in <=256-tok chunks (CHAOS.md /
      // the plan doc's churn requirement) rather than one unbounded
      // prefill — a long-running chat's history could otherwise blow the
      // bootstrap timeout on a cold re-attach.
      const history = [...promptTokens, ...generatedTokens];
      const CHUNK = 256;
      let lastActivation: Float32Array | undefined;
      for (let i = 0; i < history.length; i += CHUNK) {
        const chunk = history.slice(i, i + CHUNK);
        const positions = chunk.map((_, j) => i + j);
        const { activation } = await hooks.prefill(chunk, positions);
        lastActivation = activation;
      }
      const frame = encoder!.encodeFrame(lastActivation!, { seq: 0, posStart: 0, tokens: history, done: false });
      const tok = await sendFrameAndAwaitToken(frame, firstRemotePeerId(), 0, bootstrapStepMs);
      generatedTokens.push(tok.token);
      void runDecodeLoop(1);
    } catch (err) {
      doAbort(err instanceof Error ? err.message : String(err));
    }
  }

  async function runDecodeLoop(startAt: number): Promise<void> {
    const myAbortController = sessionAbortController;
    let stepTimeoutMs = bootstrapStepMs;
    const tpotSamples: number[] = [];
    for (let seq = startAt; generatedTokens.length < opts.maxDecodeTokens; seq++) {
      if (aborted || myAbortController.cancelled) return;
      const last = generatedTokens[generatedTokens.length - 1];
      if (last === undefined) return;
      try {
        const { activation } = await hooks.decode(last);
        const posStart = promptTokens.length + generatedTokens.length - 1;
        const frame = encoder!.encodeFrame(activation, {
          seq,
          posStart,
          tokens: [last],
          done: generatedTokens.length === opts.maxDecodeTokens - 1,
        });
        const sendStart = Date.now();
        const tok = await sendFrameAndAwaitToken(frame, firstRemotePeerId(), seq, stepTimeoutMs);
        if (myAbortController.cancelled) return;
        const stepMs = Date.now() - sendStart;
        tpotSamples.push(stepMs);
        stepTimeoutMs = Math.max(stepTimeoutFloorMs, 10 * meanOf(tpotSamples));
        generatedTokens.push(tok.token);
        if (tok.done) {
          // Order matters: `finish()` first (sets `finished = true`,
          // unsubscribes OUR OWN onTool listener) THEN notify — a
          // self-hosted hop's `stage.stop` loops back through the SAME
          // `peer.onTool` this driver listens on (see peer.ts's
          // self-loopback doc comment), and the 'stage.stop' branch below
          // would otherwise misread our own outbound "session's done"
          // courtesy notice as an external host telling US to replan,
          // firing a spurious 'stall' event a tick after a clean finish.
          // Reversing this order is safe: notifyRemotesDone only needs
          // `currentRemotePeerIds`/`opts.peer.sendTool`, neither of which
          // `finish()` touches.
          void finish({ aborted: false, tokens: [...promptTokens, ...generatedTokens], restartCount: restartCountValue });
          notifyRemotesDone('driver finished generation (eos)');
          emitter.emit({ type: 'finished', tokens: [...promptTokens, ...generatedTokens], restartCount: restartCountValue });
          return;
        }
      } catch (err) {
        if (myAbortController.cancelled) return;
        void triggerReplan(firstRemotePeerId(), false, err instanceof Error ? err.message : String(err));
        return;
      }
    }
    if (!aborted && !finished) {
      // See the tok.done branch above for why `finish()` must run BEFORE
      // notifyRemotesDone (self-hosted-hop stage.stop echo).
      void finish({ aborted: false, tokens: [...promptTokens, ...generatedTokens], restartCount: restartCountValue });
      notifyRemotesDone('driver finished generation (maxDecodeTokens reached)');
      emitter.emit({ type: 'finished', tokens: [...promptTokens, ...generatedTokens], restartCount: restartCountValue });
    }
  }

  void (async () => {
    try {
      promptTokens = await hooks.tokenize(opts.prompt);
      await startCommunalSession(route);
      const positions = promptTokens.map((_, i) => i);
      const { activation } = await hooks.prefill(promptTokens, positions);
      const frame = encoder!.encodeFrame(activation, { seq: 0, posStart: 0, tokens: promptTokens, done: false });
      const tok = await sendFrameAndAwaitToken(frame, firstRemotePeerId(), 0, bootstrapStepMs);
      generatedTokens.push(tok.token);
      if (tok.done) {
        // See runDecodeLoop's tok.done branch above for why `finish()`
        // must run BEFORE notifyRemotesDone (self-hosted-hop stage.stop echo).
        void finish({ aborted: false, tokens: [...promptTokens, ...generatedTokens], restartCount: restartCountValue });
        notifyRemotesDone('driver finished generation (eos)');
        emitter.emit({ type: 'finished', tokens: [...promptTokens, ...generatedTokens], restartCount: restartCountValue });
        return;
      }
      void runDecodeLoop(1);
    } catch (err) {
      if (aborted) return;
      // Deliberate divergence from the legacy path's initial-failure
      // handling (`runDriverStageSession` just aborts): a communal route
      // carries built-in redundancy (warm-spare candidates per segment,
      // `attachOrder`'s busy-fallback already tried them all before this
      // throw fires) — a fresh `replanRoute()` call against updated
      // topology is cheap and often succeeds even when every candidate in
      // the ORIGINAL route was unavailable (a peer that died between
      // planning and attaching, a transient queue-full on every spare).
      // `triggerReplan` re-attaches from a NEW route and, since
      // `generatedTokens` is still empty at this point, its
      // continue-from-history re-prefill is equivalent to a plain first
      // prefill — this is not a special case, just the normal replan path
      // invoked one step earlier than usual. A second failure still
      // aborts cleanly (triggerReplan's own try/catch).
      void triggerReplan(undefined, false, err instanceof Error ? err.message : String(err));
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
