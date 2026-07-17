/**
 * useCommunalChat — the MINIMAL driver-side caller for
 * `runCommunalDriverSession` (mesh-core's `stageOrchestrator.ts`). Closes
 * the gap `docs/COMMUNAL.md`'s "What's NOT done" section flagged as the
 * single largest remaining piece of M3: nothing in this repo built the
 * `CommunalRoute`/`CommunalRouteFn` a real driver page needs (roster ->
 * `buildCommunalTopology` -> `planCommunalRoute` + `communalAttachOrder` ->
 * the shapes `runCommunalDriverSession` expects) or wired it into
 * something a Playwright test could drive.
 *
 * Deliberately NOT the full OWUI-style chat UI (that's M5/product-
 * integration work) — this hook is the same altitude as `useStagePipeline`
 * (Phase C's legacy driver hook), generalized to the coordinator-free
 * communal path:
 *
 *   1. Host stage 0 LOCALLY, covering `[0, driverLayers)` — every communal
 *      host's own claim is anchored at `driverLayers` (see
 *      `communalAssembly.ts`), so this boundary is a fixed protocol
 *      constant (`STAGE_DRIVER_LAYERS`), never planned per-driver the way
 *      the legacy path's `planPipelineForDriver` adapts to local WebGPU
 *      capacity — a communal driver's local range must match what every
 *      host on the mesh assumes, or `buildCommunalTopology`'s coverage
 *      accounting is comparing incompatible ranges.
 *   2. Tokenize/detokenize locally (same `StageWorkerClient`).
 *   3. Build a `CommunalRoute` from the LIVE roster (`useMeshRoster`'s
 *      `loadedStages` union, via `buildCommunalTopology` + `planCommunalRoute`
 *      + `communalAttachOrder`) and hand it to `runCommunalDriverSession` —
 *      the actual attach/preflight/decode/replan state machine mesh-core
 *      already implements and unit-tests; this hook is JUST the caller.
 *   4. Stream tokens back, detokenizing locally as they arrive.
 *
 * Cross-tab leader election reuses `useStagePipeline`'s exact
 * `acquireLeaderLock` idiom ("one driver session per browser tab") — a
 * second concurrent `start()` call in the SAME tab sees `phase: 'follower'`
 * instead of double-driving the mesh. Multiple TABS (real separate
 * `navigator.locks` managers) each get their own independent communal chat
 * — this is exactly what the M3/M4 acceptance e2e's "2 concurrent driver
 * tabs" scenario exercises.
 *
 * M4 — contribution-economy telemetry (see `docs/ECONOMY.md`'s "Injection
 * story"): when `standingLedger` is supplied, every attached segment's
 * completion or replan-triggering failure feeds
 * `standingLedger.recordService({hostPeerId, layersServed, framesServed,
 * servingMs, sessionCompleted}, now)` for the remote host(s) THIS run
 * actually attached to — the "driver directly witnesses host service" half
 * of the economy. `priorityScore` (typically `bindPriorityScore(ledger,
 * clock)`) is threaded into `planCommunalRoute`/`communalAttachOrder`'s
 * ranking AND `runCommunalDriverSession`'s replan-jitter formula, so a
 * driver with real standing both routes toward AND recovers faster via
 * known-good hosts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildCommunalTopology,
  communalAttachOrder,
  planCommunalRoute,
  planThinDriverRoute,
  runCommunalDriverSession,
  type CommunalRoute,
  type CommunalRouteFn,
  type Peer,
  type StageOrchestratorEvent,
  type StageOrchestratorTimeouts,
  type StageSessionHandle,
  type StandingLedger,
} from '@unstable-legion/core';
import { StageWorkerClient, warmUpStageWorker, type StageWorkerLog } from './stageWorkerClient.js';
import { emitTelemetry, type MeshTelemetrySink } from './meshResilience.js';
import { acquireLeaderLock } from './useStagePipeline.js';
import { detectWebGpuLimits } from './webgpuLimits.js';
import { resolveCommunalShardPlan, OPFS_QUOTA_CEILING_BYTES } from './useCommunalHost.js';
import {
  STAGE_CTX_SIZE,
  STAGE_DRIVER_LAYERS,
  STAGE_MODEL_ID,
  STAGE_N_EMBD,
  STAGE_TOTAL_LAYERS,
  stageShardUrls,
} from './stageModelSource.js';

export interface UseCommunalChatOptions {
  peer: Peer | null;
  /** Factory for a fresh LOCAL stage-0 DedicatedWorker. Must be stable
   * (useCallback) — a new identity tears down any in-flight run. Same
   * worker script `useStagePipeline`/`useStageHost`/`useCommunalHost` use
   * (`apps/demo/src/workers/stageWorker.ts`). */
  createStageWorker: () => Worker;
  modelId?: string;
  totalLayers?: number;
  /** Must match every communal host's own `driverLayers` assumption — see
   * this module's doc comment. Default `STAGE_DRIVER_LAYERS`. */
  driverLayers?: number;
  /** Per-layer package manifest URL (the SAME one communal hosts use). When
   * set, the driver's local stage-0 resolves its shards from the manifest
   * (embeddings + layers `[0, driverLayers)`) via `fragmentsForRange` —
   * model-agnostic, no monolithic `full.gguf` fetch and no hardcoded
   * dimensions. Without it, stage-0 falls back to `stageShardUrls()` (the
   * test-model path). CRITICAL: a driver whose stage-0 loads a DIFFERENT
   * model file than the communal hosts' sharded package produces
   * wrong-width activations → the remote stage rejects the frame
   * ("activation input payload is N bytes, expected M"). The manifest is the
   * single source of truth that keeps every stage on the same model. */
  manifestUrl?: string | readonly string[];
  nEmbd?: number;
  ctxSize?: number;
  wireDtype?: 'f32' | 'f16' | 'i8';
  defaultMaxDecodeTokens?: number;
  leaderLockName?: string;
  /** Forwarded to `planCommunalRoute`/`communalAttachOrder` — see that
   * module's anti-stampede doc comment. Default 3. */
  spreadWidth?: number;
  /** Scores a candidate host peer for route/attach-order ranking AND the
   * replan-jitter formula (higher -> preferred, and recovers faster on
   * churn). Default `() => 0` (no preference) until bound to a real
   * `StandingLedger` — see `bindPriorityScore`. */
  priorityScore?: (peerId: string) => number;
  /** M4 — this driver's own contribution-economy ledger. See this module's
   * doc comment's "M4" section. Omit to skip telemetry entirely (pure
   * FCFS/no-standing behavior, same as before M4 wiring). */
  standingLedger?: StandingLedger;
  /**
   * OPTIONAL-STAGE0 — run as a THIN driver: host NO local stage-0 worker
   * (this device has no usable WebGPU — see `webgpuLimits.ts`'s `isThinDriver`),
   * route the FIRST stage to a remote isFirst communal host, and ship
   * token-ids over the wire. Requires `thinTokenizer` for the CPU-only
   * tokenize/detokenize a thin device still does locally. When false (the
   * default), the ordinary capable-driver path runs: local stage 0 +
   * `planCommunalRoute`. See `docs/OPTIONAL-STAGE0.md`.
   *
   * TRUST: in thin mode your RAW TOKEN IDS (trivially your prompt text)
   * leave the device to the remote first stage — strictly weaker privacy
   * than the capable path, where embeddings are computed locally first. The
   * app MUST surface this (see `docs/TRUST.md` + the apps/chat trust UI).
   */
  thinDriver?: boolean;
  /**
   * CPU-only tokenizer for thin mode (wasm, no WebGPU). Required when
   * `thinDriver` is true. `nEmbd` must match the mesh's model so the
   * zero-activation wire frames the orchestrator ships are the right shape.
   * The demo supplies a tokenizer-only stage worker (no GPU stage loaded);
   * omitting it in thin mode is an error surfaced at `start()`. */
  thinTokenizer?: {
    nEmbd: number;
    tokenize: (text: string, addSpecial?: boolean) => Promise<number[]>;
    detokenize: (tokens: readonly number[]) => Promise<string>;
    dispose?: () => Promise<void> | void;
  };
  /**
   * OPTIONAL-STAGE0 Phase 2 — run as a TEXT-RELAY driver: like `thinDriver`
   * (no local stage-0), but this device holds NO TOKENIZER AT ALL — not even
   * the CPU-only wasm one `thinTokenizer` needs (memory-constrained phones
   * that can't spare its footprint). Implies thin routing internally (no
   * `thinDriver: true` needed alongside it) and `thinTokenizer` is neither
   * required nor used. The prompt is sent as raw TEXT to the remote isFirst
   * host, which tokenizes it server-side; the remote isFinal host detokenizes
   * its own output and streams incremental TEXT DELTAS back (see
   * `UseCommunalChatHandle.text`) instead of this hook detokenizing
   * `tokens` locally. `tokens` state still fills with the real numeric ids
   * the mesh echoes back (driving the decode loop), but is not otherwise
   * meaningful client-side in this mode. See
   * `stageOrchestrator.ts`'s `CommunalDriverSessionOptions.textRelay` for
   * the full protocol description.
   *
   * TRUST: same posture as `thinDriver`'s token-id path, made more literal —
   * the PROMPT TEXT itself (not just token ids) leaves the device to the
   * remote first host. The app MUST surface this. Default `false`.
   */
  textRelay?: boolean;
  /** Forwarded to `runCommunalDriverSession`. See `useStagePipeline`'s
   * identical option for why the defaults below are generous (cold WebGPU
   * shader compilation on a communal host's first real dispatch). */
  timeouts?: StageOrchestratorTimeouts;
  queueWaitMs?: number;
  replanJitterMs?: number;
  /** Vendor-neutral telemetry sink — emits `chat_started` / `chat_failed`
   * / `chat_replan` at the driver-side lifecycle points. Omit to disable. */
  telemetry?: MeshTelemetrySink;
  log?: StageWorkerLog;
}

