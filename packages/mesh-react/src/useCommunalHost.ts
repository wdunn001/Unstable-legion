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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  communalHostClaim,
  hostStabilityScore,
  type CommunalClaimRange,
  type MeshLoadedStage,
  type MeshPeerCap,
  type MeshRosterEntry,
  type Peer,
  type StandingLedger,
} from '@unstable-legion/core';
import { fragmentsForRange, manifestTiesEmbeddings, parseLayerPackageManifest, type LayerPackageManifest } from '@unstable-legion/stage-runtime';
import { useMeshRoster } from './useMeshRoster.js';
import { useStageHost, type UseStageHostSession, type UseStageHostHandle } from './useStageHost.js';
import { sanitizeWasmHeapBudget, sanitizeWeightBudget, WASM_HEAP_CEILING_BYTES, type StageHostLimits } from './stagePipelinePlanning.js';
import { detectWebGpuLimits } from './webgpuLimits.js';
import {
  createColocationCoordinator,
  getOrCreateFailureDomainId,
  type ColocationCoordinatorHandle,
  type ColocationCoordinatorOptions,
} from './colocation.js';
import type { StageWorkerLog } from './stageWorkerClient.js';
import type { StageWorkerLoadProgress } from './stageWorkerProtocol.js';
import type { PriorityScoreFn } from './stageSessionAdmission.js';
import {
  claimKey,
  claimsEqual,
  computeBackoffMs,
  describeHostError,
  emitTelemetry,
  extractHttpStatus,
  retryCountdownSec,
  type BackoffOptions,
  type MeshTelemetrySink,
  type StageHostLifecycleEvent,
} from './meshResilience.js';

/**
 * Browsers report `navigator.storage.estimate().quota` inconsistently
 * (some UAs return a fraction of disk, some a fixed per-origin cap) — the
 * plan doc's empirically-observed ceiling for this app's origin is
 * ~3.3-3.5GB. Used as the fallback when `estimate()` is unavailable or
 * returns something implausible (0, or larger than this ceiling — trust
 * the smaller, safer number either way).
 */
export const OPFS_QUOTA_CEILING_BYTES = 3_300_000_000;

/**
 * Safety headroom subtracted from a GENUINE, generous quota estimate
 * (persisted storage, or a UA reporting real available disk) — never
 * claim the last byte of available storage (other origins/apps share the
 * same disk budget; a hair-thin margin risks a mid-write
 * QuotaExceededError on a slow/large final shard).
 */
