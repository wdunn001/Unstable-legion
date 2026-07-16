/**
 * useCommunalHost — M3's self-assembly loop: "what should THIS peer be
 * hosting right now, in the communal pipeline, with nobody telling it to."
 *
 * Layering (read `communalAssembly.ts`'s module doc comment first — this
 * hook is the ONLY thing that turns its pure decisions into actual worker
 * loads/unloads and wire advertisements):
 *
 *   1. Every `reassemblyIntervalMs` tick (default 5s), call
 *      `communalHostClaim` against the live roster's `cap.stageHost.
 *      loadedStages` union (via `buildCommunalTopology`, done inside
 *      `communalHostClaim` itself) to get {claim, jitterMs, yieldCurrent}.
 *   2. `yieldCurrent`: stop advertising IMMEDIATELY
 *      (`useStageHost`'s `suppressAdvertise`), then wait for active
 *      sessions to drain (or a grace timeout), then let the claim go —
 *      the NEXT tick's `communalHostClaim` call (now with
 *      `selfCurrentClaim: null`) decides where to go next.
 *   3. A NEW (non-null, different) claim: jittered by stability
 *      (`jitterMs`, smaller for stable hosts) before acting, then resolve
 *      the layer range's artifact fragments (manifest-based
 *      `fragmentsForRange`, respecting the OPFS-quota ceiling — see
 *      `resolveCommunalShardPlan`) and hand them to `useStageHost` via
 *      `preloadStage`, which loads+warms the worker BEFORE this hook ever
 *      lets `useStageHost` advertise it (`useStageHost` itself already
 *      only populates `loadedStages` — and therefore only publishes it —
 *      once `ensureWorkerLoaded` resolves, which is after
 *      `warmUpStageWorker` — so "never advertise a not-warm stage" is
 *      structural here, not a manual check).
 *
 * Everything ELSE (answering `stage.session.open`, admission/queueing,
 * the `sf` decode loop, idle eviction, roster-leave cleanup) is
 * `useStageHost` unchanged — this hook drives WHAT gets loaded and WHEN
 * it's safe to advertise/unload; `useStageHost` still owns HOW a loaded
 * stage serves drivers.
 *
 * HONEST SCOPE NOTE — teardown is a real but SIMPLIFIED approximation of
 * the plan doc's "stop advertising -> drain -> 30s grace -> dispose":
 * this hook stops advertising immediately (real, structural — see above)
 * and waits for sessions to drain naturally or idle-evict; after the
 * grace window it clears its OWN claim (so a subsequent `preloadStage`
 * for a different range is attempted, which — via `useStageHost`'s
 * existing `ensureWorkerLoaded` conflict rule — safely NO-OPS/retries
 * instead of disrupting a still-active session) rather than forcibly
 * severing whatever sessions remain. A genuinely FORCED disconnect after
 * grace (unconditionally killing lingering sessions) is not implemented —
 * `useStageHost` has no such imperative exposed today; adding one is
 * flagged as follow-up in `docs/COMMUNAL.md`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  communalHostClaim,
  hostStabilityScore,
  type CommunalClaimRange,
  type MeshPeerCap,
  type MeshRosterEntry,
  type Peer,
} from '@unstable-legion/core';
import { fragmentsForRange, manifestTiesEmbeddings, parseLayerPackageManifest, type LayerPackageManifest } from '@unstable-legion/stage-runtime';
import { useMeshRoster } from './useMeshRoster.js';
import { useStageHost, type UseStageHostSession, type UseStageHostHandle } from './useStageHost.js';
import { sanitizeWasmHeapBudget, WASM_HEAP_CEILING_BYTES, type StageHostLimits } from './stagePipelinePlanning.js';
import { detectWebGpuLimits } from './webgpuLimits.js';
import type { StageWorkerLog } from './stageWorkerClient.js';
import type { PriorityScoreFn } from './stageSessionAdmission.js';

/**
 * Browsers report `navigator.storage.estimate().quota` inconsistently
 * (some UAs return a fraction of disk, some a fixed per-origin cap) — the
 * plan doc's empirically-observed ceiling for this app's origin is
 * ~3.3-3.5GB. Used as the fallback when `estimate()` is unavailable or
 * returns something implausible (0, or larger than this ceiling — trust
 * the smaller, safer number either way).
 */
export const OPFS_QUOTA_CEILING_BYTES = 3_300_000_000;

