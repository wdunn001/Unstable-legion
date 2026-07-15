/**
 * useStagePipeline — the DRIVER side of pipeline-split inference. Enumerates
 * the roster for stage-hosting peers, plans a pipeline (`planPipelineForDriver`
 * — local peer always stage 0, remote hosts fill the rest), then runs
 * `runDriverStageSession` (mesh-core's `stageOrchestrator.ts`) with hooks
 * wired to a LOCAL stage-0 `StageWorkerClient` — exactly Phase B's proven
 * shape ("driver hosts stage A locally"), generalized so the remote side
 * is chosen from the live roster instead of a hardcoded host.
 *
 * Cross-tab leader election reuses `useLocalLlm`'s `navigator.locks`
 * pattern ("one driver session per browser") — a second tab attempting
 * `start()` sees `phase: 'follower'` instead of double-driving the mesh.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  runDriverStageSession,
  type Peer,
  type ReplanFn,
  type StageOrchestratorEvent,
  type StageOrchestratorTimeouts,
  type StagePlan,
  type StageSessionHandle,
} from '@unstable-legion/core';
import { StageWorkerClient, warmUpStageWorker, type StageWorkerLog } from './stageWorkerClient.js';
import {
  buildLocalCapacityCap,
  planPipelineForDriver,
  type StageHostLimits,
} from './stagePipelinePlanning.js';
import { detectWebGpuLimits } from './webgpuLimits.js';
import {
  STAGE_CTX_SIZE,
  STAGE_MODEL_ID,
  STAGE_N_EMBD,
  STAGE_TOTAL_LAYERS,
  STAGE_AVG_LAYER_BYTES,
  stageShardUrls,
} from './stageModelSource.js';

export interface UseStagePipelineOptions {
  peer: Peer | null;
  /** Factory for a fresh LOCAL stage-0 DedicatedWorker. Must be stable
   * (useCallback) — a new identity tears down any in-flight run. */
  createStageWorker: () => Worker;
  modelId?: string;
  totalLayers?: number;
  avgLayerBytes?: number;
  nEmbd?: number;
  ctxSize?: number;
  wireDtype?: 'f32' | 'f16';
  defaultMaxDecodeTokens?: number;
  leaderLockName?: string;
  /** Forwarded to `runDriverStageSession`. The default `bootstrapStepMs`
   * (20s, mesh-core's Phase B-derived default) assumes an already-warm
   * WebGPU pipeline; a REMOTE stage host's first real prefill/decode
   * dispatch after `stage.ready` still has to JIT-compile its WebGPU
   * shader pipelines (Dawn's first-dispatch compilation, not covered by
   * `sched_reserve`'s buffer-only reservation), which can comfortably
   * exceed 20s on a cold run — observed directly while building this
   * hook's e2e coverage (workstream C3): both stages reached `ready`
   * fine, then the driver aborted with "stagetok-...-0 timed out after
   * 20000ms" while hostA was still compiling its first attention kernel.
   * This hook raises the bootstrap floor well past that; per-step
   * timeouts after the first real token are still the orchestrator's
   * own adaptive 10x-mean-TPOT (which shrinks back down once the
   * pipeline is warm). */
  timeouts?: StageOrchestratorTimeouts;
  log?: StageWorkerLog;
}

// Both the local stage-0 worker and every remote stage host now warm up
// their WebGPU shader pipelines with a throwaway dispatch BEFORE
// reporting ready (see `warmUpStageWorker` in stageWorkerClient.ts), so
// the FIRST real prefill/decode round trip should already be warm.
// These stay generous anyway — multi-tab GPU adapter contention is real
// and defense in depth is cheap: a healthy-but-slow run should never
// get mistaken for a dead one.
const DEFAULT_BOOTSTRAP_STEP_MS = 120_000;
const DEFAULT_LOAD_MS = 300_000;
const DEFAULT_PING_MS = 30_000;

export type StagePipelineStatus =
  | { phase: 'idle' }
  | { phase: 'follower' }
  | { phase: 'planning' }
  | { phase: 'starting' }
  | { phase: 'running' }
  | { phase: 'finished' }
  | { phase: 'aborted'; reason: string }
  | { phase: 'error'; error: string };

export interface UseStagePipelineHandle {
  status: StagePipelineStatus;
  plan?: StagePlan;
  tokens: readonly number[];
  text: string;
  tpotMs?: number;
  restartCount: number;
  /** stageIndex values that have completed `stage.ready` for the CURRENT
   * plan — UI topology display can render a per-stage readiness badge. */
  readyStageIndexes: readonly number[];
  start: (prompt: string, opts?: { maxDecodeTokens?: number }) => Promise<void>;
  abort: (reason?: string) => void;
}

