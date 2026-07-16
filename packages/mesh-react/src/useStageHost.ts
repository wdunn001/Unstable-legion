/**
 * useStageHost — makes THIS peer answer pipeline-split stage-hosting
 * requests (Phase C), and — as of M2 — serve MULTIPLE concurrent driver
 * sessions over the ONE stage it loads.
 *
 *   1. Advertise `cap.stageHost` (WebGPU-limit-derived capacity +
 *      stability signals + M2's session-capacity fields) so
 *      `stagePlanner.ts` can consider this peer.
 *   2. Answer the stage-control protocol (`stageControl.ts` over the
 *      `tc` action) and the activation data-plane (`sf` action) for as
 *      many concurrent sessions as it committed to at load time.
 *
 * ── M2: from one session to a session MAP ───────────────────────────
 *
 * Pre-M2 this hook held scalar `workerClient`/`decoder`/`sessionId`/
 * `driverPeerId` state — a second `stage.load` tore down the first
 * unconditionally. M1 (legion-stage-runtime) proved a stage's underlying
 * skippy model can serve N independent KV sessions
 * (`StageHandle.createSession()`) once `legion_stage_open` is told the
 * lane ceiling up front (`StageDescriptor.maxSessions`) — a host commits
 * its session capacity when it LOADS the stage, not elastically
 * per-request (see legion-stage-runtime/docs/MULTI-SESSION.md).
 *
 * This hook now holds ONE `StageWorkerClient` per LOADED stage (weights
 * fetched once) and a `Map<sessionId, HostSession>` of independent
 * generation sessions against it. Two ways a session gets opened:
 *
 *   - `stage.load` (legacy, kept for backward compat — this is what
 *     `stageOrchestrator.ts`'s driver still sends): the host builds this
 *     session's activation-wire decoder from the OLD "first `sf` frame
 *     after open is the header" convention, now scoped PER-SESSION
 *     instead of globally (that convention was fine for exactly one
 *     concurrent session; per-session it stays fine for any number).
 *     Replies with `stage.ready` (unchanged wire shape).
 *   - `stage.session.open` (new, M2): carries the wire header up front
 *     (base64), so the host builds the decoder AT ACCEPT TIME — no
 *     "first frame is special" ambiguity at all, which matters once
 *     several sessions' `sf` traffic can interleave on one host. Replies
 *     with `stage.session.accept` (or `stage.session.busy` if the host
 *     is at its committed ceiling — queued, bounded + TTL'd, see
 *     `stageSessionAdmission.ts`).
 *
 * Every inbound `sf` frame is first unwrapped through
 * `decodeStageFrameEnvelope` (mesh-core) to learn which session it's
 * for, THEN dispatched to that session's own `awaitingHeader`/`decoder`
 * state and routed to `workerClient.prefill/decode(..., sessionId)` —
 * see `stageWorkerProtocol.ts`'s M2 doc comment for why `sessionId`
 * absent still means "the legacy fused single-session path", which this
 * hook never uses directly except for the one-time warm-up dispatch
 * (every real session, legacy or new, is a `createSession()` lane).
 *
 * `driverMaxSessions` (the number of CONCURRENT DRIVER sessions this
 * host commits to) is NOT the same number passed to
 * `StageDescriptor.maxSessions` (the native lane ceiling): skippy's
 * `legion_stage_open` always creates one additional FUSED session
 * internally (used only by this hook's one-time warm-up dispatch) that
 * permanently occupies a lane — so the native lane count is
 * `driverMaxSessions + 1`. Getting this off-by-one wrong silently steals
 * one driver's worth of concurrency (see legion-stage-runtime's
 * MULTI-SESSION.md: "1 fused + 2 wanted = 3").
 *
 * Scope: only the FINAL-stage host role is implemented — same scope note
 * as pre-M2 (`stageOrchestrator.ts`'s SCOPE NOTE; N>2-stage relay is out
 * of scope). A `stage.load`/`stage.session.open` for a non-final range
 * still loads and serves sessions correctly.
 */
import { useEffect, useRef, useState } from 'react';
import {
  decodeStageControl,
  decodeStageFrameEnvelope,
  encodeStageControl,
  isStageControlFrame,
  makeStagePong,
  makeStageProgress,
  makeStageReady,
  makeStageSessionAccept,
  makeStageSessionBusy,
  makeStageStop,
  makeStageToken,
  type MeshPeerCap,
  type Peer,
  type StageControlMessageFor,
  type StandingLedger,
} from '@unstable-legion/core';
import { createActivationWireDecoder, type ActivationWireDecoder } from '@unstable-legion/stage-runtime';
import { StageWorkerClient, warmUpStageWorker, type StageWorkerLog } from './stageWorkerClient.js';
import type { WireActivationFrame } from './stageWorkerProtocol.js';
import { buildStageHostCap, chooseMaxSessions, type StageHostLimits } from './stagePipelinePlanning.js';
import { detectWebGpuLimits } from './webgpuLimits.js';
import { extractHttpStatus, type StageHostLifecycleEvent } from './meshResilience.js';
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