export interface UseCommunalHostOptions {
  /** Operator toggle — "participate in the communal pipeline". */
  enabled: boolean;
  peer: Peer | null;
  baseCap: Omit<MeshPeerCap, 'stageHost' | 'ts'> & { ts?: number };
  createStageWorker: () => Worker;
  modelId: string;
  totalLayers: number;
  /** Layers the driver always hosts locally — the communal claim space is
   * `[driverLayers, totalLayers)`. */
  driverLayers: number;
  ctxSize: number;
  wireDtype: 'f32' | 'f16';
  /** Layer-package manifest URL (Phase C artifact slicing —
   * `fragmentsForRange`). Absent -> `fallbackShardUrls()` (Phase A/B
   * full.gguf-with-runtime-filter convention) is used instead, and the
   * OPFS-quota check is skipped (no per-fragment byte accounting exists
   * without a manifest). */
  manifestUrl?: string;
  fallbackShardUrls?: () => readonly string[];
  /** Uniform per-layer byte estimate, used to convert this peer's
   * WebGPU/wasm capacity into a layer COUNT for `communalHostClaim`. Real
   * models have non-uniform layer sizes; this is the same
   * planning-upper-bound simplification `stagePlanner.ts` uses. */
  avgLayerBytes: number;
  keepaliveEnabled?: boolean;
  desiredMaxSessions?: number;
  priorityScore?: PriorityScoreFn;
  /** How often to recompute `communalHostClaim` against the live roster.
   * Default 5000. */
  reassemblyIntervalMs?: number;
  /** Override the OPFS quota estimate (bytes) — mainly for tests. Default:
   * probe `navigator.storage.estimate()`, fall back to
   * `OPFS_QUOTA_CEILING_BYTES`. */
  opfsQuotaBytesOverride?: number;
  log?: StageWorkerLog;
}

export type CommunalHostPhase = 'idle' | 'loading' | 'active' | 'draining';

export interface UseCommunalHostHandle {
  supported: boolean;
  unsupportedReason?: string;
  phase: CommunalHostPhase;
  /** The layer range this host currently targets (may still be loading —
   * see `phase`). Undefined = not currently claiming anything. */
  claim?: CommunalClaimRange;
  /** True once the claimed stage is loaded, warm, and advertised. */
  active: boolean;
  sessions: readonly UseStageHostSession[];
  tokensDecoded: number;
  maxSessions: number;
  queueLength: number;
  lastError?: string;
}

const DEFAULT_REASSEMBLY_MS = 5000;
const DEFAULT_GRACE_MS = 30_000;

async function probeOpfsQuotaBytes(override?: number): Promise<number> {
  if (override !== undefined) return override;
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      const quota = est.quota ?? 0;
      const usage = est.usage ?? 0;
      const available = quota - usage;
      if (Number.isFinite(available) && available > 0) {
        return Math.min(available, OPFS_QUOTA_CEILING_BYTES);
      }
    }
  } catch {
    // best-effort — fall through to the documented ceiling
  }
  return OPFS_QUOTA_CEILING_BYTES;
}

interface ShardPlan {
  shardUrls: readonly string[];
  shardHashes?: readonly string[];
  shardBytes?: readonly number[];
  useMemoryShardStore: boolean;
}

/**
 * Resolve what a stage covering `claim` should fetch. Manifest-based
 * (Phase C artifact slicing via `fragmentsForRange`) when `manifestUrl`
 * is supplied; falls back to `fallbackShardUrls()` (Phase A/B full.gguf,
 * this demo's actually-deployed convention for the small e2e model)
 * otherwise. A communal host never sets `isFirst` for `fragmentsForRange`
 * purposes — the driver always owns embeddings locally (`driverLayers`),
 * a communal claim never starts before that boundary.
 */
