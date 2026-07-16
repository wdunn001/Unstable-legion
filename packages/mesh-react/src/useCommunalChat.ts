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
import { acquireLeaderLock } from './useStagePipeline.js';
import { detectWebGpuLimits } from './webgpuLimits.js';
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
  nEmbd?: number;
  ctxSize?: number;
  wireDtype?: 'f32' | 'f16';
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
  /** Forwarded to `runCommunalDriverSession`. See `useStagePipeline`'s
   * identical option for why the defaults below are generous (cold WebGPU
   * shader compilation on a communal host's first real dispatch). */
  timeouts?: StageOrchestratorTimeouts;
  queueWaitMs?: number;
  replanJitterMs?: number;
  log?: StageWorkerLog;
}

const DEFAULT_BOOTSTRAP_STEP_MS = 120_000;
const DEFAULT_LOAD_MS = 300_000;
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

export interface UseCommunalChatHandle {
  status: CommunalChatStatus;
  plan?: CommunalRoute['plan'];
  tokens: readonly number[];
  text: string;
  restartCount: number;
  /** stageIndex values that have completed attach (`stage.session.accept`)
   * for the CURRENT route — UI topology display can render a per-stage
   * readiness badge, mirroring `useStagePipeline`'s `readyStageIndexes`. */
  readyStageIndexes: readonly number[];
  start: (prompt: string, opts?: { maxDecodeTokens?: number }) => Promise<void>;
  abort: (reason?: string) => void;
}