const DEFAULT_BOOTSTRAP_STEP_MS = 120_000;
const DEFAULT_LOAD_MS = 300_000;
/**
 * Cap on total pipeline stages a route may use. `Infinity` = the host-side
 * relay is trusted to forward across arbitrarily many hops. Set to `2` as a
 * runtime kill-switch to pin the mesh to the proven driver→one-remote shape
 * if a relay regression ever ships — no code change beyond this line. A
 * topology that needs more hops than this becomes unroutable (the greedy
 * cover still prefers a single host that spans the whole range, so this only
 * bites a genuinely fragmented mesh).
 */
const MAX_ROUTE_STAGES = Infinity;
const DEFAULT_PING_MS = 30_000;
const DEFAULT_LOCK_NAME = 'unstable-legion-communal-chat-driver-leader-v1';
const DEFAULT_MAX_DECODE_TOKENS = 64;

export type CommunalChatStatus =
  | { phase: 'idle' }
  | { phase: 'follower' }
  | { phase: 'planning' }
  | { phase: 'starting' }
  | { phase: 'running' }
  | { phase: 'finished' }
  | { phase: 'aborted'; reason: string }
  | { phase: 'error'; error: string };

/**
 * Live view of a stage host loading its slice (shard download → native open
 * → warm-up), surfaced from the orchestrator's `loadProgress` events so the
 * chat waiting-state can show "Loading Qwen3-8B — shard 24/36 · 2.6/4.4 GB"
 * instead of a silent multi-minute spinner. Undefined once the pipeline is
 * assembled (or before any load starts).
 */