export const OPFS_QUOTA_SAFETY_MARGIN_BYTES = 1_500_000_000;

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
  /**
   * OPTIONAL-STAGE0 — when true, this host contributes to the THIN-driver
   * regime: it claims over `[0, totalLayers)` instead of `[driverLayers,
   * totalLayers)`, so its lowest claim owns the model's embeddings (an
   * isFirst communal host) and gives no-GPU peers a remote first stage. The
   * loaded stage's `layerStart === 0` makes `useStageHost` report
   * `isFirst`/`includeEmbeddings` automatically. Off by default (the
   * capable-driver body-host regime). See `docs/OPTIONAL-STAGE0.md`. */
  supportThinDrivers?: boolean;
  ctxSize: number;
  wireDtype: 'f32' | 'f16' | 'i8';
  /** Layer-package manifest URL (Phase C artifact slicing —
   * `fragmentsForRange`). Absent -> `fallbackShardUrls()` (Phase A/B
   * full.gguf-with-runtime-filter convention) is used instead, and the
   * OPFS-quota check is skipped (no per-fragment byte accounting exists
   * without a manifest). */
  manifestUrl?: string | readonly string[];
  fallbackShardUrls?: () => readonly string[];
  /**
   * LOCAL-MODEL-FOLDER — a `FileSystemDirectoryHandle` (from
   * `apps/chat/src/hooks/useModelFolder.ts`) pointing at a local clone of
   * this manifest's model package. When set, this host's proactive
   * preload (`issuePreload` below, `useStageHost`'s `preloadStage.
   * localFolderHandle`) fetches fragment BYTES from the folder instead of
   * the network — `manifestUrl`/the fragment hashes it verifies against
   * are UNCHANGED; see `localFolderFetch.ts`'s trust-model doc comment.
   * Read via a ref (like `priorityScore` below) so a fresh identity each
   * render doesn't restart the assembly-loop effect. `undefined` =
   * unchanged network-fetch behavior.
   */
  localFolderHandle?: FileSystemDirectoryHandle;
  /** Uniform per-layer byte estimate, used to convert this peer's
   * WebGPU/wasm capacity into a layer COUNT for `communalHostClaim`. Real
   * models have non-uniform layer sizes; this is the same
   * planning-upper-bound simplification `stagePlanner.ts` uses. */
  avgLayerBytes: number;
  keepaliveEnabled?: boolean;
  desiredMaxSessions?: number;
  priorityScore?: PriorityScoreFn;
  /** M4 — forwarded verbatim to `useStageHost`'s `standingLedger` option
   * (consumption telemetry on every session free) — see that hook's doc
   * comment and `docs/ECONOMY.md`. */
  standingLedger?: StandingLedger;
  /** How often to recompute `communalHostClaim` against the live roster.
   * Default 5000. */
  reassemblyIntervalMs?: number;
  /** Override the OPFS quota estimate (bytes) — mainly for tests. Default:
   * probe `navigator.storage.estimate()`, fall back to
   * `OPFS_QUOTA_CEILING_BYTES`. */
  opfsQuotaBytesOverride?: number;
  /** Exponential-backoff tuning for a FAILED preload/load — a failed claim
   * is NOT re-attempted every roster heartbeat, it waits out a jittered
   * backoff (2s→4s→…→cap ~60s). Mainly for tests (inject a fixed RNG).
   * Default: `{ baseMs: 2000, capMs: 60000, factor: 2, jitter: 0.25 }`. */
  backoff?: BackoffOptions;
  /** Injectable RNG for backoff jitter — tests pin it. Default Math.random. */
  backoffRandom?: () => number;
  /** Attempt count at which the phase label flips from 'retrying'
   * (transient) to 'error' (persistent — still retrying at the cap, but
   * the UI stops promising a fast recovery). Default 4. */
  giveUpLabelAfterAttempts?: number;
  /** Vendor-neutral telemetry sink — the host loop emits `host_load_failed`
   * / `host_load_succeeded` / `stage_worker_crashed` at the same points it
   * surfaces an error. Omit to disable telemetry entirely. */
  telemetry?: MeshTelemetrySink;
  log?: StageWorkerLog;
  /**
   * Operator opt-in (apps/chat's "Contribute more" panel) — overrides the
   * WEIGHT budget used for layer-claim sizing, separate from
   * `wasmHeapBudget` (KV/session sizing, always governed by
   * `WASM_HEAP_CEILING_BYTES` regardless of this field — see
   * `stagePipelinePlanning.ts#sanitizeWeightBudget`'s doc comment).
   * Absent = unchanged default behavior (~11 layers for Qwen3-8B q4).
   * Clamped to `[avgLayerBytes, CONTRIBUTION_BUDGET_CEILING_BYTES]`.
   */
  contributionBudgetBytes?: number;
  /**
   * Operator opt-in (apps/chat's "Layers to host: N of 34" slider) — a
   * DIRECT layer-count cap on the claim WIDTH the assembly loop's greedy
   * lowest-uncovered-gap claim (`communalHostClaim`, `communalAssembly.ts`)
   * is willing to take, applied to `selfCapacityLayers` — the SAME
   * capacity input `contributionBudgetBytes`/VRAM detection ultimately
   * feeds (see `hostCapacityBytes`'s doc comment: capacity is always
   * "this host's usable budget for one stage", byte-derived-by-default).
   * This is an ALTERNATE, more direct way to express that same budget for
   * users who'd rather pick a layer count than reason about GB — it
   * REPLACES the byte-derived count (not intersected with it) once set,
   * mirroring `contributionBudgetBytes`'s own "operator self-report,
   * clamped only for sanity" trust model (worst case of setting it too
   * high is a slow/failed load — the hard safety ceiling is
   * `wasmHeapBudget`/`WASM_HEAP_CEILING_BYTES`, untouched by this field,
   * same as `contributionBudgetBytes`). `undefined` = unchanged
   * byte-budget-derived behavior. Clamped to `>= 0`; `communalHostClaim`
   * itself already clamps the resulting claim width to the actual gap
   * size, so no upper clamp against `totalLayers - driverLayers` is
   * needed here.
   */
  maxLayersOverride?: number;
  /**
   * Same-origin tab colocation (see `colocation.ts`'s module doc) —
   * collapses hosting to exactly ONE tab per browser profile per machine.
   * Default `true`. Set `false` to opt this consumer OUT and restore the
   * pre-fix "every enabled tab hosts independently" behavior (e.g. a host
   * embedding this hook in a context where each mount is deliberately its
   * OWN origin/profile, or a test harness that wants the old shape).
   */
  colocationEnabled?: boolean;
  /** Override the failure-domain id this peer advertises (mainly for
   * tests). Default: `getOrCreateFailureDomainId()` (localStorage-backed,
   * stable per browser profile). */
  failureDomainId?: string;
  /** Injectable coordinator factory (tests pin a fake BroadcastChannel/
   * LockManager via `ColocationCoordinatorOptions`, or replace the whole
   * coordinator). Default `createColocationCoordinator`. */
  createColocationCoordinator?: (opts?: ColocationCoordinatorOptions) => ColocationCoordinatorHandle;
  /**
   * REUSE-STAGE0 — passed straight through to the internal `useStageHost`
   * call's `extraLoadedStages` option, so a peer that ALSO serves its
   * resident stage-0 (`useLocalStageServe.ts`) advertises both entries in
   * ONE `cap.stageHost.loadedStages` array. See that option's doc comment
   * for why this must flow through the SAME `peer.setCap` call site
   * regardless of whether THIS hook's own hosting is enabled. `undefined`
   * = unchanged pre-existing behavior.
   */
  extraLoadedStages?: readonly MeshLoadedStage[];
}

export type CommunalHostPhase = 'idle' | 'loading' | 'active' | 'draining' | 'retrying' | 'error';

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
  /** Human, model-named error copy for the host panel + capacity meter —
   * present whenever `phase` is 'retrying' or 'error'. NEVER a silent
   * spinner: a failing host always has a message here. */
  errorMessage?: string;
  /** True while a bounded retry is scheduled (transient) — the UI shows a
   * countdown; false while healthy OR once we've dropped to the slow
   * cap-interval "still failing" heartbeat. */
  retrying: boolean;
  /** Epoch-ms of the next scheduled retry (for a countdown), when retrying. */
  nextRetryAtMs?: number;
  /** How many load attempts have failed for the current claim. 0 = healthy. */
  retryAttempt: number;
  /** Per-shard download progress for the stage currently loading — see
   * `UseStageHostHandle.loadProgress`'s doc comment. Undefined outside an
   * in-flight load (nothing claimed yet, or already fully loaded/active).
   * On a follower tab (colocation), this mirrors the leader's relayed
   * snapshot instead of running its own load. */
  downloadProgress?: StageWorkerLoadProgress;
}

const DEFAULT_REASSEMBLY_MS = 5000;
const DEFAULT_GRACE_MS = 30_000;
const DEFAULT_GIVE_UP_LABEL_AFTER = 4;

/** Cheap, synchronous, side-effect-free mirror of
 * `colocation.ts#createColocationCoordinator`'s own `supported` check —
 * used ONLY to seed `isLeader`'s initial state so a tab that WILL end up
 * a follower never renders even one frame as "leader" (which could
 * otherwise kick off a spurious preload before the real coordinator's
 * async lock resolution corrects it). When this guesses `true` (locks/
 * BroadcastChannel look present), the real coordinator settles the
 * authoritative answer moments later via `onLeaderChange`. */
function colocationLikelySupported(): boolean {
  return (
    typeof BroadcastChannel !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.locks?.request === 'function'
  );
}