export function useCommunalChat(opts: UseCommunalChatOptions): UseCommunalChatHandle {
  const {
    peer,
    createStageWorker,
    modelId = STAGE_MODEL_ID,
    totalLayers = STAGE_TOTAL_LAYERS,
    driverLayers = STAGE_DRIVER_LAYERS,
    nEmbd = STAGE_N_EMBD,
    ctxSize = STAGE_CTX_SIZE,
    wireDtype = 'f32',
    defaultMaxDecodeTokens = DEFAULT_MAX_DECODE_TOKENS,
    leaderLockName = DEFAULT_LOCK_NAME,
    spreadWidth = 3,
    priorityScore = () => 0,
    standingLedger,
    timeouts,
    queueWaitMs,
    replanJitterMs,
    log = () => undefined,
  } = opts;

  const [status, setStatus] = useState<CommunalChatStatus>({ phase: 'idle' });
  const [plan, setPlan] = useState<CommunalRoute['plan'] | undefined>(undefined);
  const [tokens, setTokens] = useState<readonly number[]>([]);
  const [text, setText] = useState('');
  const [restartCount, setRestartCount] = useState(0);
  const [readyStageIndexes, setReadyStageIndexes] = useState<readonly number[]>([]);

  const lockRef = useRef<{ release: () => void } | null>(null);
  const localWorkerRef = useRef<StageWorkerClient | null>(null);
  const sessionRef = useRef<StageSessionHandle | null>(null);
  const runningRef = useRef(false);

  const teardownLocalWorker = useCallback(async () => {
    const w = localWorkerRef.current;
    localWorkerRef.current = null;
    if (w) await w.dispose().catch(() => undefined);
  }, []);

  const abort = useCallback((reason?: string) => {
    sessionRef.current?.abort(reason ?? 'user abort');
  }, []);

  const start = useCallback(
    async (prompt: string, startOpts?: { maxDecodeTokens?: number }) => {
      if (runningRef.current) return;
      if (!peer) {
        setStatus({ phase: 'error', error: 'mesh not connected' });
        return;
      }
      runningRef.current = true;
      setPlan(undefined);
      setTokens([]);
      setText('');
      setRestartCount(0);
      setReadyStageIndexes([]);
      setStatus({ phase: 'planning' });

      const lock = await acquireLeaderLock(leaderLockName);
      if (!lock) {
        setStatus({ phase: 'follower' });
        runningRef.current = false;
        return;
      }
      lockRef.current = lock;

      const t0 = Date.now();
      const elapsed = () => `+${Date.now() - t0}ms`;

      /** Build (or rebuild, for a replan) a `CommunalRoute` from the LIVE
       * roster — pure read, no I/O, cheap enough to call fresh every time
       * rather than caching (`buildCommunalTopology`'s own doc comment:
       * "cheap to call on every roster change"). */
      function buildRoute(excludePeerIds: readonly string[]): CommunalRoute | null {
        const roster = peer!.roster.snapshot();
        const topology = buildCommunalTopology(roster, { modelId, totalLayers, driverLayers }, { excludePeerIds });
        const routePlan = planCommunalRoute(topology, { driverPeerId: peer!.selfId, priorityScore, spreadWidth, nEmbd, wireDtype });
        if (!routePlan) return null;
        const attachOrder = communalAttachOrder(topology, { driverPeerId: peer!.selfId, priorityScore, spreadWidth });
        return { plan: routePlan, attachOrder };
      }

      try {
        const gpu = await detectWebGpuLimits();
        if (!gpu.ok) throw new Error(gpu.reason ?? 'WebGPU unavailable for local stage-0');

        const initialRoute = buildRoute([]);
        if (!initialRoute) {
          throw new Error(
            'no feasible communal route — mesh coverage has a gap, or no communal hosts have advertised loadedStages yet',
          );
        }
        setPlan(initialRoute.plan);
        setStatus({ phase: 'starting' });
        log(
          `[communal-chat] route: ${initialRoute.plan.stages.map((s) => `${s.peerId}[${s.layerStart},${s.layerEnd})`).join(' -> ')}`,
        );

        const localWorker = new StageWorkerClient(createStageWorker(), 'communal-chat-stage-0', log);
        await localWorker.load({
          modelId,
          layerStart: 0,
          layerEnd: driverLayers,
          totalLayers,
          shardUrls: stageShardUrls(),
          ctxSize,
        });
        log(`[communal-chat] ${elapsed()} local stage-0 worker loaded (nEmbd=${localWorker.nEmbd}); warming up…`);
        await warmUpStageWorker(localWorker, log);
        log(`[communal-chat] ${elapsed()} local stage-0 warm-up done`);
        localWorkerRef.current = localWorker;

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
          localHooks: {
            nEmbd: localWorker.nEmbd,
            tokenize: (t) => localWorker.tokenize(t, true),
            detokenize: (toks) => localWorker.detokenize([...toks]),
            reset: () => localWorker.reset(),
            prefill: async (toks, positions) => {
              log(`[communal-chat] ${elapsed()} local prefill start (tokens=${toks.length})`);
              const res = await localWorker.prefill([...toks], [...positions]);
              log(`[communal-chat] ${elapsed()} local prefill done`);
              if (!res.activation) throw new Error('local stage-0 prefill produced no activation');
              return { activation: new Float32Array(res.activation.payload) };
            },
            decode: async (token) => {
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
              setPlan(ev.plan);
              setRestartCount(ev.restartCount);
              setReadyStageIndexes([]);
              segmentStartAt = Date.now();
              segmentTokenCount = 0;
              segmentHostLayers = ev.plan.stages
                .filter((s) => s.stageIndex > 0)
                .map((s) => ({ peerId: s.peerId, layers: s.layerEnd - s.layerStart }));
              break;
            }
            case 'stageReady': {
              setReadyStageIndexes((prev) => (prev.includes(ev.stageIndex) ? prev : [...prev, ev.stageIndex]));
              break;
            }
            case 'token': {
              segmentTokenCount += 1;
              const { generatedTokens } = handle.tokenHistory();
              setTokens(generatedTokens);
              void localWorker
                .detokenize([...generatedTokens])
                .then(setText)
                .catch(() => undefined);
              break;
            }
            case 'aborted': {
              recordSegmentTelemetry(false);
              setStatus({ phase: 'aborted', reason: ev.reason });
              break;
            }
            case 'finished': {
              recordSegmentTelemetry(true);
              setStatus((prev) => (prev.phase === 'aborted' ? prev : { phase: 'finished' }));
              break;
            }
            default:
              break;
          }
        });

        await handle.result();
      } catch (err) {
        setStatus({ phase: 'error', error: err instanceof Error ? err.message : String(err) });
      } finally {
        await teardownLocalWorker();
        sessionRef.current = null;
        lockRef.current?.release();
        lockRef.current = null;
        runningRef.current = false;
      }
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
      timeouts,
      queueWaitMs,
      replanJitterMs,
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

  return { status, plan, tokens, text, restartCount, readyStageIndexes, start, abort };
}