export interface UseStageHostOptions {
  /** Operator toggle — "Host stages". Publishing + answering both gate on this. */
  enabled: boolean;
  peer: Peer | null;
  /** Everything this peer's cap needs EXCEPT `stageHost` — the SAME
   * object shape `MeshProviderProps.cap` accepts (`ts` optional; `Peer.
   * setCap` re-stamps it unconditionally, so omitting it here is fine).
   * Read via a ref internally so the publish loop always uses the latest
   * value without needing it as an effect dependency (avoids
   * re-subscribing the answer loop on every persona edit). */
  baseCap: Omit<MeshPeerCap, 'stageHost' | 'ts'> & { ts?: number };
  /** Factory for a fresh stage-hosting DedicatedWorker — host app owns
   * the actual worker script (Vite needs a static `new URL(...)` call
   * site, which can't live in a shared library). Must be stable
   * (useCallback) or this hook will restart its answer loop every render. */
  createStageWorker: () => Worker;
  /** Mirrors `useAudioKeepalive().enabled` — feeds `stability.keepalive`. */
  keepaliveEnabled?: boolean;
  /** Fragment ids already resident in this peer's cache (future OPFS
   * work) — omitted today (this demo always cold-loads). */
  cachedFragments?: readonly string[];
  /** Send `stage.progress` every N decoded tokens (per session). Default 8. */
  progressEveryN?: number;
  /** Re-publish `cap.stageHost` (refreshing uptimeMs/stability) this
   * often. Default 15_000ms. */
  republishMs?: number;
  /**
   * M2 — number of CONCURRENT DRIVER sessions this host commits to
   * serving when it loads a stage (clamped to [1, 8], default 4 — see
   * `chooseMaxSessions`). Chosen ONCE per load, not elastic; a session
   * request beyond this ceiling is queued (bounded, TTL'd) or answered
   * `stage.session.busy` / `stage.stop`.
   */
  desiredMaxSessions?: number;
  /** M2 — scores a waiting driver peer for queue ordering when a lane
   * frees (highest first, FIFO among ties). Defaults to pure FIFO
   * (`() => 0`); a future milestone wires real prioritization. */
  priorityScore?: PriorityScoreFn;
  /** How often (ms) to sweep for idle sessions to evict. Default 30_000. */
  idleSweepMs?: number;
  /** Idle threshold (ms, no inbound `sf` frame) before a session is
   * evicted. Default 5 minutes. */
  idleEvictMs?: number;
  /**
   * M3 — proactively load this stage BEFORE any driver ever sends
   * `stage.load`/`stage.session.open`, so it's already warm by the time
   * `useCommunalHost.ts`'s assembly loop advertises it. Reuses the SAME
   * `ensureWorkerLoaded` reuse/reload/conflict semantics every other open
   * path goes through: a matching config while idle is a no-op; a
   * DIFFERENT config while sessions are still active THROWS (caught,
   * logged, left for the next call once sessions drain) rather than
   * disrupting a live session — this is what gives `useCommunalHost.ts`
   * "never reconfigure out from under an active driver" for free. Pass a
   * NEW object identity only when the target actually changes (a fresh
   * identity every render would spam `ensureWorkerLoaded` pointlessly —
   * harmless since it's idempotent, but wasteful). `null`/undefined =
   * no proactive preload (pure legacy/session-open-triggered loading,
   * the pre-M3 default).
   */
  preloadStage?: {
    modelId: string;
    layerStart: number;
    layerEnd: number;
    totalLayers: number;
    ctxSize: number;
    wireDtype: 'f32' | 'f16';
    shardUrls: readonly string[];
    shardHashes?: readonly string[];
    shardBytes?: readonly number[];
    useMemoryShardStore?: boolean;
  } | null;
  /**
   * M3 — publish `stageHost` WITHOUT `loadedStages` while true, even
   * though a stage may still be loaded and actively serving sessions.
   * `useCommunalHost.ts`'s teardown sequence sets this the INSTANT a
   * claim needs to change ("stop advertising" — CHAOS.md/plan-doc
   * ordering: stop advertising -> drain -> grace -> dispose) so no NEW
   * driver picks this host for a range it's about to stop serving, while
   * existing sessions already in flight keep running undisturbed.
   */
  suppressAdvertise?: boolean;
  /**
   * M4 — this host's own contribution-economy ledger. When supplied,
   * every session free (`freeSession`, regardless of WHY — natural
   * finish, abort, idle-evict, forced disconnect) feeds
   * `standingLedger.recordConsumption({consumerPeerId: driverPeerId, ...},
   * now)` for the driver that occupied the lane — the "host directly
   * witnesses a driver's resource consumption" half of the economy (see
   * `docs/ECONOMY.md`). Deliberately NOT gated on completion (matches
   * `recordConsumption`'s own contract — a peer that aborted mid-stream
   * still occupied the lane for however long it lasted). Omit to skip
   * telemetry entirely.
   */
  standingLedger?: StandingLedger;
  /**
   * Additive cap field (see `@unstable-legion/core`'s `types.ts` doc
   * comment) — "this peer, on this browser profile, on this machine".
   * Passed straight through to `buildStageHostCap`. Cheap defense-in-depth
   * for the mesh-side distinct-domain accounting; the primary fix for
   * co-located tabs is the leader/follower split in `useCommunalHost.ts`
   * (only one tab per origin ever calls this hook with `enabled: true`).
   */
  failureDomainId?: string;
  /**
   * M3 follow-up (the documented "forced session termination after
   * teardown grace" gap) — pass a NEW object identity (e.g. `{ reason,
   * nonce: Date.now() }`) to immediately free EVERY session currently
   * occupying a lane on this host, notifying each driver via `stage.stop`.
   * Same "new identity only when you actually want the action to fire"
   * discipline as `preloadStage` — a stable identity is a no-op after the
   * first fire (bridged via a ref-watched effect, never added to the
   * "answer" effect's own dependency array, for the exact reason
   * `DEBUG-CASEFILE.md` documents for `log`/`preloadStage`). `null`/
   * undefined = never force-disconnect (the pre-this-milestone default:
   * teardown only ever waited out natural drain).
   */
  forceDisconnect?: { reason: string; nonce: number } | null;
  /**
   * Resilience/observability bridge — called on the stage-load lifecycle
   * points `useCommunalHost.ts` needs to drive its backoff state machine
   * and telemetry: a proactive `preloadStage` load FAILED (so the host
   * loop can back off instead of re-issuing the same doomed load every
   * roster tick), a load SUCCEEDED (reset the backoff), or the worker
   * itself CRASHED. Read via a ref internally (never a dependency of the
   * "answer" effect — same `logRef` discipline) so passing a fresh inline
   * callback each render never tears down live sessions.
   */
  onLifecycle?: (event: StageHostLifecycleEvent) => void;
  log?: StageWorkerLog;
}

