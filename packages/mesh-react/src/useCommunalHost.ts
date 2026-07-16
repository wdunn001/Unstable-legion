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
  type MeshPeerCap,
  type MeshRosterEntry,
  type Peer,
  type StandingLedger,
} from '@unstable-legion/core';
import {
  fragmentsForRange,
  manifestTiesEmbeddings,
  parseLayerPackageManifest,
  type FragmentChunk,
  type LayerPackageManifest,
} from '@unstable-legion/stage-runtime';
import { useMeshRoster } from './useMeshRoster.js';
import { useStageHost, type UseStageHostSession, type UseStageHostHandle } from './useStageHost.js';
import { sanitizeWasmHeapBudget, WASM_HEAP_CEILING_BYTES, type StageHostLimits } from './stagePipelinePlanning.js';
import { detectWebGpuLimits } from './webgpuLimits.js';
import type { StageWorkerLog } from './stageWorkerClient.js';
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
  /** Second manifest URL tried ONLY if `manifestUrl` fails to fetch (throws
   * or a non-OK response) — the CDN-primary/origin-fallback design (see
   * `chatModelSource.ts`'s module doc). Every fragment `fragmentsForRange`
   * resolves is anchored against WHICHEVER of the two URLs actually served
   * the manifest, not unconditionally against `manifestUrl` — a manifest
   * fetched from the fallback origin resolves its artifact `path`s (and
   * any `chunks[]`) against that same origin. Ignored when `manifestUrl`
   * is absent. */
  manifestFallbackUrl?: string;
  fallbackShardUrls?: () => readonly string[];
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
}

const DEFAULT_REASSEMBLY_MS = 5000;
const DEFAULT_GRACE_MS = 30_000;
const DEFAULT_GIVE_UP_LABEL_AFTER = 4;

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
  /** Parallel to shardUrls/shardHashes/shardBytes — see
   * `stage-runtime`'s `StageDescriptor.shardChunks` (this is where a
   * CDN-chunked artifact's `Fragment.chunks` survives the flattening into
   * these parallel arrays; without it a chunked shard would be requested
   * whole at shardUrls[i], which the CDN doesn't serve). Undefined
   * entries are shards that aren't chunked. */
  shardChunks?: readonly (readonly FragmentChunk[] | undefined)[];
  useMemoryShardStore: boolean;
}

/**
 * `fragmentsForRange`'s `manifestBaseUrl` contract requires a FULLY
 * QUALIFIED absolute URL — the WHATWG `URL` constructor rejects a
 * page-relative base (e.g. `/webllm/stages/m/model-package.json`) even
 * when the thing being resolved against it is itself already absolute
 * (`new URL(x, base)` eagerly parses `base` first, unconditionally). A
 * same-origin manifest path like the `.198` mirror's is exactly such a
 * relative base, so it's resolved against `location.origin` here before
 * ever being used as one. Outside a browser (SSR/tests, no `location`)
 * it's returned unchanged — callers there are expected to supply an
 * already-absolute URL, same convention `resolveChatModelConfig` uses.
 */
function toAbsoluteManifestUrl(url: string): string {
  if (typeof location === 'undefined') return url;
  try {
    return new URL(url, location.origin).toString();
  } catch {
    return url;
  }
}

/**
 * Fetch+parse a layer-package manifest from `primaryUrl`, falling back to
 * `fallbackUrl` (when supplied) on ANY failure — a thrown fetch, a non-OK
 * response, or a body that fails manifest validation. Returns the URL that
 * actually served the manifest alongside it (resolved absolute — see
 * `toAbsoluteManifestUrl`), so the caller resolves every fragment
 * (`fragmentsForRange`'s `manifestBaseUrl`) against WHICHEVER origin
 * actually served it, not unconditionally against `primaryUrl` — a
 * manifest served by the fallback origin must resolve its artifact
 * `path`s (and any `chunks[]`) relative to that same origin, since a CDN
 * path wouldn't exist there.
 */
async function fetchLayerPackageManifest(
  primaryUrl: string,
  fallbackUrl: string | undefined,
  fetchImpl: typeof fetch,
): Promise<{ url: string; manifest: LayerPackageManifest }> {
  const candidates = fallbackUrl ? [primaryUrl, fallbackUrl] : [primaryUrl];
  let lastError: unknown;
  for (const url of candidates) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`failed to fetch communal manifest ${url}: ${res.status} ${res.statusText}`);
      const manifest = parseLayerPackageManifest(await res.json());
      return { url: toAbsoluteManifestUrl(url), manifest };
    } catch (err) {
      lastError = err;
      // Try the next candidate (typically the .198 origin fallback) — see
      // chatModelSource.ts's CDN-primary-then-origin-fallback design.
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`failed to fetch communal manifest from any of: ${candidates.join(', ')}`);
}