export interface StageLoadProgressView {
  stageIndex: number;
  peerId: string;
  shardsFetched: number;
  totalShards: number;
  bytesFetched: number;
  totalBytes?: number;
  phase?: 'downloading' | 'opening' | 'warming';
}

/** Decode-speed metric for the most recent (or in-flight) generation —
 * powers the per-response tok/s badge. `tokPerSec` is the DECODE rate
 * (first generated token → last), which is what a user perceives as
 * "speed" and excludes the one-time load/prefill/TTFT wait; `ttftMs` is
 * that wait (session start → first token) surfaced separately. Undefined
 * until the first token of a generation arrives. */
export interface ChatGenTiming {
  /** Generated tokens counted for this metric. */
  tokenCount: number;
  /** Wall-clock from first generated token to last (ms). 0 for a 1-token
   * generation (no interval to measure). */
  decodeMs: number;
  /** Decode throughput: `(tokenCount - 1) / (decodeMs/1000)` — the
   * inter-token rate. Undefined when fewer than 2 tokens (no interval). */
  tokPerSec?: number;
  /** Time-to-first-token: session start → first generated token (ms). */
  ttftMs: number;
}

export interface UseCommunalChatHandle {
  status: CommunalChatStatus;
  plan?: CommunalRoute['plan'];
  tokens: readonly number[];
  text: string;
  restartCount: number;
  /** Decode-speed of the latest generation (see `ChatGenTiming`). Reset to
   * undefined when a new generation starts; set on the first token and
   * finalized at `finished`. */
  lastTiming?: ChatGenTiming;
  /** Live stage-load progress while the pipeline assembles — drives the
   * chat waiting-state's "shard 24/36 · 2.6/4.4 GB" line. Undefined once
   * assembled (cleared on the first token) or before any load begins. */
  loadProgress?: StageLoadProgressView;
  /** stageIndex values that have completed attach (`stage.session.accept`)
   * for the CURRENT route — UI topology display can render a per-stage
   * readiness badge, mirroring `useStagePipeline`'s `readyStageIndexes`. */
  readyStageIndexes: readonly number[];
  /**
   * Latest `sendStageFrame` byte size per DESTINATION peerId, captured from
   * the same `loggedPeer.sendStageFrame` wrapper that already logs
   * "sendStageFrame -> ... (N bytes)" — observability for the chat app's
   * per-hop pipeline-handoff display (byte size shown directly, and the
   * DERIVED wire dtype via mesh-core's `wireDtypeFromFrameBytes`, never a
   * separately-plumbed dtype field). Reset to `{}` at the start of every
   * `start()` call so a hop from a replaced/replanned-away route doesn't
   * linger; a peerId with no entry means no frame has been sent to it yet
   * this session (the UI should show "—", not guess).
   */
  hopBytes?: Readonly<Record<string, number>>;
  /**
   * Run one full session. Resolves `true` when the session ran to its end
   * (any outcome — finished/aborted/error) and every resource is released;
   * resolves `false` when it REFUSED to start (a previous session is still
   * running or tearing down, no peer, or lost the cross-tab leader lock).
   * TOOL-NODES relies on the distinction: the multi-round loop restarts
   * generation on `finished`, which fires BEFORE the previous run's
   * teardown clears the running guard — a caller seeing `false` should
   * retry briefly, not conclude the mesh is broken.
   */
  start: (prompt: string, opts?: { maxDecodeTokens?: number }) => Promise<boolean>;
  abort: (reason?: string) => void;
  /** True while a session holds the run guard — INCLUDING the teardown
   * window after `status` already reads `finished` (worker dispose + lock
   * release are awaited before the guard clears). A caller that wants to
   * chain a new `start()` off a finished session must wait for this to go
   * false first, or its `start()` returns `false` untried. */
  isRunning: () => boolean;
}