/**
 * Best-effort: ask the UA not to evict this origin's OPFS storage under
 * storage pressure — called once hosting is actually opted into (not on
 * cold mount, before the user has agreed to anything). On Chromium this
 * both makes OPFS non-evictable AND typically unlocks a far larger real
 * quota (a substantial fraction of disk instead of the small default
 * per-origin slice) — see `probeOpfsQuotaBytes`'s `persisted` param,
 * which is what actually stops over-3.3GB claims being forced onto the
 * (never-persisted, wiped-on-retry) in-memory shard store. Never throws;
 * returns whether persistence is granted (false on any failure or an
 * unsupported browser) and logs the grant result when `log` is supplied.
 */
export async function requestPersistentStorage(log: StageWorkerLog = () => undefined): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.persist !== 'function') return false;
    const already = (await navigator.storage.persisted?.()) ?? false;
    if (already) return true;
    const granted = await navigator.storage.persist();
    log(`[communal-host] navigator.storage.persist() ${granted ? 'GRANTED' : 'denied'}`);
    return granted;
  } catch (err) {
    log(`[communal-host] navigator.storage.persist() failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Resolves the OPFS byte budget `resolveCommunalShardPlan` weighs a
 * claim's total fragment bytes against to decide OPFS-cached vs
 * in-memory (see that function's `useMemoryShardStore` derivation).
 *
 * Used to unconditionally cap this at `OPFS_QUOTA_CEILING_BYTES`
 * (~3.3GB) regardless of what the UA actually reported — which meant
 * ANY claim bigger than that (a full 34-layer Qwen3-8B range is ~4.7GB)
 * got the in-memory store, which doesn't survive a worker restart: a
 * stall-watchdog retry (or a page reload) re-downloaded every shard from
 * scratch every time, even shards already fetched moments earlier.
 *
 * Now: a GENUINE generous estimate — `persisted` storage (see
 * `requestPersistentStorage`), or a UA reporting more real available
 * space than the conservative ceiling on its own — is trusted directly
 * (minus `OPFS_QUOTA_SAFETY_MARGIN_BYTES`), so a host with disk to spare
 * gets its whole claim OPFS-cached and persisted. The in-memory store
 * stays the fallback ONLY when the real available quota genuinely can't
 * fit the range (a small/default-looking estimate, or `estimate()`
 * itself unavailable/erroring) — `OPFS_QUOTA_CEILING_BYTES` is the
 * conservative floor for exactly that case, not the default ceiling for
 * every host.
 */
async function probeOpfsQuotaBytes(override?: number, persisted = false): Promise<number> {
  if (override !== undefined) return override;
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      const quota = est.quota ?? 0;
      const usage = est.usage ?? 0;
      const available = quota - usage;
      if (Number.isFinite(available) && available > 0) {
        const genuinelyGenerous = persisted || available > OPFS_QUOTA_CEILING_BYTES;
        if (genuinelyGenerous) {
          return Math.max(0, available - OPFS_QUOTA_SAFETY_MARGIN_BYTES);
        }
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
  /** Per-shard role from the layer-package manifest (Fragment.role) — carried
   * so the incremental loader can tell the metadata fragment from data shards
   * (see stage-runtime's StageDescriptor.shardRoles / loadStageIncremental). */
  shardRoles?: readonly ('metadata' | 'embeddings' | 'output' | 'layer')[];
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
    /** One manifest URL, or an ORDERED failover list (first reachable +
     * parseable source wins; its URL becomes the base every relative
     * fragment path resolves against, so a manifest and its weights
     * share an origin unless the manifest carries absolute paths).
     * apps/chat passes [Hugging Face, jsDelivr/GitHub, cdn.codecai.net]. */
    manifestUrl?: string | readonly string[];
    fallbackShardUrls?: () => readonly string[];
    opfsQuotaBytes: number;
    fetchImpl?: typeof fetch;
    manifestCache?: { url: string; manifest: LayerPackageManifest } | null;
    /** Pull the shared embeddings fragment in ADDITION to the layer range.
     * The driver's local stage-0 (`[0, driverLayers)`) is the FIRST stage and
     * needs embeddings; communal hosts (which start at `driverLayers`, never
     * layer 0) do not. Defaults to false so every existing communal-host
     * caller is unchanged. Model-agnostic: the embeddings fragment and its
     * size come entirely from the manifest — no hardcoded dimensions. */
    includeEmbeddings?: boolean;
  },
): Promise<{ plan: ShardPlan; manifestCache: { url: string; manifest: LayerPackageManifest } | null }> {
  const manifestUrls = (typeof opts.manifestUrl === 'string' ? [opts.manifestUrl] : [...(opts.manifestUrl ?? [])]).filter(Boolean);
  if (manifestUrls.length === 0) {
    return {
      plan: { shardUrls: opts.fallbackShardUrls?.() ?? [], useMemoryShardStore: false },
      manifestCache: opts.manifestCache ?? null,
    };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  // A cached manifest stays valid as long as its source is still IN the
  // list — reordering/removing a source invalidates, a lower-priority
  // cache hit is kept rather than re-probing the primary every tick.
  let cache = opts.manifestCache && manifestUrls.includes(opts.manifestCache.url) ? opts.manifestCache : null;
  if (!cache) {
    let lastError: unknown;
    for (const url of manifestUrls) {
      try {
        const res = await fetchImpl(url);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        cache = { url, manifest: parseLayerPackageManifest(await res.json()) };
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!cache) {
      throw new Error(
        `failed to fetch communal manifest from every source (${manifestUrls.join(' → ')}): ` +
          (lastError instanceof Error ? lastError.message : String(lastError)),
      );
    }
  }
  const manifest = cache.manifest;
  // Base URL for relative fragment paths = the WINNING source, not the
  // primary — a manifest served by the fallback origin must pull its
  // weights from that same origin (absolute paths are unaffected).
  const fragments = fragmentsForRange(manifest, cache.url, claim.layerStart, claim.layerEnd, opts.includeEmbeddings ?? false, claim.includeOutput);
  const totalBytes = fragments.reduce((sum, f) => sum + f.bytes, 0);
  const useMemoryShardStore = totalBytes > opts.opfsQuotaBytes;
  return {
    plan: {
      shardUrls: fragments.map((f) => f.url),
      shardHashes: fragments.map((f) => f.sha256),
      shardBytes: fragments.map((f) => f.bytes),
      shardRoles: fragments.map((f) => f.role),
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
    supportThinDrivers = false,
    ctxSize,
    wireDtype,
    manifestUrl,
    fallbackShardUrls,
    avgLayerBytes,
    reassemblyIntervalMs = DEFAULT_REASSEMBLY_MS,
    priorityScore,
    opfsQuotaBytesOverride,
    colocationEnabled = true,
    log = () => undefined,
  } = opts;

  const roster = useMeshRoster();
  const rosterRef = useRef<readonly MeshRosterEntry[]>(roster);
  rosterRef.current = roster;

  // ── Same-origin tab colocation — one shared host per browser profile ──
  // (see colocation.ts's module doc). `isLeader` seeds "true" whenever
  // colocation is off/unsupported (every enabled tab hosts independently,
  // today's pre-fix behavior) and otherwise seeds via a synchronous guess
  // that matches the coordinator's own settled answer (see
  // `colocationLikelySupported`'s doc comment) so a tab that will end up
  // a follower never renders even one frame as leader.
  const [failureDomainId] = useState<string | undefined>(() => opts.failureDomainId ?? getOrCreateFailureDomainId());
  const [isLeader, setIsLeader] = useState<boolean>(() => !colocationEnabled || !colocationLikelySupported());
  const coordinatorRef = useRef<ColocationCoordinatorHandle | null>(null);
  const [, bumpSharedStatusTick] = useState(0);

  useEffect(() => {
    if (!colocationEnabled || !enabled) {
      // Colocation off, or hosting itself not consented-to: never compete
      // for the leader lock (a declined tab holding it would starve any
      // sibling tab that DOES consent — see this hook's PR doc), and no
      // coordinator exists to follow either. `isLeader: true` here just
      // means "not a follower of anyone" — the actual GPU/mesh work stays
      // gated on `hostingActive` (`enabled && isLeader`) regardless, so a
      // declined tab still does nothing; it just reports its own
      // (idle) local state instead of mirroring a sibling's.
      setIsLeader(true);
      return;
    }
    const factory = opts.createColocationCoordinator ?? createColocationCoordinator;
    const coordinator = factory();
    coordinatorRef.current = coordinator;
    setIsLeader(coordinator.isLeader());
    const unsubLeader = coordinator.onLeaderChange(setIsLeader);
    const unsubStatus = coordinator.onStatusChange(() => bumpSharedStatusTick((n) => n + 1));
    return () => {
      unsubLeader();
      unsubStatus();
      coordinator.close();
      coordinatorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colocationEnabled, enabled]);

  // The actual GPU-worker/OPFS/mesh-advertise loop runs ONLY on the
  // elected leader tab (or on every tab when colocation is off/
  // unsupported, in which case `isLeader` is unconditionally true) —
  // this is the structural fix for "N same-origin tabs = N independent
  // hosting attempts": non-leader tabs simply never enable `useStageHost`
  // or the assembly-loop effect below.
  const hostingActive = enabled && isLeader;

  const [supportState, setSupportState] = useState<{ ok: boolean; reason?: string }>({ ok: true });
  const [limits, setLimits] = useState<StageHostLimits | null>(null);
  const [claim, setClaim] = useState<CommunalClaimRange | undefined>(undefined);
  const [phase, setPhase] = useState<CommunalHostPhase>('idle');
  const [preloadStage, setPreloadStage] = useState<Parameters<typeof useStageHost>[0]['preloadStage']>(null);
  const [suppressAdvertise, setSuppressAdvertise] = useState(false);
  const [forceDisconnect, setForceDisconnect] = useState<{ reason: string; nonce: number } | null>(null);
  const [lastError, setLastError] = useState<string | undefined>(undefined);
  /** Raw parts of the current failure — the displayed message (with its
   * live retry countdown) is derived on every render so the countdown
   * ticks down instead of freezing at schedule-time. */
  const [errorState, setErrorState] = useState<
    | { reason: string; layerStart: number; layerEnd: number; httpStatus?: number; retrying: boolean; nextAttemptAtMs?: number; attempt: number }
    | undefined
  >(undefined);

  const claimRef = useRef<CommunalClaimRange | undefined>(undefined);
  claimRef.current = claim;
  // `phase`/`hostSessionCount` are read INSIDE the assembly loop but must
  // NOT be effect dependencies: a `setPhase('loading')` from within a tick
  // would otherwise tear the effect down mid-`await` (cancelling the very
  // retry that set it) and, more broadly, restart the loop on every phase/
  // session change. Read fresh via refs → current values, zero restarts.
  const phaseRef = useRef<CommunalHostPhase>(phase);
  phaseRef.current = phase;
  const drainStartedAtRef = useRef<number | undefined>(undefined);
  const manifestCacheRef = useRef<{ url: string; manifest: LayerPackageManifest } | null>(null);
  const opfsQuotaBytesRef = useRef<number>(OPFS_QUOTA_CEILING_BYTES);
  const tickInFlightRef = useRef(false);
  // Anti-thundering-herd stagger, made remount-proof. A fresh claim must
  // wait out `jitterMs` before committing (so N hosts don't stampede the
  // same gap). The OLD implementation did that with `await sleep(jitterMs)`
  // INSIDE the tick — but a background-tab timer throttle stretches that
  // sleep for many seconds, and any effect remount during it flips the
  // tick's local `cancelled` and discards the whole commit, so the host
  // livelocks at 0% (claim decided, never loaded, no fetch, no error). This
  // ref instead records the claim + a WALL-CLOCK deadline and SURVIVES
  // remounts: any later tick (interval, scheduled re-tick, or the immediate
  // tick a remount itself fires) commits it once `Date.now()` passes the
  // deadline — throttle-proof, since the deadline is real time, not a timer.
  const pendingClaimRef = useRef<{ claim: CommunalClaimRange; notBeforeMs: number } | null>(null);
  const priorityScoreRef = useRef<PriorityScoreFn>(priorityScore ?? (() => 0));
  priorityScoreRef.current = priorityScore ?? (() => 0);
  // LOCAL-MODEL-FOLDER — read fresh at issue time (see `issuePreload`
  // below) without being an assembly-loop effect dependency, same
  // "ref, not a dep" discipline as `priorityScoreRef` above.
  const localFolderHandleRef = useRef<FileSystemDirectoryHandle | undefined>(opts.localFolderHandle);
  localFolderHandleRef.current = opts.localFolderHandle;

  // ── Backoff + dedup state (kill the tight retry loop + log storm) ─────
  const backoffOptsRef = useRef<BackoffOptions | undefined>(opts.backoff);
  backoffOptsRef.current = opts.backoff;
  const backoffRandomRef = useRef<() => number>(opts.backoffRandom ?? Math.random);
  backoffRandomRef.current = opts.backoffRandom ?? Math.random;
  const giveUpAfterRef = useRef<number>(opts.giveUpLabelAfterAttempts ?? DEFAULT_GIVE_UP_LABEL_AFTER);
  giveUpAfterRef.current = opts.giveUpLabelAfterAttempts ?? DEFAULT_GIVE_UP_LABEL_AFTER;
  const telemetryRef = useRef<MeshTelemetrySink | undefined>(opts.telemetry);
  telemetryRef.current = opts.telemetry;
  /** Per-claim retry bookkeeping — `attempt` is the NEXT attempt's index,
   * `nextAttemptAt` gates the tick loop's re-issue, `inFlight` blocks a
   * re-issue while a retry load is actually running. Null = healthy. */
  const retryRef = useRef<{ key: string; attempt: number; nextAttemptAt: number; inFlight: boolean } | null>(null);
  /** Last logged assembly decision — the loop logs/acts only on CHANGE
   * (idempotent-quiet when nothing changed), killing the per-tick storm. */
  const lastDecisionKeyRef = useRef<string>('');

  const createStageWorker = useMemo(() => opts.createStageWorker, [opts.createStageWorker]);

  // ── Backoff scheduler — a failed load waits out a jittered exponential
  // backoff instead of being re-attempted every roster heartbeat. Stable
  // identity (refs + setState only) so the assembly effect can call it
  // through its own closure without staleness. ─────────────────────────
  const scheduleRetry = useCallback(
    (failure: { modelId: string; layerStart: number; layerEnd: number; reason: string; httpStatus?: number }): void => {
      // Key on the layer RANGE only (not `includeOutput`) — the failing
      // claim is identified by its range; `includeOutput` is derived from
      // it being the final stage and must not split a retry from its claim.
      const key = `${failure.layerStart}:${failure.layerEnd}`;
      const prevAttempt = retryRef.current && retryRef.current.key === key ? retryRef.current.attempt : 0;
      const delayMs = computeBackoffMs(prevAttempt, backoffOptsRef.current, backoffRandomRef.current);
      const nextAttemptAt = Date.now() + delayMs;
      retryRef.current = { key, attempt: prevAttempt + 1, nextAttemptAt, inFlight: false };
      const giveUp = prevAttempt + 1 >= giveUpAfterRef.current;
      setErrorState({
        reason: failure.reason,
        layerStart: failure.layerStart,
        layerEnd: failure.layerEnd,
        httpStatus: failure.httpStatus,
        retrying: !giveUp,
        nextAttemptAtMs: nextAttemptAt,
        attempt: prevAttempt + 1,
      });
      setPhase(giveUp ? 'error' : 'retrying');
    },
    [],
  );

  // ── Stage-host lifecycle bridge → telemetry + backoff ─────────────────
  const handleLifecycle = useCallback(
    (event: StageHostLifecycleEvent): void => {
      if (event.type === 'load-succeeded') {
        retryRef.current = null;
        setErrorState(undefined);
        // Let the promotion effect move 'loading' → 'active' once the cap
        // reflects the loaded stage.
        setPhase((p) => (p === 'retrying' || p === 'error' ? 'loading' : p));
        emitTelemetry(telemetryRef.current, {
          name: 'host_load_succeeded',
          props: { modelId: event.modelId, layerRange: `${event.layerStart}-${event.layerEnd}` },
        });
        return;
      }
      if (event.type === 'worker-crashed') {
        // Telemetry only — the accompanying `preload-failed` (if this crash
        // happened during a load) drives the backoff, so we don't
        // double-schedule; a crash outside a load is re-attempted by the
        // next assembly tick anyway.
        emitTelemetry(telemetryRef.current, { name: 'stage_worker_crashed', props: { where: 'stage-host', reason: event.reason } });
        return;
      }
      // preload-failed
      emitTelemetry(telemetryRef.current, {
        name: 'host_load_failed',
        props: { modelId: event.modelId, layerRange: `${event.layerStart}-${event.layerEnd}`, reason: event.reason, httpStatus: event.httpStatus },
      });
      scheduleRetry(event);
    },
    [scheduleRetry],
  );

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
  // `enabled: hostingActive` (not the raw `enabled` prop) is the actual
  // fix for colocated tabs: a follower tab still mounts this hook (so its
  // own WebGPU feature-detect / support probe still runs, harmlessly),
  // but never gets its GPU worker started or its `cap.stageHost`
  // advertised — `useStageHost` already treats `enabled: false` as "stop
  // advertising, tear nothing new down" (see that hook's "Publish cap"
  // effect).
  const host: UseStageHostHandle = useStageHost({
    enabled: hostingActive,
    peer,
    baseCap: opts.baseCap,
    createStageWorker,
    // Resolve shards for a SERVED session from THIS host's own manifest — the
    // driver's `stage.session.open` carries no shardUrls, so without this a
    // served stage loads zero shards and `legion_stage_open` fails. Same
    // resolver + manifest the proactive-preload path uses.
    resolveSessionShards: async ({ layerStart, layerEnd, totalLayers: total }) => {
      const { plan, manifestCache } = await resolveCommunalShardPlan(
        { layerStart, layerEnd, includeOutput: layerEnd === total },
        {
          manifestUrl,
          fallbackShardUrls,
          opfsQuotaBytes: opfsQuotaBytesRef.current,
          manifestCache: manifestCacheRef.current,
          includeEmbeddings: layerStart === 0,
        },
      );
      manifestCacheRef.current = manifestCache;
      return plan.shardUrls;
    },
    keepaliveEnabled: opts.keepaliveEnabled,
    desiredMaxSessions: opts.desiredMaxSessions,
    priorityScore,
    standingLedger: opts.standingLedger,
    preloadStage,
    suppressAdvertise,
    forceDisconnect,
    onLifecycle: handleLifecycle,
    failureDomainId,
    contributionBudgetBytes: opts.contributionBudgetBytes,
    extraLoadedStages: opts.extraLoadedStages,
    log: opts.log,
  });
  const hostSessionCount = host.sessions.length;
  const hostSessionCountRef = useRef(hostSessionCount);
  hostSessionCountRef.current = hostSessionCount;

  // ── Progress clears a stale retry/error ───────────────────────────────
  // A slow-but-ADVANCING download is not a failure. A single fetch reject on
  // a throttled network fails the whole load attempt → `scheduleRetry` sets
  // the "Failed to fetch — retrying" error, and until now that error only
  // cleared on `load-succeeded` (the WHOLE stage completing) — so it
  // persisted, and its attempt counter escalated toward the give-up 'error'
  // label, even as shards kept landing on the next attempt. Whenever the
  // loaded stage reports FRESH forward progress (bytes/shards increased),
  // clear that stale error and reset the backoff escalation, so the UI shows
  // real progress and never gives up while it's genuinely making headway. A
  // true stall (no progress for `stallMs`) is still caught by the load
  // watchdog — this reacts only to actual progress.
  const lastLoadProgressRef = useRef<{ bytes: number; shards: number }>({ bytes: 0, shards: 0 });
  useEffect(() => {
    const p = host.loadProgress;
    if (!p) {
      // Between attempts the progress clears — reset the baseline so the
      // next attempt's first shard counts as progress even if it re-fetches
      // from a lower byte count than a prior aborted attempt reached.
      lastLoadProgressRef.current = { bytes: 0, shards: 0 };
      return;
    }
    const prev = lastLoadProgressRef.current;
    const advanced = p.bytesFetched > prev.bytes || p.shardsFetched > prev.shards;
    lastLoadProgressRef.current = { bytes: p.bytesFetched, shards: p.shardsFetched };
    if (!advanced) return;
    // Keep the claim's retry bookkeeping (key/inFlight) but zero its attempt
    // count: a failure AFTER progress restarts backoff from 0 instead of
    // escalating, and the give-up label never trips while headway is made.
    if (retryRef.current) retryRef.current = { ...retryRef.current, attempt: 0 };
    setErrorState((e) => (e === undefined ? e : undefined));
    setPhase((ph) => (ph === 'retrying' || ph === 'error' ? 'loading' : ph));
  }, [host.loadProgress]);

  // ── Assembly loop ─────────────────────────────────────────────────────
  // Runs ONLY on the elected leader tab (`hostingActive`) — a follower
  // never computes a claim, never preloads, never advertises. See
  // colocation.ts's module doc for why: N same-origin tabs must collapse
  // to exactly one hosting attempt, not one per tab.
  useEffect(() => {
    if (!hostingActive || !peer || !supportState.ok || !limits) return;
    // Captured into a local `const` so the nested `tick` closure retains
    // the non-null narrowing (TS doesn't extend narrowing of an outer
    // `useState` value across a nested function declaration boundary).
    const safeLimits = limits;
    const safePeer = peer;

    // WEIGHT budget (layer-claim sizing) — decoupled from wasmHeapBudget
    // (KV/session sizing, computed separately below via
    // `hostStabilityScore`'s own `sanitizeWasmHeapBudget` call, untouched
    // by `contributionBudgetBytes`). See `sanitizeWeightBudget`'s doc
    // comment for the full root-cause writeup.
    const weightBudgetBytes = sanitizeWeightBudget(
      { ...safeLimits, contributionBudgetBytes: opts.contributionBudgetBytes },
      { minBytes: avgLayerBytes },
    );
    const byteDerivedCapacityLayers = Math.max(0, Math.floor(weightBudgetBytes / avgLayerBytes));
    // "Layers to host: N of 34" REPLACES the byte-derived count once set —
    // see `maxLayersOverride`'s doc comment for why this isn't intersected
    // with `byteDerivedCapacityLayers` instead.
    const selfCapacityLayers =
      opts.maxLayersOverride !== undefined
        ? Math.max(0, Math.floor(opts.maxLayersOverride))
        : byteDerivedCapacityLayers;
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
          firstLayer: supportThinDrivers ? 0 : driverLayers,
          selfCapacityLayers,
          selfCurrentClaim: claimRef.current ?? null,
          selfStabilityScore: hostStabilityScore({
            maxStorageBufferBytes: safeLimits.maxStorageBufferBindingSize,
            wasmHeapBudget: sanitizeWasmHeapBudget(safeLimits.maxStorageBufferBindingSize),
            stability: { keepalive: !!opts.keepaliveEnabled, visible: typeof document === 'undefined' || document.visibilityState === 'visible', uptimeMs: 0 },
          }),
          selfFailureDomainId: failureDomainId,
          priorityScore: priorityScoreRef.current,
        });
        // Log the decision ONLY when it actually changed — the assembly
        // loop re-runs every roster heartbeat and a stable mesh re-decides
        // identically ("sole coverer — keeping as-is") every time; logging
        // that every tick is the observed console storm. Idempotent-quiet.
        const decisionKey = `${decision.reason}|${claimKey(decision.claim)}|${decision.yieldCurrent ? 'yield' : 'keep'}`;
        if (decisionKey !== lastDecisionKeyRef.current) {
          log(`[communal-host] claim decision: ${decision.reason} (jitterMs=${decision.jitterMs})`);
          lastDecisionKeyRef.current = decisionKey;
        }

        if (decision.yieldCurrent) {
          if (phaseRef.current !== 'draining') {
            log('[communal-host] yielding wasteful duplicate — stop advertising, draining');
            setSuppressAdvertise(true);
            setPhase('draining');
            drainStartedAtRef.current = Date.now();
          }
          const drained = hostSessionCountRef.current === 0;
          const graceElapsed = Date.now() - (drainStartedAtRef.current ?? Date.now()) > DEFAULT_GRACE_MS;
          // NOTE: deliberately an if/else-if, not `drained || graceElapsed`
          // combined into one branch — firing `setForceDisconnect(...)` AND
          // `setForceDisconnect(null)` in the SAME synchronous tick would
          // let the later call silently cancel the former (React batches
          // same-tick state updates; only the last write survives) and the
          // forced disconnect would never actually reach `useStageHost`.
          // Requesting a forced disconnect and releasing the claim must be
          // temporally separate: request it once grace expires, then wait
          // for a LATER tick (once `hostSessionCount` actually reflects the
          // resulting `freeSession` calls) to observe `drained` and release.
          if (drained) {
            log(`[communal-host] drain complete — releasing claim`);
            setClaim(undefined);
            setPreloadStage(null);
            setSuppressAdvertise(false);
            setForceDisconnect(null);
            drainStartedAtRef.current = undefined;
            setPhase('idle');
          } else if (graceElapsed) {
            // M3 follow-up (the previously-documented "no forced
            // termination after grace" gap): the drain window expired and
            // sessions are STILL attached — natural drain isn't going to
            // finish on its own (a long-running or stuck decode loop on
            // the driver side), so force them closed now rather than
            // leaving the lane pinned forever. Safe/bounded: every freed
            // session notifies its driver via `stage.stop`, which
            // `runCommunalDriverSession`/`runDriverStageSession` both
            // already treat as "host requested stop" -> instant replan.
            // Idempotent to repeat every tick until `hostSessionCount`
            // catches up and `drained` goes true above (`useStageHost`'s
            // `forceDisconnectAll` no-ops on an already-empty session map).
            log(`[communal-host] drain grace (${DEFAULT_GRACE_MS}ms) expired with ${hostSessionCountRef.current} session(s) still attached — forcing disconnect`);
            setForceDisconnect({ reason: 'communal teardown: drain grace expired', nonce: Date.now() });
          }
          return;
        }

        if (!decision.claim) {
          pendingClaimRef.current = null; // nothing to claim — drop any armed jitter
          if (phaseRef.current !== 'idle') setPhase('idle');
          return;
        }

        // Range-only key (see scheduleRetry) for matching a scheduled retry.
        const rangeKey = `${decision.claim.layerStart}:${decision.claim.layerEnd}`;
        const changed = !claimsEqual(claimRef.current, decision.claim);

        if (!changed) {
          // Same claim we already hold — the jitter window is behind us.
          pendingClaimRef.current = null;
          // If a load for it FAILED, honor the backoff window: re-issue the
          // preload ONLY once the scheduled retry time arrives (never every
          // tick), and never while a retry load is already in flight.
          // Otherwise stay quiet — the idempotent no-op that replaces the
          // old tight retry loop.
          const retry = retryRef.current;
          if (retry && retry.key === rangeKey && !retry.inFlight && Date.now() >= retry.nextAttemptAt) {
            retry.inFlight = true;
            log(`[communal-host] retry attempt ${retry.attempt} for [${decision.claim.layerStart},${decision.claim.layerEnd})`);
            await issuePreload(decision.claim);
          }
          return;
        }

        // A genuinely NEW claim — clear any prior failure/backoff, then stage
        // it behind the anti-thundering-herd jitter using a REMOUNT-PROOF
        // wall-clock deadline (see `pendingClaimRef`) instead of a
        // `setCancellable(await sleep)` that a background-tab throttle +
        // remount would silently discard, livelocking the host at 0%.
        retryRef.current = null;
        setErrorState(undefined);

        let armed = pendingClaimRef.current;
        if (!armed || !claimsEqual(armed.claim, decision.claim)) {
          // First sighting of this claim: arm the deadline. A quiet (no
          // re-render) tab won't re-tick before the ~5s interval, so nudge a
          // commit-tick just past the deadline; a busy tab's remounts
          // re-drive the check for free. `jitterMs === 0` makes the deadline
          // `now`, so it falls straight through to commit on this tick.
          armed = { claim: decision.claim, notBeforeMs: Date.now() + decision.jitterMs };
          pendingClaimRef.current = armed;
          if (decision.jitterMs > 0) {
            if (jitterTimer) clearTimeout(jitterTimer);
            jitterTimer = setTimeout(() => void tick(), decision.jitterMs + 20);
            return;
          }
        }
        if (Date.now() < armed.notBeforeMs) return; // deadline not reached yet

        // Deadline reached — re-check the roster (it may have moved: another
        // peer beat us to this gap, or the gap closed) and commit fresh.
        pendingClaimRef.current = null;
        const recheck = communalHostClaim({
          roster: rosterRef.current.filter((r) => r.peerId !== safePeer.selfId),
          selfPeerId: safePeer.selfId,
          modelId,
          totalLayers,
          driverLayers,
          firstLayer: supportThinDrivers ? 0 : driverLayers,
          selfCapacityLayers,
          selfCurrentClaim: claimRef.current ?? null,
          selfFailureDomainId: failureDomainId,
          priorityScore: priorityScoreRef.current,
        });
        if (!recheck.claim || cancelled) return;

        setClaim(recheck.claim);
        await issuePreload(recheck.claim);
      } finally {
        tickInFlightRef.current = false;
      }
    }

    /** Resolve the shard plan for `target` and hand it to `useStageHost`
     * via a fresh `preloadStage` identity (which triggers a load attempt).
     * A shard-plan RESOLUTION failure (e.g. a 404 manifest fetch) is caught
     * here and scheduled for backoff; a WORKER-LOAD failure comes back
     * asynchronously via `handleLifecycle('preload-failed')`. Either way the
     * failing claim backs off instead of hammering. */
    async function issuePreload(target: CommunalClaimRange): Promise<void> {
      setPhase('loading');
      try {
        const { plan, manifestCache } = await resolveCommunalShardPlan(target, {
          manifestUrl,
          fallbackShardUrls,
          opfsQuotaBytes: opfsQuotaBytesRef.current,
          manifestCache: manifestCacheRef.current,
        });
        manifestCacheRef.current = manifestCache;
        if (cancelled) return;
        setPreloadStage({
          modelId,
          layerStart: target.layerStart,
          layerEnd: target.layerEnd,
          totalLayers,
          ctxSize,
          wireDtype,
          shardUrls: plan.shardUrls,
          shardHashes: plan.shardHashes,
          shardBytes: plan.shardBytes,
          shardRoles: plan.shardRoles,
          useMemoryShardStore: plan.useMemoryShardStore,
          localFolderHandle: localFolderHandleRef.current,
        });
        setSuppressAdvertise(false);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setLastError(message);
        log(`[communal-host] failed to resolve shard plan for [${target.layerStart},${target.layerEnd}): ${message}`);
        emitTelemetry(telemetryRef.current, {
          name: 'host_load_failed',
          props: { modelId, layerRange: `${target.layerStart}-${target.layerEnd}`, reason: message, httpStatus: extractHttpStatus(message) },
        });
        scheduleRetry({ modelId, layerStart: target.layerStart, layerEnd: target.layerEnd, reason: message, httpStatus: extractHttpStatus(message) });
      }
    }

    void tick();
    const timer = setInterval(() => void tick(), reassemblyIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (jitterTimer) clearTimeout(jitterTimer);
    };
    // `phase`/`hostSessionCount` are deliberately NOT deps — they're read
    // fresh via `phaseRef`/`hostSessionCountRef` inside the tick. Including
    // them would restart this effect (and immediately re-tick) on every
    // phase/session change, and — critically — a `setPhase('loading')` from
    // within `issuePreload` would tear the effect down mid-`await`,
    // cancelling the retry it was issuing. The interval alone drives the
    // cadence; the loop only decides intent (useStageHost owns resources).
    // `hostingActive` (not `isLeader` alone) is the dep — a demotion
    // (leadership lost) must tear this loop down exactly like `enabled`
    // going false always has, so a freshly-demoted tab stops ticking
    // immediately rather than continuing to compute claims it'll never
    // act on usefully.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostingActive, peer, supportState.ok, limits, modelId, totalLayers, driverLayers, supportThinDrivers, avgLayerBytes, manifestUrl, fallbackShardUrls, ctxSize, wireDtype, reassemblyIntervalMs, opts.contributionBudgetBytes, opts.maxLayersOverride]);

  useEffect(() => {
    if (!hostingActive) {
      setClaim(undefined);
      setPreloadStage(null);
      setSuppressAdvertise(false);
      setForceDisconnect(null);
      setPhase('idle');
      setErrorState(undefined);
      retryRef.current = null;
      lastDecisionKeyRef.current = '';
    }
  }, [hostingActive]);

  useEffect(() => {
    if (phase === 'loading' && host.active && host.stageHostCap?.loadedStages?.length) setPhase('active');
  }, [phase, host.active, host.stageHostCap]);

  // Derive the DISPLAYED error message on every render so its retry
  // countdown ticks down live (App re-renders on a short cadence) instead
  // of freezing at schedule time.
  const errorMessage = errorState
    ? describeHostError({
        reason: errorState.reason,
        layerStart: errorState.layerStart,
        layerEnd: errorState.layerEnd,
        httpStatus: errorState.httpStatus,
        retrying: errorState.retrying,
        nextAttemptInSec: retryCountdownSec(errorState.nextAttemptAtMs, Date.now()),
      })
    : undefined;

  // ── Leader -> followers status relay ──────────────────────────────────
  // Publishes on every render where something a follower cares about
  // changed. `coordinatorRef.current?.publishStatus` itself no-ops when
  // called by a non-leader (see colocation.ts), so this stays correct
  // even for the render(s) right after a demotion.
  useEffect(() => {
    if (!hostingActive) return;
    coordinatorRef.current?.publishStatus({
      phase,
      claim,
      active: host.active && phase === 'active',
      sessionCount: host.sessions.length,
      tokensDecoded: host.tokensDecoded,
      maxSessions: host.maxSessions,
      queueLength: host.queueLength,
      errorMessage,
      retrying: !!errorState?.retrying,
      retryAttempt: errorState?.attempt ?? 0,
      downloadProgress: host.loadProgress,
      ts: Date.now(),
    });
  }, [
    hostingActive,
    phase,
    claim,
    host.active,
    host.sessions.length,
    host.tokensDecoded,
    host.maxSessions,
    host.queueLength,
    errorMessage,
    errorState,
    host.loadProgress,
  ]);

  // ── Follower view — mirror the leader's relayed status instead of this
  // tab's own (intentionally idle) local state. `bumpSharedStatusTick`
  // (subscribed above) forces this to re-render whenever a fresh status
  // arrives even though `coordinatorRef.current` itself isn't state. ────
  if (!isLeader && colocationEnabled) {
    const shared = coordinatorRef.current?.latestStatus();
    return {
      supported: supportState.ok,
      unsupportedReason: supportState.reason,
      phase: (shared?.phase as CommunalHostPhase | undefined) ?? 'idle',
      claim: shared?.claim,
      active: shared?.active ?? false,
      sessions: [], // per-session driver detail isn't relayed — see SharedHostStatus's doc comment
      tokensDecoded: shared?.tokensDecoded ?? 0,
      maxSessions: shared?.maxSessions ?? 0,
      queueLength: shared?.queueLength ?? 0,
      lastError: shared?.errorMessage,
      errorMessage: shared?.errorMessage,
      retrying: shared?.retrying ?? false,
      nextRetryAtMs: undefined,
      retryAttempt: shared?.retryAttempt ?? 0,
      downloadProgress: shared?.downloadProgress,
    };
  }

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
    errorMessage,
    retrying: !!errorState?.retrying,
    nextRetryAtMs: errorState?.nextAttemptAtMs,
    retryAttempt: errorState?.attempt ?? 0,
    downloadProgress: host.loadProgress,
  };
}