export interface UseStageHostSession {
  sessionId: string;
  driverPeerId: string;
  layerStart: number;
  layerEnd: number;
  totalLayers: number;
  isFirst: boolean;
  isFinal: boolean;
  decodedCount: number;
  createdAt: number;
  lastFrameAt: number;
}

export interface UseStageHostHandle {
  /** WebGPU present + adapter acquired. */
  supported: boolean;
  unsupportedReason?: string;
  /** enabled && supported && cap published. */
  active: boolean;
  stageHostCap?: NonNullable<MeshPeerCap['stageHost']>;
  /** Every session currently occupying a lane on this host. */
  sessions: readonly UseStageHostSession[];
  /** Sum of `decodedCount` across `sessions` — cheap aggregate for a
   * single "tokens decoded" badge; per-session detail is in `sessions`. */
  tokensDecoded: number;
  /** The lane ceiling committed at load time (see `desiredMaxSessions`). */
  maxSessions: number;
  /** Requests currently waiting for a lane to free. */
  queueLength: number;
  lastError?: string;
  /** The most recent PROACTIVE-preload failure (a `preloadStage` load that
   * couldn't fetch/load its shards), structured for the host loop's
   * backoff + the UI's error card. Distinct from `lastError` (which also
   * catches per-session frame errors). Undefined once a load succeeds. */
  preloadError?: { modelId: string; layerStart: number; layerEnd: number; reason: string; httpStatus?: number };
}

const DEFAULT_REPUBLISH_MS = 15_000;
const DEFAULT_PROGRESS_EVERY_N = 8;
const DEFAULT_IDLE_SWEEP_MS = 30_000;

// ── base64 <-> bytes (browser main-thread; Buffer fallback for Node test hosts) ──

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

// ── Internal request shape: unifies legacy `stage.load` and new
//    `stage.session.open` into one admission/open pipeline. ──────────────

interface PendingOpen {
  origin: 'legacy' | 'session';
  sessionId: string;
  peerId: string;
  callId: string;
  modelId: string;
  layerStart: number;
  layerEnd: number;
  totalLayers: number;
  ctxSize: number;
  wireDtype: 'f32' | 'f16';
  shardUrls: readonly string[];
  /** M3 preload only (manifest-based artifact-slice fetch) — see
   * `stage-runtime`'s `StageDescriptor.shardHashes`/`shardBytes`.
   * Absent for legacy/session-origin opens (Phase A/B full.gguf demo
   * convention has no per-fragment hashes to source these from). */
  shardHashes?: readonly string[];
  shardBytes?: readonly number[];
  /** M3 preload only — see stageWorkerProtocol.ts's doc comment. */
  useMemoryShardStore?: boolean;
  /** Present only for `origin === 'session'` — lets the host build the
   * decoder at accept time instead of via the legacy first-frame convention. */
  wireHeaderB64?: string;
}

interface HostSessionState {
  sessionId: string;
  driverPeerId: string;
  origin: 'legacy' | 'session';
  decoder?: ActivationWireDecoder;
  /** Legacy-origin sessions start `true` (first `sf` frame is the wire
   * header); session-origin sessions start `false` (header arrived in
   * the open payload, decoder built immediately). */
  awaitingHeader: boolean;
  decodedCount: number;
  createdAt: number;
  lastFrameAt: number;
  isFirst: boolean;
  isFinal: boolean;
  layerStart: number;
  layerEnd: number;
  totalLayers: number;
}

interface LoadedConfig {
  modelId: string;
  layerStart: number;
  layerEnd: number;
  totalLayers: number;
  ctxSize: number;
  wireDtype: 'f32' | 'f16';
}

function sameConfig(a: LoadedConfig, b: LoadedConfig): boolean {
  return (
    a.modelId === b.modelId &&
    a.layerStart === b.layerStart &&
    a.layerEnd === b.layerEnd &&
    a.totalLayers === b.totalLayers &&
    a.ctxSize === b.ctxSize &&
    a.wireDtype === b.wireDtype
  );
}