export function useCommunalChat(opts: UseCommunalChatOptions): UseCommunalChatHandle {
  const {
    peer,
    createStageWorker,
    modelId = STAGE_MODEL_ID,
    totalLayers = STAGE_TOTAL_LAYERS,
    driverLayers = STAGE_DRIVER_LAYERS,
    manifestUrl,
    nEmbd = STAGE_N_EMBD,
    ctxSize = STAGE_CTX_SIZE,
    wireDtype = 'i8',
    defaultMaxDecodeTokens = DEFAULT_MAX_DECODE_TOKENS,
    leaderLockName = DEFAULT_LOCK_NAME,
    spreadWidth = 3,
    priorityScore = () => 0,
    standingLedger,
    thinDriver = false,
    thinTokenizer,
    textRelay = false,
    timeouts,
    queueWaitMs,
    replanJitterMs,
    telemetry,
    log = () => undefined,
  } = opts;

  const [status, setStatus] = useState<CommunalChatStatus>({ phase: 'idle' });
  const [plan, setPlan] = useState<CommunalRoute['plan'] | undefined>(undefined);
  const [tokens, setTokens] = useState<readonly number[]>([]);
  const [text, setText] = useState('');
  const [restartCount, setRestartCount] = useState(0);
  const [readyStageIndexes, setReadyStageIndexes] = useState<readonly number[]>([]);
  const [loadProgress, setLoadProgress] = useState<StageLoadProgressView | undefined>(undefined);
  const [lastTiming, setLastTiming] = useState<ChatGenTiming | undefined>(undefined);

  const lockRef = useRef<{ release: () => void } | null>(null);
  const localWorkerRef = useRef<StageWorkerClient | null>(null);
  const sessionRef = useRef<StageSessionHandle | null>(null);
  const runningRef = useRef(false);
  // Latest sendStageFrame byte size per destination peerId — see
  // UseCommunalChatHandle.hopBytes's doc comment. A ref (not state):
  // updated once per outbound stage frame (same frequency as the 'token'
  // event, which already triggers a re-render via setTokens), so there's
  // no need for its own render-triggering state churn — by the time a
  // consumer's render reads it, the correlated token-driven re-render has
  // already happened.
  const hopBytesRef = useRef<Record<string, number>>({});

  const teardownLocalWorker = useCallback(async () => {
    const w = localWorkerRef.current;
    localWorkerRef.current = null;
    if (w) await w.dispose().catch(() => undefined);
  }, []);

  const abort = useCallback((reason?: string) => {
    sessionRef.current?.abort(reason ?? 'user abort');
  }, []);

  const start = useCallback(
    async (prompt: string, startOpts?: { maxDecodeTokens?: number }): Promise<boolean> => {
      if (runningRef.current) return false;
      if (!peer) {
        setStatus({ phase: 'error', error: 'mesh not connected' });
        return false;
      }
      runningRef.current = true;
      setPlan(undefined);
      setTokens([]);
      setText('');
      setRestartCount(0);
      setReadyStageIndexes([]);
      hopBytesRef.current = {};
      setStatus({ phase: 'planning' });

      const lock = await acquireLeaderLock(leaderLockName);
      if (!lock) {
        setStatus({ phase: 'follower' });
        runningRef.current = false;
        return false;
      }
      lockRef.current = lock;
      emitTelemetry(telemetry, { name: 'chat_started', props: { modelId } });

      const t0 = Date.now();
      const elapsed = () => `+${Date.now() - t0}ms`;

      // Decode-speed metric (see ChatGenTiming / the tok/s badge). Spans the
      // WHOLE generation (across any replan) — first generated token to last
      // — so a replan's re-prefill pause honestly shows up as lower tok/s
      // rather than being hidden. `t0` is the session-start anchor for TTFT.
      let genFirstTokenAt = 0;
      let genLastTokenAt = 0;
      let genTokenCount = 0;
      setLastTiming(undefined);

      // textRelay implies thin routing (no local stage 0) — see
      // `textRelay`'s doc comment. A caller sets `textRelay: true` alone;
      // `thinDriver: true` is not required alongside it.
      const effectiveThin = thinDriver || textRelay;

      /** Build (or rebuild, for a replan) a `CommunalRoute` from the LIVE
       * roster — pure read, no I/O, cheap enough to call fresh every time
       * rather than caching (`buildCommunalTopology`'s own doc comment:
       * "cheap to call on every roster change"). */
      function buildRoute(excludePeerIds: readonly string[]): CommunalRoute | null {
        const roster = peer!.roster.snapshot();
        // Thin/textRelay drivers cover [0, totalLayers) and need a remote
        // isFirst host; capable drivers cover [driverLayers, totalLayers)
        // and host [0, driverLayers) locally. The `communalStart` + planner
        // differ; the attach-order/candidate shape is identical.
        const topology = buildCommunalTopology(
          roster,
          { modelId, totalLayers, driverLayers, ...(effectiveThin ? { communalStart: 0 } : {}) },
          { excludePeerIds },
        );
        const routePlan = effectiveThin
          ? planThinDriverRoute(topology, { driverPeerId: peer!.selfId, priorityScore, spreadWidth, nEmbd, wireDtype, maxStages: MAX_ROUTE_STAGES })
          : planCommunalRoute(topology, { driverPeerId: peer!.selfId, priorityScore, spreadWidth, nEmbd, wireDtype, maxStages: MAX_ROUTE_STAGES });
        if (!routePlan) return null;
        const attachOrder = communalAttachOrder(topology, { driverPeerId: peer!.selfId, priorityScore, spreadWidth });
        return { plan: routePlan, attachOrder };
      }

      try {
        // Capable drivers need usable WebGPU for the local stage 0. A
        // THIN/TEXT-RELAY driver deliberately has none — it hosts no stage
        // and relies on a remote isFirst host (see `docs/OPTIONAL-STAGE0.md`),
        // so the WebGPU gate is skipped. The token-id thin path still needs a
        // CPU-only tokenizer of its own; textRelay needs none at all (the
        // isFirst host tokenizes server-side).
        if (!effectiveThin) {
          const gpu = await detectWebGpuLimits();
          if (!gpu.ok) throw new Error(gpu.reason ?? 'WebGPU unavailable for local stage-0');
        } else if (!textRelay && !thinTokenizer) {
          throw new Error('thinDriver mode requires a `thinTokenizer` (CPU-only tokenize/detokenize)');
        }

        const initialRoute = buildRoute([]);
        if (!initialRoute) {
          throw new Error(
            effectiveThin
              ? 'no feasible THIN communal route — no remote isFirst host covers [0, X) with embeddings yet (a thin/textRelay driver needs one to host its first stage)'
              : 'no feasible communal route — mesh coverage has a gap, or no communal hosts have advertised loadedStages yet',
          );
        }
        setPlan(initialRoute.plan);
        setStatus({ phase: 'starting' });
        log(
          `[communal-chat] ${effectiveThin ? 'THIN ' : ''}route: ${initialRoute.plan.stages.map((s) => `${s.peerId}[${s.layerStart},${s.layerEnd})`).join(' -> ')}`,
        );

        // The local CPU work a driver always does — tokenize/detokenize. In
        // capable mode this is the loaded stage-0 worker; in thin mode it's
        // the injected CPU tokenizer (no GPU stage loaded at all); in
        // textRelay mode there is no local tokenize/detokenize at all.
        let localWorker: StageWorkerClient | null = null;
        if (!effectiveThin) {
          // Resolve stage-0's shards from the SAME per-layer manifest the
          // communal hosts use (embeddings + layers [0, driverLayers)) — NOT
          // the monolithic `full.gguf` fallback. This keeps every stage on one
          // model: a stage-0 loaded from a different artifact than the sharded
          // package emits wrong-width activations the remote stage rejects
          // ("activation input payload is N bytes, expected M"). Model-agnostic
          // — widths/fragments come from the manifest. Falls back to
          // `stageShardUrls()` only when no manifest is set (the test model).
          const { plan: stage0Plan } = await resolveCommunalShardPlan(
            { layerStart: 0, layerEnd: driverLayers, includeOutput: false },
            {
              manifestUrl,
              fallbackShardUrls: stageShardUrls,
              includeEmbeddings: true,
              opfsQuotaBytes: OPFS_QUOTA_CEILING_BYTES,
            },
          );
          localWorker = new StageWorkerClient(createStageWorker(), 'communal-chat-stage-0', log);
          await localWorker.load(
            {
              modelId,
              layerStart: 0,
              layerEnd: driverLayers,
              totalLayers,
              shardUrls: stage0Plan.shardUrls,
              shardHashes: stage0Plan.shardHashes,
              shardBytes: stage0Plan.shardBytes,
              ctxSize,
            },
            { useMemoryShardStore: stage0Plan.useMemoryShardStore },
          );
          log(`[communal-chat] ${elapsed()} local stage-0 worker loaded (nEmbd=${localWorker.nEmbd}); warming up…`);
          await warmUpStageWorker(localWorker, log);
          log(`[communal-chat] ${elapsed()} local stage-0 warm-up done`);
          localWorkerRef.current = localWorker;
        } else if (textRelay) {
          log(`[communal-chat] ${elapsed()} text-relay driver — no local stage, no local tokenizer (nEmbd=${nEmbd})`);
        } else {
          log(`[communal-chat] ${elapsed()} thin driver — no local stage, CPU tokenizer only (nEmbd=${thinTokenizer!.nEmbd})`);
        }

        // TEXT-RELAY: no tokenizer exists on this device at all — the isFirst
        // host tokenizes the prompt server-side and the isFinal host streams
        // decoded text back (see the 'token' event's `text` handling below).
        // These stubs exist only to satisfy the shape every mode shares; the
        // orchestrator never calls tokenize/detokenize in textRelay mode
        // (see `CommunalDriverSessionOptions.textRelay`'s doc comment).
        const tokenizer = textRelay
          ? {
              nEmbd,
              tokenize: async (): Promise<number[]> => {
                throw new Error('textRelay driver must not tokenize locally');
              },
              detokenize: async (): Promise<string> => {
                throw new Error('textRelay driver must not detokenize locally');
              },
            }
          : thinDriver
            ? {
                nEmbd: thinTokenizer!.nEmbd,
                tokenize: (t: string) => thinTokenizer!.tokenize(t, true),
                detokenize: (toks: readonly number[]) => thinTokenizer!.detokenize(toks),
              }
            : {
                nEmbd: localWorker!.nEmbd,
                tokenize: (t: string) => localWorker!.tokenize(t, true),
                detokenize: (toks: readonly number[]) => localWorker!.detokenize([...toks]),
              };

        // ── M4 telemetry bookkeeping — per ATTACHED segment (reset on
        // every planCreated/replan), not per whole chat: a replan means a
        // DIFFERENT host served the earlier portion, and that earlier
        // host's own credit/no-credit outcome must be recorded against
        // ITS OWN servingMs/frame count, not folded into the replacement
        // host's tally.
        let segmentStartAt = Date.now();
        let segmentTokenCount = 0;
        let segmentHostLayers: readonly { peerId: string; layers: number }[] = [];

        function recordSegmentTelemetry(sessionCompleted: boolean): void {
          if (!standingLedger) return;
          const now = Date.now();
          const servingMs = Math.max(0, now - segmentStartAt);
          for (const { peerId, layers } of segmentHostLayers) {
            standingLedger.recordService(
              { hostPeerId: peerId, layersServed: layers, framesServed: segmentTokenCount, servingMs, sessionCompleted },
              now,
            );
          }
        }

        const replanRoute: CommunalRouteFn = (lostPeerId, _graceful) => buildRoute(lostPeerId ? [lostPeerId] : []);

        // Thin logging wrapper — same idiom as `useStagePipeline`'s
        // `loggedPeer` (mesh-core's orchestrator is otherwise a black box
        // for "did the sf frame actually get sent, and to whom").
        const loggedPeer: typeof peer = {
          ...peer,
          sendStageFrame: async (bytes, peers) => {
            log(`[communal-chat] ${elapsed()} sendStageFrame -> ${JSON.stringify(peers)} (${bytes.byteLength} bytes)`);
            // Pipeline-handoff UI observability: last frame size per
            // destination peerId (see UseCommunalChatHandle.hopBytes).
            // `peers` may be a bare peerId or a list (a route can fan a
            // single frame out to more than one destination).
            const targets = peers === undefined ? [] : Array.isArray(peers) ? peers : [peers];
            for (const targetId of targets) {
              hopBytesRef.current = { ...hopBytesRef.current, [targetId]: bytes.byteLength };
            }
            try {
              await peer!.sendStageFrame(bytes, peers);
            } catch (err) {
              log(`[communal-chat] ${elapsed()} sendStageFrame -> ${JSON.stringify(peers)} FAILED: ${err instanceof Error ? err.message : String(err)}`);
              throw err;
            }
          },
          sendTool: async (frame, peers) => {
            log(`[communal-chat] ${elapsed()} sendTool(${frame.kind}) -> ${JSON.stringify(peers)}`);
            await peer!.sendTool(frame, peers);
          },
        };

        const handle = runCommunalDriverSession({
          peer: loggedPeer,
          route: initialRoute,
          modelId,
          prompt,
          maxDecodeTokens: startOpts?.maxDecodeTokens ?? defaultMaxDecodeTokens,
          thinDriver: effectiveThin,
          textRelay,
          localHooks: {
            nEmbd: tokenizer.nEmbd,
            tokenize: (t) => tokenizer.tokenize(t),
            detokenize: (toks) => tokenizer.detokenize(toks),
            // In thin mode the orchestrator never calls reset/prefill/decode
            // (it synthesizes zero-activation frames and the remote isFirst
            // host embeds from the token sideband) — these stubs exist only
            // to satisfy the `DriverStageHooks` shape and must never run.
            reset: () => (localWorker ? localWorker.reset() : Promise.resolve()),
            prefill: async (toks, positions) => {
              if (!localWorker) throw new Error('thin driver: local prefill must not be called');
              log(`[communal-chat] ${elapsed()} local prefill start (tokens=${toks.length})`);
              const res = await localWorker.prefill([...toks], [...positions]);
              log(`[communal-chat] ${elapsed()} local prefill done`);
              if (!res.activation) throw new Error('local stage-0 prefill produced no activation');
              return { activation: new Float32Array(res.activation.payload) };
            },
            decode: async (token) => {
              if (!localWorker) throw new Error('thin driver: local decode must not be called');
              const res = await localWorker.decode(token);
              if (!res.activation) throw new Error('local stage-0 decode produced no activation');
              return { activation: new Float32Array(res.activation.payload) };
            },
          },
          replanRoute,
          timeouts: {
            bootstrapStepMs: DEFAULT_BOOTSTRAP_STEP_MS,
            loadMs: DEFAULT_LOAD_MS,
            pingMs: DEFAULT_PING_MS,
            ...timeouts,
          },
          queueWaitMs,
          replanJitterMs,
          priorityScore,
        });
        sessionRef.current = handle;
        setStatus({ phase: 'running' });

        handle.on((ev: StageOrchestratorEvent) => {
          log(`[communal-chat] ${elapsed()} event=${ev.type} ${JSON.stringify(ev).slice(0, 300)}`);
          switch (ev.type) {
            case 'planCreated': {
              setPlan(ev.plan);
              segmentStartAt = Date.now();
              segmentTokenCount = 0;
              segmentHostLayers = ev.plan.stages
                .filter((s) => s.stageIndex > 0)
                .map((s) => ({ peerId: s.peerId, layers: s.layerEnd - s.layerStart }));
              break;
            }
            case 'replan': {
              // The PREVIOUS attach's outcome — it triggered a replan, so
              // by definition it did not complete (a replan-then-success
              // funnels through 'finished' below the way a normal run
              // does, never re-entering 'replan').
              recordSegmentTelemetry(false);
              emitTelemetry(telemetry, { name: 'chat_replan', props: { restartCount: ev.restartCount } });
              setPlan(ev.plan);
              setRestartCount(ev.restartCount);
              setReadyStageIndexes([]);
              setLoadProgress(undefined);
              segmentStartAt = Date.now();
              segmentTokenCount = 0;
              segmentHostLayers = ev.plan.stages
                .filter((s) => s.stageIndex > 0)
                .map((s) => ({ peerId: s.peerId, layers: s.layerEnd - s.layerStart }));
              break;
            }
            case 'stageReady': {
              setReadyStageIndexes((prev) => (prev.includes(ev.stageIndex) ? prev : [...prev, ev.stageIndex]));
              // This stage finished loading — drop its in-flight progress so
              // the UI doesn't keep showing a load line for an assembled stage.
              setLoadProgress((prev) => (prev && prev.stageIndex === ev.stageIndex ? undefined : prev));
              break;
            }
            case 'loadProgress': {
              setLoadProgress({
                stageIndex: ev.stageIndex,
                peerId: ev.peerId,
                shardsFetched: ev.shardsFetched,
                totalShards: ev.totalShards,
                bytesFetched: ev.bytesFetched,
                totalBytes: ev.totalBytes,
                phase: ev.phase,
              });
              break;
            }
            case 'token': {
              segmentTokenCount += 1;
              const tokAt = Date.now();
              if (genFirstTokenAt === 0) genFirstTokenAt = tokAt;
              genLastTokenAt = tokAt;
              genTokenCount += 1;
              setLoadProgress(undefined); // assembled + generating — no more load line
              const { generatedTokens } = handle.tokenHistory();
              setTokens(generatedTokens);
              if (textRelay) {
                // No local tokenizer to detokenize with — accumulate the
                // incremental TEXT DELTA the isFinal host already streamed
                // back (see stage.token's `text` field / the orchestrator's
                // `textRelay` doc comment). `ev.text` can be absent/empty on
                // a step whose token didn't complete a safely-emittable
                // UTF-8 chunk (host-side buffering, see
                // `incrementalTextStream.ts`).
                if (ev.text) setText((prev) => prev + ev.text);
              } else {
                void Promise.resolve(tokenizer.detokenize(generatedTokens))
                  .then(setText)
                  .catch(() => undefined);
              }
              break;
            }
            case 'aborted': {
              recordSegmentTelemetry(false);
              // An involuntary abort (host lost / preflight gave up) is a
              // failure worth reporting; an explicit user stop is not.
              if (!/\buser\b/i.test(ev.reason)) {
                emitTelemetry(telemetry, { name: 'chat_failed', props: { reason: ev.reason } });
              }
              setStatus({ phase: 'aborted', reason: ev.reason });
              break;
            }
            case 'finished': {
              recordSegmentTelemetry(true);
              if (genFirstTokenAt > 0) {
                const decodeMs = Math.max(0, genLastTokenAt - genFirstTokenAt);
                setLastTiming({
                  tokenCount: genTokenCount,
                  decodeMs,
                  tokPerSec: genTokenCount > 1 && decodeMs > 0 ? (genTokenCount - 1) / (decodeMs / 1000) : undefined,
                  ttftMs: Math.max(0, genFirstTokenAt - t0),
                });
              }
              setStatus((prev) => (prev.phase === 'aborted' ? prev : { phase: 'finished' }));
              break;
            }
            default:
              break;
          }
        });

        await handle.result();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        emitTelemetry(telemetry, { name: 'chat_failed', props: { reason } });
        setStatus({ phase: 'error', error: reason });
      } finally {
        await teardownLocalWorker();
        sessionRef.current = null;
        lockRef.current?.release();
        lockRef.current = null;
        runningRef.current = false;
        setLoadProgress(undefined);
      }
      return true;
    },
    [
      peer,
      createStageWorker,
      modelId,
      totalLayers,
      driverLayers,
      nEmbd,
      ctxSize,
      wireDtype,
      defaultMaxDecodeTokens,
      leaderLockName,
      spreadWidth,
      priorityScore,
      standingLedger,
      thinDriver,
      thinTokenizer,
      textRelay,
      timeouts,
      queueWaitMs,
      replanJitterMs,
      telemetry,
      log,
      teardownLocalWorker,
    ],
  );

  useEffect(() => {
    return () => {
      sessionRef.current?.abort('component unmounted');
      void teardownLocalWorker();
      lockRef.current?.release();
      lockRef.current = null;
    };
  }, [teardownLocalWorker]);

  const isRunning = useCallback(() => runningRef.current, []);

  return {
    status,
    plan,
    tokens,
    text,
    restartCount,
    readyStageIndexes,
    loadProgress,
    lastTiming,
    hopBytes: hopBytesRef.current,
    start,
    abort,
    isRunning,
  };
}