const DEFAULT_LOCK_NAME = 'unstable-legion-stage-driver-leader-v1';
const DEFAULT_MAX_DECODE_TOKENS = 64;

/** Try to acquire the driver-leader lock without blocking. Returns null on miss. */
function acquireLeaderLock(lockName: string): Promise<{ release: () => void } | null> {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return Promise.resolve({ release: () => undefined });
  }
  return new Promise((resolve) => {
    let releaseFn: () => void = () => undefined;
    const held = new Promise<void>((release) => {
      releaseFn = release;
    });
    navigator.locks
      .request(lockName, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        resolve({ release: releaseFn });
        await held;
      })
      .catch(() => resolve(null));
  });
}

export function useStagePipeline(opts: UseStagePipelineOptions): UseStagePipelineHandle {
  const {
    peer,
    createStageWorker,
    modelId = STAGE_MODEL_ID,
    totalLayers = STAGE_TOTAL_LAYERS,
    avgLayerBytes = STAGE_AVG_LAYER_BYTES,
    nEmbd = STAGE_N_EMBD,
    ctxSize = STAGE_CTX_SIZE,
    wireDtype = 'f32',
    defaultMaxDecodeTokens = DEFAULT_MAX_DECODE_TOKENS,
    leaderLockName = DEFAULT_LOCK_NAME,
    timeouts,
    log = () => undefined,
  } = opts;

  const [status, setStatus] = useState<StagePipelineStatus>({ phase: 'idle' });
  const [plan, setPlan] = useState<StagePlan | undefined>(undefined);
  const [tokens, setTokens] = useState<readonly number[]>([]);
  const [text, setText] = useState('');
  const [tpotMs, setTpotMs] = useState<number | undefined>(undefined);
  const [restartCount, setRestartCount] = useState(0);
  const [readyStageIndexes, setReadyStageIndexes] = useState<readonly number[]>([]);

  const lockRef = useRef<{ release: () => void } | null>(null);
  const localWorkerRef = useRef<StageWorkerClient | null>(null);
  const sessionRef = useRef<StageSessionHandle | null>(null);
  const runningRef = useRef(false);
  const tpotSamplesRef = useRef<number[]>([]);
  const lastTokenAtRef = useRef<number | undefined>(undefined);

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
      setTpotMs(undefined);
      setRestartCount(0);
      setReadyStageIndexes([]);
      tpotSamplesRef.current = [];
      lastTokenAtRef.current = undefined;
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
      try {
        const gpu = await detectWebGpuLimits();
        if (!gpu.ok || !gpu.limits) throw new Error(gpu.reason ?? 'WebGPU unavailable for local stage-0');
        const limits: StageHostLimits = gpu.limits;
        const localCap = buildLocalCapacityCap(limits);

        const req = { modelId, totalLayers, avgLayerBytes, nEmbd };
        const initialPlan = planPipelineForDriver(req, peer.selfId, localCap, peer.roster.snapshot(), { wireDtype });
        if (!initialPlan) {
          throw new Error('no feasible pipeline plan — no eligible stage-hosting peers in the roster yet');
        }
        setPlan(initialPlan);
        setStatus({ phase: 'starting' });
        log(`[stage-pipeline] plan: ${initialPlan.stages.map((s) => `${s.peerId}[${s.layerStart},${s.layerEnd})`).join(' -> ')}`);

        const localStage = initialPlan.stages.find((s) => s.stageIndex === 0);
        if (!localStage) throw new Error('plan has no local stage 0 — planPipelineForDriver invariant violated');

        const localWorker = new StageWorkerClient(createStageWorker(), 'driver-stage-0', log);
        await localWorker.load({
          modelId,
          layerStart: localStage.layerStart,
          layerEnd: localStage.layerEnd,
          totalLayers,
          shardUrls: stageShardUrls(),
          ctxSize,
        });
        log(`[stage-pipeline] ${elapsed()} local stage-0 worker loaded (nEmbd=${localWorker.nEmbd}); warming up…`);
        await warmUpStageWorker(localWorker, log);
        log(`[stage-pipeline] ${elapsed()} local stage-0 warm-up done`);
        localWorkerRef.current = localWorker;

        const replan: ReplanFn = (lostPeerId, _graceful) => {
          const freshRoster = peer.roster.snapshot();
          return planPipelineForDriver(req, peer.selfId, localCap, freshRoster, {
            wireDtype,
            excludePeerIds: lostPeerId ? [lostPeerId] : [],
          });
        };

        // Thin logging wrapper — mesh-core's orchestrator is otherwise a
        // black box for "did the sf frame actually get sent, and to
        // whom." Delegates every call straight through; only adds a log
        // line before/after `sendStageFrame` and `sendTool`.
        const loggedPeer: typeof peer = {
          ...peer,
          sendStageFrame: async (bytes, peers) => {
            log(`[stage-pipeline] ${elapsed()} sendStageFrame -> ${JSON.stringify(peers)} (${bytes.byteLength} bytes)`);
            try {
              await peer.sendStageFrame(bytes, peers);
              log(`[stage-pipeline] ${elapsed()} sendStageFrame -> ${JSON.stringify(peers)} OK`);
            } catch (err) {
              log(`[stage-pipeline] ${elapsed()} sendStageFrame -> ${JSON.stringify(peers)} FAILED: ${err instanceof Error ? err.message : String(err)}`);
              throw err;
            }
          },
          sendTool: async (frame, peers) => {
            log(`[stage-pipeline] ${elapsed()} sendTool(${frame.kind}) -> ${JSON.stringify(peers)}`);
            await peer.sendTool(frame, peers);
          },
        };

        const handle = runDriverStageSession({
          peer: loggedPeer,
          plan: initialPlan,
          modelId,
          prompt,
          maxDecodeTokens: startOpts?.maxDecodeTokens ?? defaultMaxDecodeTokens,
          wireDtype,
          localHooks: {
            nEmbd: localWorker.nEmbd,
            tokenize: (t) => localWorker.tokenize(t, true),
            detokenize: (toks) => localWorker.detokenize([...toks]),
            reset: () => localWorker.reset(),
            prefill: async (toks, positions) => {
              log(`[stage-pipeline] ${elapsed()} local prefill start (tokens=${toks.length})`);
              const res = await localWorker.prefill([...toks], [...positions]);
              log(`[stage-pipeline] ${elapsed()} local prefill done`);
              if (!res.activation) throw new Error('local stage-0 prefill produced no activation');
              return { activation: new Float32Array(res.activation.payload) };
            },
            decode: async (token) => {
              const res = await localWorker.decode(token);
              if (!res.activation) throw new Error('local stage-0 decode produced no activation');
              return { activation: new Float32Array(res.activation.payload) };
            },
          },
          replan,
          loadExtras: () => ({ shardUrls: stageShardUrls(), ctxSize }),
          timeouts: {
            bootstrapStepMs: DEFAULT_BOOTSTRAP_STEP_MS,
            loadMs: DEFAULT_LOAD_MS,
            pingMs: DEFAULT_PING_MS,
            ...timeouts,
          },
        });
        sessionRef.current = handle;
        setStatus({ phase: 'running' });

        handle.on((ev: StageOrchestratorEvent) => {
          // Full event trace with wall-clock offsets — see this hook's
          // module doc / the workstream C3 report for why: mesh-core's
          // orchestrator is a black box from here, and "which of
          // preflight/load/decode actually stalled" is only answerable
          // from this event stream, not from llama.cpp's own console spam.
          log(`[stage-pipeline] ${elapsed()} event=${ev.type} ${JSON.stringify(ev).slice(0, 300)}`);
          switch (ev.type) {
            case 'planCreated':
            case 'replan': {
              setPlan(ev.plan);
              if (ev.type === 'replan') {
                setRestartCount(ev.restartCount);
                setReadyStageIndexes([]);
                tpotSamplesRef.current = [];
                lastTokenAtRef.current = undefined;
              }
              break;
            }
            case 'stageReady': {
              setReadyStageIndexes((prev) => (prev.includes(ev.stageIndex) ? prev : [...prev, ev.stageIndex]));
              break;
            }
            case 'token': {
              const now = Date.now();
              if (lastTokenAtRef.current !== undefined) {
                const dt = now - lastTokenAtRef.current;
                const samples = tpotSamplesRef.current;
                samples.push(dt);
                if (samples.length > 32) samples.shift();
                setTpotMs(samples.reduce((a, b) => a + b, 0) / samples.length);
              }
              lastTokenAtRef.current = now;
              const { generatedTokens } = handle.tokenHistory();
              setTokens(generatedTokens);
              void localWorker
                .detokenize([...generatedTokens])
                .then(setText)
                .catch(() => undefined);
              break;
            }
            case 'aborted': {
              setStatus({ phase: 'aborted', reason: ev.reason });
              break;
            }
            case 'finished': {
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
      avgLayerBytes,
      nEmbd,
      ctxSize,
      wireDtype,
      defaultMaxDecodeTokens,
      leaderLockName,
      timeouts,
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

  return { status, plan, tokens, text, tpotMs, restartCount, readyStageIndexes, start, abort };
}