/**
 * Resolve what a stage covering `claim` should fetch. Manifest-based
 * (Phase C artifact slicing via `fragmentsForRange`) when `manifestUrl`
 * is supplied; falls back to `fallbackShardUrls()` (Phase A/B full.gguf,
 * this demo's actually-deployed convention for the small e2e model)
 * otherwise. A communal host never sets `isFirst` for `fragmentsForRange`
 * purposes — the driver always owns embeddings locally (`driverLayers`),
 * a communal claim never starts before that boundary.
 *
 * `manifestFallbackUrl` (typically the `.198` origin mirror) is tried ONLY
 * if `manifestUrl` (typically the CDN) fails to fetch — see
 * `fetchLayerPackageManifest`.
 */
export async function resolveCommunalShardPlan(
  claim: CommunalClaimRange,
  opts: {
    manifestUrl?: string;
    manifestFallbackUrl?: string;
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
  // Compared against `cache.url`, which `fetchLayerPackageManifest` always
  // resolves to an absolute URL — resolve these the same way so a cached
  // manifest fetched via a page-relative candidate is still recognized as
  // a hit (see `toAbsoluteManifestUrl`).
  const candidateUrls = [toAbsoluteManifestUrl(opts.manifestUrl), ...(opts.manifestFallbackUrl ? [toAbsoluteManifestUrl(opts.manifestFallbackUrl)] : [])];
  if (!cache || !candidateUrls.includes(cache.url)) {
    cache = await fetchLayerPackageManifest(opts.manifestUrl, opts.manifestFallbackUrl, fetchImpl);
  }
  const manifest = cache.manifest;
  // Resolve against `cache.url` — whichever of the two candidates actually
  // served the manifest — never unconditionally against `opts.manifestUrl`.
  const fragments = fragmentsForRange(manifest, cache.url, claim.layerStart, claim.layerEnd, false, claim.includeOutput);
  const totalBytes = fragments.reduce((sum, f) => sum + f.bytes, 0);
  const useMemoryShardStore = totalBytes > opts.opfsQuotaBytes;
  const shardChunks = fragments.map((f) => f.chunks);
  const anyChunked = shardChunks.some((c) => c && c.length > 0);
  return {
    plan: {
      shardUrls: fragments.map((f) => f.url),
      shardHashes: fragments.map((f) => f.sha256),
      shardBytes: fragments.map((f) => f.bytes),
      // Only set when at least one fragment is actually chunked — keeps
      // the non-chunked (today's .198-only) case identical to before this
      // field existed rather than always carrying an all-undefined array.
      ...(anyChunked ? { shardChunks } : {}),
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
    manifestFallbackUrl,
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
  const priorityScoreRef = useRef<PriorityScoreFn>(priorityScore ?? (() => 0));
  priorityScoreRef.current = priorityScore ?? (() => 0);

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
  const host: UseStageHostHandle = useStageHost({
    enabled,
    peer,
    baseCap: opts.baseCap,
    createStageWorker,
    keepaliveEnabled: opts.keepaliveEnabled,
    desiredMaxSessions: opts.desiredMaxSessions,
    priorityScore,
    standingLedger: opts.standingLedger,
    preloadStage,
    suppressAdvertise,
    forceDisconnect,
    onLifecycle: handleLifecycle,
    log: opts.log,
  });
  const hostSessionCount = host.sessions.length;
  const hostSessionCountRef = useRef(hostSessionCount);
  hostSessionCountRef.current = hostSessionCount;

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
          if (phaseRef.current !== 'idle') setPhase('idle');
          return;
        }

        // Range-only key (see scheduleRetry) for matching a scheduled retry.
        const rangeKey = `${decision.claim.layerStart}:${decision.claim.layerEnd}`;
        const changed = !claimsEqual(claimRef.current, decision.claim);

        if (!changed) {
          // Same claim we already hold. If a load for it FAILED, honor the
          // backoff window: re-issue the preload ONLY once the scheduled
          // retry time arrives (never every tick), and never while a retry
          // load is already in flight. Otherwise stay quiet — this is the
          // idempotent no-op that replaces the old tight retry loop.
          const retry = retryRef.current;
          if (retry && retry.key === rangeKey && !retry.inFlight && Date.now() >= retry.nextAttemptAt) {
            retry.inFlight = true;
            log(`[communal-host] retry attempt ${retry.attempt} for [${decision.claim.layerStart},${decision.claim.layerEnd})`);
            await issuePreload(decision.claim);
          }
          return;
        }

        // A genuinely NEW claim — clear any prior failure/backoff, jitter,
        // re-check the roster, then issue the load fresh (attempt 0).
        retryRef.current = null;
        setErrorState(undefined);

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
          manifestFallbackUrl,
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
          shardChunks: plan.shardChunks,
          useMemoryShardStore: plan.useMemoryShardStore,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, peer, supportState.ok, limits, modelId, totalLayers, driverLayers, avgLayerBytes, manifestUrl, manifestFallbackUrl, fallbackShardUrls, ctxSize, wireDtype, reassemblyIntervalMs]);

  useEffect(() => {
    if (!enabled) {
      setClaim(undefined);
      setPreloadStage(null);
      setSuppressAdvertise(false);
      setForceDisconnect(null);
      setPhase('idle');
      setErrorState(undefined);
      retryRef.current = null;
      lastDecisionKeyRef.current = '';
    }
  }, [enabled]);

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
  };
}