export async function resolveCommunalShardPlan(
  claim: CommunalClaimRange,
  opts: {
    manifestUrl?: string;
    fallbackShardUrls?: () => readonly string[];
    opfsQuotaBytes: number;
    fetchImpl?: typeof fetch;
    manifestCache?: { url: string; manifest: LayerPackageManifest } | null;
  },
): Promise<{ plan: ShardPlan; manifestCache: { url: string; manifest: LayerPackageManifest } | null }> {
  if (!opts.manifestUrl) {
    return {
      plan: { shardUrls: opts.fallbackShardUrls?.() ?? [], useMemoryShardStore: false },
      manifestCache: opts.manifestCache ?? null,
    };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  let cache = opts.manifestCache ?? null;
  if (!cache || cache.url !== opts.manifestUrl) {
    const res = await fetchImpl(opts.manifestUrl);
    if (!res.ok) throw new Error(`failed to fetch communal manifest ${opts.manifestUrl}: ${res.status} ${res.statusText}`);
    const manifest = parseLayerPackageManifest(await res.json());
    cache = { url: opts.manifestUrl, manifest };
  }
  const manifest = cache.manifest;
  const fragments = fragmentsForRange(manifest, opts.manifestUrl, claim.layerStart, claim.layerEnd, false, claim.includeOutput);
  const totalBytes = fragments.reduce((sum, f) => sum + f.bytes, 0);
  const useMemoryShardStore = totalBytes > opts.opfsQuotaBytes;
  return {
    plan: {
      shardUrls: fragments.map((f) => f.url),
      shardHashes: fragments.map((f) => f.sha256),
      shardBytes: fragments.map((f) => f.bytes),
      useMemoryShardStore,
    },
    manifestCache: cache,
  };
}

/** `manifestTiesEmbeddings` is re-exported here purely so a consumer
 * building a manifest-aware UI doesn't need a second import from
 * `@unstable-legion/stage-runtime` just for this one check. */
export { manifestTiesEmbeddings };

export function useCommunalHost(opts: UseCommunalHostOptions): UseCommunalHostHandle {
  const {
    enabled,
    peer,
    modelId,
    totalLayers,
    driverLayers,
    ctxSize,
    wireDtype,
    manifestUrl,
    fallbackShardUrls,
    avgLayerBytes,
    reassemblyIntervalMs = DEFAULT_REASSEMBLY_MS,
    priorityScore,
    opfsQuotaBytesOverride,
    log = () => undefined,
  } = opts;

  const roster = useMeshRoster();
  const rosterRef = useRef<readonly MeshRosterEntry[]>(roster);
  rosterRef.current = roster;

  const [supportState, setSupportState] = useState<{ ok: boolean; reason?: string }>({ ok: true });
  const [limits, setLimits] = useState<StageHostLimits | null>(null);
  const [claim, setClaim] = useState<CommunalClaimRange | undefined>(undefined);
  const [phase, setPhase] = useState<CommunalHostPhase>('idle');
  const [preloadStage, setPreloadStage] = useState<Parameters<typeof useStageHost>[0]['preloadStage']>(null);
  const [suppressAdvertise, setSuppressAdvertise] = useState(false);
  const [lastError, setLastError] = useState<string | undefined>(undefined);

  const claimRef = useRef<CommunalClaimRange | undefined>(undefined);
  claimRef.current = claim;
  const drainStartedAtRef = useRef<number | undefined>(undefined);
  const manifestCacheRef = useRef<{ url: string; manifest: LayerPackageManifest } | null>(null);
  const opfsQuotaBytesRef = useRef<number>(OPFS_QUOTA_CEILING_BYTES);
  const tickInFlightRef = useRef(false);
  const priorityScoreRef = useRef<PriorityScoreFn>(priorityScore ?? (() => 0));
  priorityScoreRef.current = priorityScore ?? (() => 0);

  const createStageWorker = useMemo(() => opts.createStageWorker, [opts.createStageWorker]);

  // ── Feature-detect once ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void detectWebGpuLimits().then((result) => {
      if (cancelled) return;
      setSupportState({ ok: result.ok, reason: result.reason });
      if (result.ok && result.limits) setLimits(result.limits);
    });
    void probeOpfsQuotaBytes(opfsQuotaBytesOverride).then((bytes) => {
      if (!cancelled) opfsQuotaBytesRef.current = bytes;
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── The host object this hook drives (owns admission/serving/decode) ──
  const host: UseStageHostHandle = useStageHost({
    enabled,
    peer,
    baseCap: opts.baseCap,
    createStageWorker,
    keepaliveEnabled: opts.keepaliveEnabled,
    desiredMaxSessions: opts.desiredMaxSessions,
    priorityScore,
    preloadStage,
    suppressAdvertise,
    log: opts.log,
  });
  const hostSessionCount = host.sessions.length;

  // ── Assembly loop ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !peer || !supportState.ok || !limits) return;
    // Captured into a local `const` so the nested `tick` closure retains
    // the non-null narrowing (TS doesn't extend narrowing of an outer
    // `useState` value across a nested function declaration boundary).
    const safeLimits = limits;
    const safePeer = peer;

    const selfCapacityLayers = Math.max(0, Math.floor(sanitizeWasmHeapBudget(safeLimits.maxStorageBufferBindingSize) / avgLayerBytes));
    let cancelled = false;
    let jitterTimer: ReturnType<typeof setTimeout> | undefined;

    async function tick(): Promise<void> {
      if (cancelled || tickInFlightRef.current) return;
      tickInFlightRef.current = true;
      try {
        const decision = communalHostClaim({
          roster: rosterRef.current.filter((r) => r.peerId !== safePeer.selfId),
          selfPeerId: safePeer.selfId,
          modelId,
          totalLayers,
          driverLayers,
          selfCapacityLayers,
          selfCurrentClaim: claimRef.current ?? null,
          selfStabilityScore: hostStabilityScore({
            maxStorageBufferBytes: safeLimits.maxStorageBufferBindingSize,
            wasmHeapBudget: sanitizeWasmHeapBudget(safeLimits.maxStorageBufferBindingSize),
            stability: { keepalive: !!opts.keepaliveEnabled, visible: typeof document === 'undefined' || document.visibilityState === 'visible', uptimeMs: 0 },
          }),
          priorityScore: priorityScoreRef.current,
        });
        log(`[communal-host] claim decision: ${decision.reason} (jitterMs=${decision.jitterMs})`);

        if (decision.yieldCurrent) {
          if (phase !== 'draining') {
            log('[communal-host] yielding wasteful duplicate — stop advertising, draining');
            setSuppressAdvertise(true);
            setPhase('draining');
            drainStartedAtRef.current = Date.now();
          }
          const drained = hostSessionCount === 0;
          const graceElapsed = Date.now() - (drainStartedAtRef.current ?? Date.now()) > DEFAULT_GRACE_MS;
          if (drained || graceElapsed) {
            log(`[communal-host] drain complete (drained=${drained} graceElapsed=${graceElapsed}) — releasing claim`);
            setClaim(undefined);
            setPreloadStage(null);
            setSuppressAdvertise(false);
            drainStartedAtRef.current = undefined;
            setPhase('idle');
          }
          return;
        }

        if (!decision.claim) {
          if (phase !== 'idle') setPhase('idle');
          return;
        }

        const changed =
          !claimRef.current ||
          claimRef.current.layerStart !== decision.claim.layerStart ||
          claimRef.current.layerEnd !== decision.claim.layerEnd ||
          claimRef.current.includeOutput !== decision.claim.includeOutput;
        if (!changed) return;

        await new Promise((resolve) => setTimeout(resolve, decision.jitterMs));
        if (cancelled) return;
        // Re-check after the jitter delay — the roster may have moved and
        // this claim may no longer be the right one (another peer beat us
        // to it, or the gap closed already).
        const recheck = communalHostClaim({
          roster: rosterRef.current.filter((r) => r.peerId !== safePeer.selfId),
          selfPeerId: safePeer.selfId,
          modelId,
          totalLayers,
          driverLayers,
          selfCapacityLayers,
          selfCurrentClaim: claimRef.current ?? null,
          priorityScore: priorityScoreRef.current,
        });
        if (!recheck.claim || cancelled) return;

        setPhase('loading');
        setClaim(recheck.claim);
        try {
          const { plan, manifestCache } = await resolveCommunalShardPlan(recheck.claim, {
            manifestUrl,
            fallbackShardUrls,
            opfsQuotaBytes: opfsQuotaBytesRef.current,
            manifestCache: manifestCacheRef.current,
          });
          manifestCacheRef.current = manifestCache;
          if (cancelled) return;
          setPreloadStage({
            modelId,
            layerStart: recheck.claim.layerStart,
            layerEnd: recheck.claim.layerEnd,
            totalLayers,
            ctxSize,
            wireDtype,
            shardUrls: plan.shardUrls,
            shardHashes: plan.shardHashes,
            shardBytes: plan.shardBytes,
            useMemoryShardStore: plan.useMemoryShardStore,
          });
          setSuppressAdvertise(false);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setLastError(message);
          log(`[communal-host] failed to resolve shard plan for [${recheck.claim.layerStart},${recheck.claim.layerEnd}): ${message}`);
        }
      } finally {
        tickInFlightRef.current = false;
      }
    }

    void tick();
    const timer = setInterval(() => void tick(), reassemblyIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (jitterTimer) clearTimeout(jitterTimer);
    };
    // `phase`/`hostSessionCount` deliberately included — the drain-vs-idle
    // branch above needs their CURRENT values every tick (read fresh via
    // closure), and they change rarely enough (session count changes are
    // debounced by the loop's own `reassemblyIntervalMs` cadence) that
    // restarting this effect on their change is cheap and correct, unlike
    // `useStageHost`'s "answer" effect which must never restart on
    // session churn (this effect holds no session/worker state itself —
    // it only decides intent, `useStageHost` owns the actual resources).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, peer, supportState.ok, limits, modelId, totalLayers, driverLayers, avgLayerBytes, manifestUrl, fallbackShardUrls, ctxSize, wireDtype, reassemblyIntervalMs, phase, hostSessionCount]);

  useEffect(() => {
    if (!enabled) {
      setClaim(undefined);
      setPreloadStage(null);
      setSuppressAdvertise(false);
      setPhase('idle');
    }
  }, [enabled]);

  useEffect(() => {
    if (phase === 'loading' && host.active && host.stageHostCap?.loadedStages?.length) setPhase('active');
  }, [phase, host.active, host.stageHostCap]);

  return {
    supported: supportState.ok,
    unsupportedReason: supportState.reason,
    phase,
    claim,
    active: host.active && phase === 'active',
    sessions: host.sessions,
    tokensDecoded: host.tokensDecoded,
    maxSessions: host.maxSessions,
    queueLength: host.queueLength,
    lastError: lastError ?? host.lastError,
  };
}