export function useStageHost(opts: UseStageHostOptions): UseStageHostHandle {
  const {
    enabled,
    peer,
    createStageWorker,
    keepaliveEnabled,
    cachedFragments,
    progressEveryN = DEFAULT_PROGRESS_EVERY_N,
    republishMs = DEFAULT_REPUBLISH_MS,
    idleSweepMs = DEFAULT_IDLE_SWEEP_MS,
    idleEvictMs = DEFAULT_IDLE_EVICT_MS,
    log = () => undefined,
  } = opts;

  const driverMaxSessions = chooseMaxSessions(opts.desiredMaxSessions);

  const baseCapRef = useRef(opts.baseCap);
  baseCapRef.current = opts.baseCap;
  const mountedAtRef = useRef(Date.now());
  // See DEBUG-CASEFILE.md (apps/demo/e2e) — an inline `log` prop churns
  // identity on every parent re-render (roster re-caps fire one every
  // ~republishMs/heartbeatMs); listing `log` in the "answer" effect's
  // deps used to tear the effect down mid-load and silently
  // `.terminate()` the worker with no ErrorEvent. Captured via a ref so
  // the effect's own identity never depends on the CALLER's callback
  // identity — do not regress this by adding `log` back to that effect's
  // dependency array.
  const logRef = useRef(log);
  logRef.current = log;
  // Same ref discipline as `logRef` — the lifecycle bridge must never be a
  // dependency of the "answer" effect (a fresh inline callback each render
  // would tear down live sessions/worker on every parent re-render).
  const onLifecycleRef = useRef<UseStageHostOptions['onLifecycle']>(opts.onLifecycle);
  onLifecycleRef.current = opts.onLifecycle;
  const priorityScoreRef = useRef<PriorityScoreFn>(opts.priorityScore ?? (() => 0));
  priorityScoreRef.current = opts.priorityScore ?? (() => 0);
  // M4 — read fresh inside `freeSession` without making the "answer"
  // effect depend on the ledger's identity (same ref-read idiom as
  // `priorityScoreRef`/`baseCapRef`).
  const standingLedgerRef = useRef<StandingLedger | undefined>(opts.standingLedger);
  standingLedgerRef.current = opts.standingLedger;

  const [supportState, setSupportState] = useState<{ ok: boolean; reason?: string }>({ ok: true });
  const [limits, setLimits] = useState<StageHostLimits | null>(null);
  const [visible, setVisible] = useState<boolean>(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );
  const [onBattery, setOnBattery] = useState<boolean | undefined>(undefined);
  const [stageHostCap, setStageHostCap] = useState<NonNullable<MeshPeerCap['stageHost']> | undefined>(undefined);
  const [sessions, setSessions] = useState<readonly UseStageHostSession[]>([]);
  const [queueLength, setQueueLength] = useState(0);
  const [lastError, setLastError] = useState<string | undefined>(undefined);
  const [preloadError, setPreloadError] = useState<UseStageHostHandle['preloadError']>(undefined);

  // Read by the "publish cap" effect so every heartbeat reflects the
  // CURRENT session occupancy without that effect needing to depend on
  // the "answer" effect's internal state.
  const sessionCapacityRef = useRef<{ maxSessions: number; activeSessions: number }>({
    maxSessions: driverMaxSessions,
    activeSessions: 0,
  });
  // M3: `cap.stageHost.loadedStages` — the fact `communalTopology.ts`
  // unions across the roster. Read by the "publish cap" effect the same
  // way `sessionCapacityRef` is; empty when nothing is loaded.
  const loadedStagesRef = useRef<NonNullable<MeshPeerCap['stageHost']>['loadedStages']>([]);
  // M3: lets the "answer" effect (which owns `hostSessions`/`workerClient`)
  // trigger an IMMEDIATE republish from the separate "publish cap" effect
  // (which owns the actual `peer.setCap` call + its interval timer)
  // whenever `activeSessions` changes, instead of waiting up to
  // `republishMs` for the next heartbeat tick — a driver deciding whether
  // a host has a free lane right now shouldn't see stale occupancy.
  const republishNowRef = useRef<() => void>(() => undefined);
  // M3 — read fresh on every publish tick without needing the publish
  // effect to restart (same ref-read idiom as `baseCapRef`).
  const suppressAdvertiseRef = useRef(opts.suppressAdvertise ?? false);
  suppressAdvertiseRef.current = opts.suppressAdvertise ?? false;
  // M3 — bridge from the "preload watcher" effect (below) into the
  // "answer" effect's `applyPreload`, same ref-bridge pattern as
  // `republishNowRef` (two independent effects, one triggers the other
  // without becoming a dependency of it).
  const preloadRequestRef = useRef<(req: NonNullable<UseStageHostOptions['preloadStage']>) => void>(() => undefined);
  // M3 follow-up — bridge from the "force-disconnect watcher" effect
  // (below) into the "answer" effect's `forceDisconnectAll`, same
  // ref-bridge pattern as `preloadRequestRef`/`republishNowRef`.
  const forceDisconnectRequestRef = useRef<(reason: string) => void>(() => undefined);

  // ── Feature-detect once ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void detectWebGpuLimits().then((result) => {
      if (cancelled) return;
      setSupportState({ ok: result.ok, reason: result.reason });
      if (result.ok && result.limits) setLimits(result.limits);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Visibility signal ────────────────────────────────────────────────
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVis = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // ── Battery signal (best-effort; not all browsers implement it) ─────
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const getBattery = (
      navigator as unknown as {
        getBattery?: () => Promise<{ charging: boolean; addEventListener: (ev: string, cb: () => void) => void }>;
      }
    ).getBattery;
    if (typeof getBattery !== 'function') return;
    let cancelled = false;
    getBattery
      .call(navigator)
      .then((battery) => {
        if (cancelled) return;
        const update = () => setOnBattery(!battery.charging);
        update();
        battery.addEventListener('chargingchange', update);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Publish cap.stageHost while enabled ─────────────────────────────
  useEffect(() => {
    if (!peer) return;
    if (!enabled || !limits || !supportState.ok) {
      if (!enabled) {
        setStageHostCap(undefined);
        peer.setCap({ ...baseCapRef.current, ts: Date.now() });
      }
      return;
    }
    const publish = (): void => {
      const cap = buildStageHostCap(
        limits,
        {
          keepalive: !!keepaliveEnabled,
          visible,
          onBattery,
          uptimeMs: Date.now() - mountedAtRef.current,
        },
        cachedFragments,
        sessionCapacityRef.current,
        suppressAdvertiseRef.current ? [] : loadedStagesRef.current,
        opts.failureDomainId,
      );
      setStageHostCap(cap);
      peer.setCap({ ...baseCapRef.current, ts: Date.now(), stageHost: cap });
    };
    republishNowRef.current = publish;
    publish();
    const timer = setInterval(publish, republishMs);
    return () => {
      clearInterval(timer);
      republishNowRef.current = () => undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peer, enabled, limits, supportState.ok, visible, onBattery, keepaliveEnabled, republishMs, opts.failureDomainId]);

  // ── Answer stage-control + activation frames while enabled ──────────
  useEffect(() => {
    if (!peer || !enabled) return;
    const meshPeer: Peer = peer;
    const log = (line: string) => logRef.current(line);

    let workerClient: StageWorkerClient | undefined;
    let loadedConfig: LoadedConfig | undefined;
    // Guards against two near-simultaneous session-open requests each
    // starting their OWN `.load()` call: two concurrent driver tabs can
    // both send `stage.load`/`stage.session.open` before either has
    // finished loading (a real scenario this hook must handle — that's
    // the whole point of M2). Without this, the second request would see
    // `workerClient === undefined` too and race a second full model
    // fetch, each overwriting `workerClient` when it resolves. Every
    // caller of `ensureWorkerLoaded` while a load is in flight awaits
    // THIS SAME promise instead of starting its own.
    let loadInFlight: Promise<void> | undefined;
    const hostSessions = new Map<string, HostSessionState>();
    let queue: readonly QueueEntry<PendingOpen>[] = [];
    // M3: bumped every successful (re)load — see MeshLoadedStage.epoch's
    // doc comment in types.ts (lets a consumer tell "this is a fresh load
    // of the same range" apart from stale cap data during a fast reload).
    let loadEpoch = 0;

    function syncPublicState(): void {
      setSessions(
        Array.from(hostSessions.values()).map((s) => ({
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
        })),
      );
      setQueueLength(queue.length);
      sessionCapacityRef.current = { maxSessions: driverMaxSessions, activeSessions: hostSessions.size };
      loadedStagesRef.current =
        workerClient && loadedConfig
          ? [
              {
                modelId: loadedConfig.modelId,
                layerStart: loadedConfig.layerStart,
                layerEnd: loadedConfig.layerEnd,
                includeEmbeddings: workerClient.isFirst,
                includeOutput: workerClient.isFinal,
                ctxSize: loadedConfig.ctxSize,
                wireDtype: loadedConfig.wireDtype,
                maxSessions: driverMaxSessions,
                activeSessions: hostSessions.size,
                epoch: loadEpoch,
              },
            ]
          : [];
      // M3: an immediate republish (not waiting for the next `republishMs`
      // heartbeat) whenever occupancy/load state changes — a driver
      // deciding "does this host have a free lane right now" needs
      // current data, not up-to-15s-stale data.
      republishNowRef.current();
    }

    async function disposeWorker(): Promise<void> {
      const w = workerClient;
      workerClient = undefined;
      loadedConfig = undefined;
      if (w) await w.dispose().catch(() => undefined);
    }

    /** Ensure a worker is loaded and matches `req`'s stage config. Reuses
     * the existing worker (just adds a session) when the config matches;
     * reloads when idle and the config differs; throws when busy with a
     * genuinely different config (a real conflict, not just capacity). */
    async function ensureWorkerLoaded(req: PendingOpen): Promise<void> {
      const want: LoadedConfig = {
        modelId: req.modelId,
        layerStart: req.layerStart,
        layerEnd: req.layerEnd,
        totalLayers: req.totalLayers,
        ctxSize: req.ctxSize,
        wireDtype: req.wireDtype,
      };
      if (workerClient && loadedConfig && sameConfig(loadedConfig, want)) return;

      if (loadInFlight) {
        // Someone else is already loading (the common concurrent-open
        // race) — wait for THAT load, then re-check instead of starting
        // a second one.
        await loadInFlight.catch(() => undefined);
        if (workerClient && loadedConfig && sameConfig(loadedConfig, want)) return;
      }

      if (workerClient && hostSessions.size > 0) {
        throw new Error(
          `host is already serving ${hostSessions.size} session(s) on a different stage configuration`,
        );
      }

      const doLoad = (async (): Promise<void> => {
        await disposeWorker();
        log(`[stage-host] loading stage layers=[${req.layerStart},${req.layerEnd}) maxSessions=${driverMaxSessions + 1} (driver=${driverMaxSessions}+1 fused)`);
        const client = new StageWorkerClient(
          createStageWorker(),
          `stage-host-${req.layerStart}-${req.layerEnd}`,
          log,
          (message) => onLifecycleRef.current?.({ type: 'worker-crashed', reason: message }),
        );
        const loadDeadlineMs = 240_000;
        await Promise.race([
          client.load(
            {
              modelId: req.modelId,
              layerStart: req.layerStart,
              layerEnd: req.layerEnd,
              totalLayers: req.totalLayers,
              shardUrls: req.shardUrls,
              shardHashes: req.shardHashes,
              shardBytes: req.shardBytes,
              ctxSize: req.ctxSize,
              // +1: legion_stage_open always creates one FUSED session
              // internally (used here only for the warm-up dispatch below) —
              // see this file's top doc comment and MULTI-SESSION.md.
              maxSessions: driverMaxSessions + 1,
            },
            { useMemoryShardStore: req.useMemoryShardStore },
          ),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`stage worker load exceeded ${loadDeadlineMs}ms (worker died silently or stalled)`)),
              loadDeadlineMs,
            ),
          ),
        ]);
        log('[stage-host] warming up WebGPU shader pipelines before accepting sessions…');
        await warmUpStageWorker(client, log);
        workerClient = client;
        loadedConfig = want;
        loadEpoch += 1;
      })();
      loadInFlight = doLoad;
      try {
        await doLoad;
      } finally {
        if (loadInFlight === doLoad) loadInFlight = undefined;
      }
    }

    /**
     * M3 — proactive preload (`opts.preloadStage`). Reuses
     * `ensureWorkerLoaded` verbatim (same reuse/reload/conflict rules as
     * every wire-triggered open) but never creates a session or replies
     * to a peer — there IS no peer, this is self-directed. Errors are
     * swallowed into `lastError`/a log line rather than thrown: the
     * caller (`useCommunalHost.ts`) polls `sessions`/`stageHostCap` state
     * and retries on its own cadence, so a transient failure here (e.g.
     * "still serving sessions on a different config" while draining)
     * isn't exceptional — it's the expected shape of "try again once
     * idle."
     */
    async function applyPreload(req: NonNullable<UseStageHostOptions['preloadStage']>): Promise<void> {
      const pending: PendingOpen = {
        origin: 'legacy',
        sessionId: '__preload__',
        peerId: '__preload__',
        callId: '__preload__',
        modelId: req.modelId,
        layerStart: req.layerStart,
        layerEnd: req.layerEnd,
        totalLayers: req.totalLayers,
        ctxSize: req.ctxSize,
        wireDtype: req.wireDtype,
        shardUrls: req.shardUrls,
        shardHashes: req.shardHashes,
        shardBytes: req.shardBytes,
        useMemoryShardStore: req.useMemoryShardStore,
      };
      try {
        await ensureWorkerLoaded(pending);
        syncPublicState();
        setPreloadError(undefined);
        onLifecycleRef.current?.({ type: 'load-succeeded', modelId: req.modelId, layerStart: req.layerStart, layerEnd: req.layerEnd });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const httpStatus = extractHttpStatus(message);
        setLastError(message);
        setPreloadError({ modelId: req.modelId, layerStart: req.layerStart, layerEnd: req.layerEnd, reason: message, httpStatus });
        log(`[stage-host] preload FAILED layers=[${req.layerStart},${req.layerEnd}): ${message}`);
        onLifecycleRef.current?.({ type: 'preload-failed', modelId: req.modelId, layerStart: req.layerStart, layerEnd: req.layerEnd, reason: message, httpStatus });
      }
    }
    preloadRequestRef.current = applyPreload;

    async function failOpen(req: PendingOpen, message: string): Promise<void> {
      setLastError(message);
      log(`[stage-host] open FAILED sessionId=${req.sessionId} origin=${req.origin}: ${message}`);
      await meshPeer.sendTool(encodeStageControl(makeStageStop(req.sessionId, message)), req.peerId).catch(() => undefined);
    }

    async function openNow(req: PendingOpen): Promise<void> {
      try {
        await ensureWorkerLoaded(req);
        const client = workerClient!;
        await client.sessionCreate(req.sessionId);
        let decoder: ActivationWireDecoder | undefined;
        let awaitingHeader = true;
        if (req.wireHeaderB64) {
          decoder = createActivationWireDecoder(base64ToBytes(req.wireHeaderB64));
          awaitingHeader = false;
        }
        const state: HostSessionState = {
          sessionId: req.sessionId,
          driverPeerId: req.peerId,
          origin: req.origin,
          decoder,
          awaitingHeader,
          decodedCount: 0,
          createdAt: Date.now(),
          lastFrameAt: Date.now(),
          isFirst: client.isFirst,
          isFinal: client.isFinal,
          layerStart: req.layerStart,
          layerEnd: req.layerEnd,
          totalLayers: req.totalLayers,
        };
        hostSessions.set(req.sessionId, state);
        syncPublicState();
        if (req.origin === 'legacy') {
          await meshPeer.sendTool(
            encodeStageControl(makeStageReady(req.sessionId, { isFirst: state.isFirst, isFinal: state.isFinal, nEmbd: client.nEmbd }, req.callId)),
            req.peerId,
          );
        } else {
          await meshPeer.sendTool(
            encodeStageControl(
              makeStageSessionAccept(
                req.sessionId,
                { nEmbd: client.nEmbd, isFirst: state.isFirst, isFinal: state.isFinal, activeSessions: hostSessions.size, maxSessions: driverMaxSessions },
                req.callId,
              ),
            ),
            req.peerId,
          );
        }
        log(`[stage-host] session OPEN sessionId=${req.sessionId} peer=${req.peerId} origin=${req.origin} active=${hostSessions.size}/${driverMaxSessions}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await failOpen(req, message);
      }
    }

    /** Try to admit as many queued requests as fit, highest-priority
     * first. Called after every session free. */
    async function admitNextQueued(): Promise<void> {
      for (;;) {
        if (!canAdmitNow(hostSessions.size, driverMaxSessions)) return;
        const { queue: rest, next } = popNextByPriority(queue, priorityScoreRef.current);
        queue = rest;
        syncPublicState();
        if (!next) return;
        await openNow(next.request);
      }
    }

    async function admitOrEnqueue(req: PendingOpen): Promise<void> {
      // Expire stale queue entries before deciding — a request that's
      // been waiting past the TTL is treated as abandoned, not admitted
      // stale (the driver almost certainly timed out and moved on).
      const now = Date.now();
      const { queue: alive, expired } = expireQueue(queue, now, DEFAULT_QUEUE_TTL_MS);
      queue = alive;
      for (const e of expired) {
        log(`[stage-host] queued session-open for ${e.sessionId} expired (TTL ${DEFAULT_QUEUE_TTL_MS}ms) — dropping`);
        await failOpen(e.request, `queued session-open request expired after ${DEFAULT_QUEUE_TTL_MS}ms`);
      }

      if (canAdmitNow(hostSessions.size, driverMaxSessions)) {
        await openNow(req);
        return;
      }

      if (req.origin === 'legacy') {
        // The legacy `stage.load` driver (stageOrchestrator.ts) has no
        // busy/retry/queue concept — fail fast rather than leave it
        // hanging on a reply that will never come in the shape it expects.
        await failOpen(req, `host at max session capacity (${driverMaxSessions})`);
        return;
      }

      const { queue: q2, accepted, queuePosition } = enqueue(
        queue,
        { sessionId: req.sessionId, peerId: req.peerId, enqueuedAt: now, request: req },
        DEFAULT_QUEUE_CAP,
      );
      queue = q2;
      syncPublicState();
      if (accepted) {
        log(`[stage-host] session-open QUEUED sessionId=${req.sessionId} position=${queuePosition}`);
        await meshPeer.sendTool(encodeStageControl(makeStageSessionBusy(req.sessionId, { queuePosition }, req.callId)), req.peerId);
      } else {
        log(`[stage-host] session-open REJECTED (queue full) sessionId=${req.sessionId}`);
        await meshPeer.sendTool(encodeStageControl(makeStageSessionBusy(req.sessionId, {}, req.callId)), req.peerId).catch(() => undefined);
      }
    }

    async function freeSession(sessionId: string, reason: string, notifyDriver: boolean): Promise<void> {
      const state = hostSessions.get(sessionId);
      if (!state) return;
      hostSessions.delete(sessionId);
      syncPublicState();
      await workerClient?.sessionFree(sessionId).catch(() => undefined);
      log(`[stage-host] session FREED sessionId=${sessionId} reason=${reason} active=${hostSessions.size}/${driverMaxSessions}`);
      // M4 — the host directly witnessed this driver occupying a lane for
      // [createdAt, now), regardless of why the session ended (natural
      // finish, abort, idle-evict, forced disconnect) — recordConsumption
      // is deliberately NOT gated on completion (see standing.ts's doc
      // comment: resource use is debited, not a reward withheld).
      const ledger = standingLedgerRef.current;
      if (ledger) {
        const now = Date.now();
        ledger.recordConsumption(
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
        await meshPeer.sendTool(encodeStageControl(makeStageStop(sessionId, reason)), state.driverPeerId).catch(() => undefined);
      }
      await admitNextQueued();
    }

    /**
     * M3 follow-up — genuinely FORCE every currently-attached session
     * closed (not just stop advertising / wait for natural drain). Used by
     * `useCommunalHost.ts` once its 30s teardown grace expires with
     * sessions still attached — the previously-documented gap ("no
     * imperative to terminate lingering sessions after grace"). Reuses
     * `freeSession` verbatim (same worker-lane release + telemetry +
     * driver notification), just applied to every session at once instead
     * of one at a time in response to a wire event.
     */
    async function forceDisconnectAll(reason: string): Promise<void> {
      const ids = [...hostSessions.keys()];
      if (ids.length === 0) return;
      log(`[stage-host] force-disconnecting ${ids.length} session(s): ${reason}`);
      for (const sessionId of ids) {
        await freeSession(sessionId, reason, true);
      }
    }
    forceDisconnectRequestRef.current = forceDisconnectAll;

    async function handleLegacyLoad(msg: StageControlMessageFor<'stage.load'>, peerId: string): Promise<void> {
      log(`[stage-host] stage.load from ${peerId} sessionId=${msg.sessionId} layers=[${msg.payload.layerStart},${msg.payload.layerEnd})`);
      const shardUrls = msg.payload.shardUrls ?? (msg.payload.manifestUrl ? [msg.payload.manifestUrl] : []);
      await admitOrEnqueue({
        origin: 'legacy',
        sessionId: msg.sessionId,
        peerId,
        callId: msg.callId,
        modelId: msg.payload.modelId,
        layerStart: msg.payload.layerStart,
        layerEnd: msg.payload.layerEnd,
        totalLayers: msg.payload.totalLayers,
        ctxSize: msg.payload.ctxSize,
        wireDtype: msg.payload.wireDtype,
        shardUrls,
      });
    }

    async function handleSessionOpen(msg: StageControlMessageFor<'stage.session.open'>, peerId: string): Promise<void> {
      log(`[stage-host] stage.session.open from ${peerId} sessionId=${msg.sessionId} layers=[${msg.payload.layerStart},${msg.payload.layerEnd})`);
      await admitOrEnqueue({
        origin: 'session',
        sessionId: msg.sessionId,
        peerId,
        callId: msg.callId,
        modelId: msg.payload.modelId,
        layerStart: msg.payload.layerStart,
        layerEnd: msg.payload.layerEnd,
        totalLayers: msg.payload.totalLayers,
        ctxSize: msg.payload.ctxSize,
        wireDtype: msg.payload.wireDtype,
        shardUrls: [],
        wireHeaderB64: msg.payload.wireHeader,
      });
    }

    async function handlePing(msg: StageControlMessageFor<'stage.ping'>, peerId: string): Promise<void> {
      await meshPeer.sendTool(encodeStageControl(makeStagePong(msg.sessionId, msg.payload.sentAtMs, msg.callId)), peerId);
    }

    async function handleStop(msg: StageControlMessageFor<'stage.stop'>, peerId: string): Promise<void> {
      const state = hostSessions.get(msg.sessionId);
      if (!state || state.driverPeerId !== peerId) return; // unknown session or spoof attempt — ignore
      log(`[stage-host] stage.stop from ${peerId} sessionId=${msg.sessionId}: ${msg.payload.reason}`);
      await freeSession(msg.sessionId, msg.payload.reason, false);
    }

    const unsubTool = peer.onTool((frame, peerId) => {
      if (!isStageControlFrame(frame)) return;
      const decoded = decodeStageControl(frame);
      if (!decoded) return;
      if (decoded.kind === 'stage.load') void handleLegacyLoad(decoded, peerId);
      else if (decoded.kind === 'stage.session.open') void handleSessionOpen(decoded, peerId);
      else if (decoded.kind === 'stage.ping') void handlePing(decoded, peerId);
      else if (decoded.kind === 'stage.stop') void handleStop(decoded, peerId);
    });

    const unsubFrame = peer.onStageFrame((raw, peerId) => {
      const envelope = decodeStageFrameEnvelope(raw);
      if (!envelope) {
        log(`[stage-host] onStageFrame DROPPED — malformed envelope from ${peerId} (${raw.byteLength} bytes)`);
        return;
      }
      const { sessionId, payload: bytes } = envelope;
      const state = hostSessions.get(sessionId);
      if (!state) {
        log(`[stage-host] onStageFrame DROPPED — unknown sessionId=${sessionId} from ${peerId}`);
        return;
      }
      // Spoof guard: only the peer that opened this session may drive it.
      if (peerId !== state.driverPeerId) {
        log(`[stage-host] onStageFrame DROPPED — peerId=${peerId} does not own sessionId=${sessionId} (owner=${state.driverPeerId})`);
        return;
      }
      state.lastFrameAt = Date.now();
      void (async () => {
        try {
          const client = workerClient;
          if (!client) return;
          if (state.awaitingHeader) {
            state.decoder = createActivationWireDecoder(bytes);
            state.awaitingHeader = false;
            log(`[stage-host] wire header sessionId=${sessionId}: modelId=${state.decoder.modelId} nEmbd=${state.decoder.nEmbd} dtype=${state.decoder.dtype}`);
            return;
          }
          if (!state.decoder) return;
          const frame = state.decoder.decodeFrameBytes(bytes);
          const wireFrame: WireActivationFrame = {
            dtype: 'f32',
            layout: 'token-major',
            tokenCount: frame.tokenCount,
            payload: frame.activations.buffer.slice(
              frame.activations.byteOffset,
              frame.activations.byteOffset + frame.activations.byteLength,
            ) as ArrayBuffer,
          };
          const tokens = frame.tokens ?? [];
          const positions = tokens.map((_, i) => (frame.posStart ?? 0) + i);
          const isPrefill = frame.seq === 0;
          const result = isPrefill
            ? await client.prefill(tokens as number[], positions, wireFrame, sessionId)
            : await client.decode((tokens[0] as number) ?? 0, wireFrame, sessionId);
          if (result.predictedToken === undefined) {
            throw new Error('final-stage host produced no predictedToken');
          }
          state.decodedCount += 1;
          syncPublicState();
          const isEog = await client.tokenIsEog(result.predictedToken);
          await meshPeer.sendTool(
            encodeStageControl(makeStageToken(sessionId, result.predictedToken, frame.seq, isEog, isEog ? 'eos' : undefined)),
            peerId,
          );
          if (state.decodedCount % progressEveryN === 0) {
            await meshPeer.sendTool(encodeStageControl(makeStageProgress(sessionId, state.decodedCount, frame.seq)), peerId);
          }
          if (isEog) {
            // Generation finished — free the lane proactively instead of
            // waiting for idle-eviction or an explicit stage.stop.
            await freeSession(sessionId, 'generation finished (eos)', false);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setLastError(message);
          log(`[stage-host] frame handling FAILED sessionId=${sessionId}: ${message}`);
          await freeSession(sessionId, `host error: ${message}`, true);
        }
      })();
    });

    // Idle-eviction sweep — a session whose driver vanished without a
    // graceful stage.stop or pagehide (network partition, tab kill)
    // otherwise pins a lane forever.
    const idleTimer = setInterval(() => {
      const now = Date.now();
      for (const sessionId of [...hostSessions.keys()]) {
        const state = hostSessions.get(sessionId);
        if (state && isSessionIdle(state.lastFrameAt, now, idleEvictMs)) {
          void freeSession(sessionId, 'idle-evicted', true);
        }
      }
    }, idleSweepMs);

    // Roster-leave: free any session whose driver peer left the mesh —
    // the primary cleanup path (faster than waiting out the idle sweep).
    const unsubRoster = meshPeer.roster.subscribe((snapshot) => {
      const present = new Set(snapshot.map((e) => e.peerId));
      for (const [sessionId, state] of hostSessions) {
        if (!present.has(state.driverPeerId)) {
          void freeSession(sessionId, 'driver left the mesh', false);
        }
      }
    });

    // Graceful-leave: tell every active driver we're going away instead
    // of just vanishing (CHAOS.md's graceful-leave path).
    const onPageHide = (): void => {
      for (const state of hostSessions.values()) {
        void meshPeer.sendTool(encodeStageControl(makeStageStop(state.sessionId, 'peer pagehide')), state.driverPeerId).catch(() => undefined);
      }
    };
    if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);

    return () => {
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
      clearInterval(idleTimer);
      unsubRoster();
      unsubTool();
      unsubFrame();
      preloadRequestRef.current = () => undefined;
      forceDisconnectRequestRef.current = () => undefined;
      void disposeWorker();
    };
    // `log` deliberately excluded — see logRef above; this effect must not
    // tear down (and silently terminate in-flight worker/session state)
    // just because the caller's log callback identity changed on an
    // unrelated re-render. `driverMaxSessions`/`idleSweepMs`/`idleEvictMs`
    // are read once per mount via the outer closure, matching
    // `progressEveryN`'s existing precedent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peer, enabled, createStageWorker, progressEveryN, driverMaxSessions, idleSweepMs, idleEvictMs]);

  // ── M3: preload watcher — bridges `opts.preloadStage` changes into the
  // "answer" effect's `applyPreload` via `preloadRequestRef`, WITHOUT
  // making the answer effect itself depend on `preloadStage` (which would
  // tear down live sessions on every claim change — exactly what this
  // hook must never do). Caller must pass a stable object identity for
  // `preloadStage` (new identity only when the target actually changes,
  // same discipline `createStageWorker` already requires) — this effect
  // re-fires whenever that identity changes. ──────────────────────────
  useEffect(() => {
    if (!enabled) return;
    const req = opts.preloadStage;
    if (!req) return;
    void preloadRequestRef.current(req);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, opts.preloadStage]);

  // ── M3 follow-up: force-disconnect watcher — bridges
  // `opts.forceDisconnect` changes into the "answer" effect's
  // `forceDisconnectAll` via `forceDisconnectRequestRef`, WITHOUT making
  // the answer effect itself depend on it (same bridge shape as the
  // preload watcher above). Caller passes a NEW object identity only when
  // it actually wants a forced disconnect to fire. ──────────────────────
  useEffect(() => {
    if (!enabled) return;
    const req = opts.forceDisconnect;
    if (!req) return;
    void forceDisconnectRequestRef.current(req.reason);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, opts.forceDisconnect]);

  const tokensDecoded = sessions.reduce((sum, s) => sum + s.decodedCount, 0);

  return {
    supported: supportState.ok,
    unsupportedReason: supportState.reason,
    active: enabled && supportState.ok && !!stageHostCap,
    stageHostCap,
    sessions,
    tokensDecoded,
    maxSessions: driverMaxSessions,
    queueLength,
    lastError,
    preloadError,
  };
}
