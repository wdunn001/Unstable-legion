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
 * RELAY: both host roles are implemented. A FINAL stage samples and returns
 * `stage.token` to its `driverPeerId`. A NON-final stage (driver-assigned
 * `isFinal:false` in the open, with a `nextPeerId`) instead RE-ENCODES its
 * boundary activation and `sendStageFrame`s it downstream — see the
 * `!state.isFinal` branch in `onStageFrame`. It accepts inbound frames from
 * `prevPeerId` (the driver for stage 1, the previous relay for a hop ≥2), and
 * a hop ≥2 opened without a `wireHeader` takes its upstream's header inline
 * (the `awaitingHeader` path). Teardown propagates both directions.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  decodeStageControl,
  decodeStageFrameEnvelope,
  encodeStageControl,
  encodeStageFrameEnvelope,
  extractIncrementalTextDelta,
  INITIAL_TEXT_CURSOR,
  isStageControlFrame,
  makeStageLoadProgress,
  makeStagePong,
  makeStageProgress,
  makeStageReady,
  makeStageSessionAccept,
  makeStageSessionBusy,
  makeStageStop,
  makeStageToken,
  type IncrementalTextCursor,
  type MeshLoadedStage,
  type MeshPeerCap,
  type Peer,
  type StageControlMessageFor,
  type StandingLedger,
  createLegionActivationWireDecoder,
  createLegionActivationWireEncoder,
  type LegionActivationWireDecoder,
  type LegionActivationWireEncoder,
} from '@unstable-legion/core';
import { StageWorkerClient, dummyActivationFrame, warmUpStageWorker, type StageWorkerLog } from './stageWorkerClient.js';
import type { StageWorkerLoadProgress, WireActivationFrame } from './stageWorkerProtocol.js';
import { buildStageHostCap, chooseMaxSessions, unionLoadedStages, type StageHostLimits } from './stagePipelinePlanning.js';
import { detectWebGpuLimits } from './webgpuLimits.js';
import { extractHttpStatus, type StageHostLifecycleEvent } from './meshResilience.js';
import { runWithStallWatchdog, StallTimeoutError } from './loadWatchdog.js';
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
  /**
   * Resolve the shard URLs for a stage this host is asked to SERVE (a
   * `stage.session.open` the driver doesn't carry explicit `shardUrls`/
   * `manifestUrl` for). Without this, a served session loads with zero shards
   * and `legion_stage_open` fails ("paths, path_count, and out_model are
   * required"). The host resolves from its OWN manifest (it decides where to
   * fetch), same as its proactive preload path. `useCommunalHost` wires this to
   * `resolveCommunalShardPlan`. Omitted => served sessions fall back to whatever
   * `shardUrls`/`manifestUrl` the open message carried (may be empty).
   */
  resolveSessionShards?: (req: {
    modelId: string;
    layerStart: number;
    layerEnd: number;
    totalLayers: number;
  }) => Promise<readonly string[]>;
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
    wireDtype: 'f32' | 'f16' | 'i8';
    shardUrls: readonly string[];
    shardHashes?: readonly string[];
    shardBytes?: readonly number[];
    /** Per-shard manifest role — carried for the incremental loader (see
     * stage-runtime StageDescriptor.shardRoles). */
    shardRoles?: readonly ('metadata' | 'embeddings' | 'output' | 'layer')[];
    useMemoryShardStore?: boolean;
    /**
     * LOCAL-MODEL-FOLDER — a `FileSystemDirectoryHandle` this host should
     * fetch fragment BYTES from instead of the network (see
     * `localFolderFetch.ts`'s trust-model doc comment: the manifest/hashes
     * this load verifies against are still `shardHashes` above, sourced
     * from the REMOTE manifest exactly as always — the folder never
     * supplies anything but bytes). `useCommunalHost.ts` wires this from
     * its own `localFolderHandle` option. `undefined` = unchanged
     * network-fetch behavior.
     */
    localFolderHandle?: FileSystemDirectoryHandle;
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
   * REUSE-STAGE0 — additional `cap.stageHost.loadedStages` entries to
   * UNION into this hook's own publish, so a peer that ALSO serves its
   * resident `[0, driverLayers)` stage-0 via `useLocalStageServe.ts` (see
   * that module's doc comment) advertises BOTH entries in ONE
   * `peer.setCap` call instead of two independent callers racing to
   * clobber each other's cap (`Peer.setCap` fully REPLACES the previous
   * cap — see `peer.ts`). Passed straight through to `buildStageHostCap`,
   * unioned with THIS hook's own `loadedStages` (never de-duplicated
   * against it — the caller is responsible for not passing an entry that
   * overlaps this host's own claimed range). Published even while
   * `enabled` is false (hosting toggled off, or this tab isn't the
   * hosting-colocation leader) — a peer can serve stage-0 without
   * participating in `[driverLayers, totalLayers)` hosting at all, so this
   * hook's own `enabled` gate must not also silence someone else's ad.
   * Read fresh on every publish tick; pass a NEW array identity only when
   * it actually changes (a stable/memoized identity avoids unnecessarily
   * restarting the publish effect's interval every render). `undefined`/
   * empty = unchanged pre-existing behavior (including the `!enabled`
   * branch's unconditional cap-wipe).
   */
  extraLoadedStages?: readonly MeshLoadedStage[];
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
   * Operator opt-in weight budget (see `stagePipelinePlanning.ts#
   * sanitizeWeightBudget`'s doc comment) — merged onto the internally-
   * detected `StageHostLimits` before `buildStageHostCap` runs, so the
   * advertised cap's `vramBytes` reflects it (informational only here;
   * this hook doesn't itself do claim-sizing math). Absent = unchanged
   * behavior.
   */
  contributionBudgetBytes?: number;
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
  /**
   * Per-shard download progress for the stage CURRENTLY loading (or the
   * last one loaded, until a new load starts) — drives a UI progress bar
   * (see apps/chat's ContributionPanel/HostingConsentBanner) and, via
   * `runWithStallWatchdog`, this hook's own load watchdog. Undefined
   * before the first shard of the first load has reported in, and reset
   * to undefined at the start of every new load.
   */
  loadProgress?: StageWorkerLoadProgress;
}

const DEFAULT_REPUBLISH_MS = 15_000;
const DEFAULT_PROGRESS_EVERY_N = 8;
const DEFAULT_IDLE_SWEEP_MS = 30_000;
// See loadWatchdog.ts's module doc — a multi-GB model download has no
// fixed duration a flat timeout could safely encode, so the load watchdog
// resets on every shard-progress tick instead. LOAD_STALL_MS is the real
// health signal (no progress at all for this long => genuinely stuck);
// LOAD_CEILING_MS is a generous backstop, not the primary timeout.
/**
 * How long a stage stays resident in VRAM after this peer STOPS hosting
 * before the weights are freed. Deliberately long runway: `enabled` is
 * `hosting && isLeader`, so colocation leader-election can blip it for a
 * moment, and a cold reload is a multi-minute multi-GB round trip — holding
 * VRAM for a while is far cheaper than paying that back for a toggle the user
 * reverses or a leadership handoff that returns. Re-enabling inside the window
 * cancels the free entirely and the stage is reused as-is. A true unmount
 * (tab closed) frees immediately and does not wait this out.
 */
const RESIDENT_GRACE_MS = 10 * 60_000;

const LOAD_STALL_MS = 90_000;
const LOAD_CEILING_MS = 30 * 60_000;

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
  wireDtype: 'f32' | 'f16' | 'i8';
  shardUrls: readonly string[];
  /** M3 preload only (manifest-based artifact-slice fetch) — see
   * `stage-runtime`'s `StageDescriptor.shardHashes`/`shardBytes`.
   * Absent for legacy/session-origin opens (Phase A/B full.gguf demo
   * convention has no per-fragment hashes to source these from). */
  shardHashes?: readonly string[];
  shardBytes?: readonly number[];
  /** M3 preload only — per-shard manifest role for the incremental loader. */
  shardRoles?: readonly ('metadata' | 'embeddings' | 'output' | 'layer')[];
  /** M3 preload only — see stageWorkerProtocol.ts's doc comment. */
  useMemoryShardStore?: boolean;
  /** M3 preload only (`opts.preloadStage.localFolderHandle`, see that
   * option's doc comment) — a wire-triggered open (`origin: 'legacy' |
   * 'session'` from a remote driver) never carries one; a remote peer has
   * no way to hand THIS browser a `FileSystemDirectoryHandle` (it isn't
   * network-serializable), so this only ever gets set for the
   * self-directed preload path. */
  localFolderHandle?: FileSystemDirectoryHandle;
  /** Present only for `origin === 'session'` — lets the host build the
   * decoder at accept time instead of via the legacy first-frame convention.
   * Absent for a relay hop ≥2, which takes its upstream's header inline. */
  wireHeaderB64?: string;
  /** RELAY (driver-assigned). Absent ⇒ the pre-relay assumption: this host is
   * the final stage, the driver is upstream, there is no downstream. */
  isFinalOverride?: boolean;
  /** Downstream peer to forward the boundary activation to (iff not final). */
  nextPeerId?: string;
  /** Upstream peer whose `sf` frames to accept — the driver for stage 1, the
   * previous relay for a hop ≥2. Defaults to the opener (`peerId`). */
  prevPeerId?: string;
  /** This host's pipeline position (driver-assigned). Default 1 (single remote). */
  stageIndex?: number;
  /** TEXT-RELAY — see `stageControl.ts`'s `StageSessionOpenPayload.promptText`
   * doc comment. Present only for `origin === 'session'`, and only when the
   * driver requested it (a capable/token-id-thin driver never sets it). */
  promptText?: string;
  /** TEXT-RELAY — see `StageSessionOpenPayload.textOutput`'s doc comment. */
  textOutput?: boolean;
}

interface HostSessionState {
  sessionId: string;
  driverPeerId: string;
  origin: 'legacy' | 'session';
  decoder?: LegionActivationWireDecoder;
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
  /** RELAY: the peer we accept `sf` frames from (upstream). The driver for
   * stage 1, the previous relay for a hop ≥2. The spoof guard checks THIS,
   * not `driverPeerId`, so relayed frames aren't dropped. */
  prevPeerId: string;
  /** RELAY: the peer we forward our boundary activation to (downstream).
   * Undefined for the final stage, which samples and returns `stage.token`. */
  nextPeerId?: string;
  /** RELAY: the per-session encoder a NON-final host uses to re-encode its
   * boundary activation for `nextPeerId`. Built lazily on first forward
   * (needs `client.nEmbd`, known only after the worker loads). Its header is
   * sent to `nextPeerId` once, before the first activation frame. */
  forwardEncoder?: LegionActivationWireEncoder;
  forwardHeaderSent?: boolean;
  modelId: string;
  stageIndex: number;
  wireDtype: 'f32' | 'f16' | 'i8';
  /** TEXT-RELAY: real token ids this host tokenized server-side from the
   * open's `promptText` (isFirst stage only). Consumed — and cleared — by
   * the very first prefill frame (`frame.seq === 0`) for this session,
   * overriding whatever placeholder `tokens`/activation that frame itself
   * carried (a textRelay driver has no local tokenizer, so it can't
   * populate a real sideband). `undefined` for every non-textRelay session,
   * and for a textRelay session once its first prefill has consumed it. */
  pendingPromptTokens?: number[];
  /** TEXT-RELAY: when true (this host was opened with `textOutput: true` —
   * expected only on the FINAL stage), every sampled token also gets
   * incrementally detokenized and streamed back via `stage.token.text`. */
  textOutput: boolean;
  /** TEXT-RELAY: every token THIS stage has sampled for this session so far
   * (final-stage sessions with `textOutput` only) — redecoded in full on
   * each step (see `incrementalTextStream.ts`'s doc comment for why a
   * per-token-isolated decode is unsound). */
  sampledTokens?: number[];
  /** TEXT-RELAY: the incremental-streaming cursor for this session (see
   * `extractIncrementalTextDelta`). */
  textCursor?: IncrementalTextCursor;
}

interface LoadedConfig {
  modelId: string;
  layerStart: number;
  layerEnd: number;
  totalLayers: number;
  ctxSize: number;
  wireDtype: 'f32' | 'f16' | 'i8';
}

/**
 * The loaded-worker state that MUST survive a re-subscribe of the "answer"
 * effect below. It used to live as `let`s inside that effect, which meant a
 * remount (the effect's deps include `enabled` = hosting&&isLeader, and
 * leader-election churn flips it) ran the cleanup's `disposeWorker()` and
 * started a fresh empty closure — silently throwing away a stage that had
 * ALREADY finished (or was mid-)preloading its 4.4GB into VRAM. The next
 * `stage.session.open` then cold-re-downloaded from shard 1 ("it says ready,
 * then loads for 8 min when I send a prompt"), and — worse for a REMOTE
 * caller — looked like a non-responsive/failed host. Holding this in a
 * hook-lifetime ref makes the reuse guard in `ensureWorkerLoaded` survive
 * the churn, and disposal now happens only on true unmount.
 */
interface StageEngine {
  workerClient: StageWorkerClient | undefined;
  loadedConfig: LoadedConfig | undefined;
  loadInFlight: Promise<void> | undefined;
  hostSessions: Map<string, HostSessionState>;
  loadEpoch: number;
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
  // Resolve shards for a SERVED session (same ref discipline) — read fresh
  // inside the answer loop without making that effect depend on the callback's
  // identity.
  const resolveSessionShardsRef = useRef<UseStageHostOptions['resolveSessionShards']>(opts.resolveSessionShards);
  resolveSessionShardsRef.current = opts.resolveSessionShards;

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
  const [loadProgress, setLoadProgress] = useState<StageWorkerLoadProgress | undefined>(undefined);

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
  // REUSE-STAGE0 — read fresh by BOTH the "publish cap" effect (unions
  // into the published `loadedStages`, see `extraLoadedStages`'s doc
  // comment) and the "answer" effect's `handleSessionOpen` guard below
  // (ignores a request for a range this host isn't claiming rather than
  // fighting another server on the same peer for it).
  const extraLoadedStagesRef = useRef<readonly MeshLoadedStage[]>(opts.extraLoadedStages ?? []);
  extraLoadedStagesRef.current = opts.extraLoadedStages ?? [];
  // REUSE-STAGE0 — a CONTENT signature of `extraLoadedStages`. The publish
  // effect below reads the live array from `extraLoadedStagesRef` and calls
  // `setStageHostCap`, so depending on the raw `opts.extraLoadedStages`
  // (a fresh array identity every render) would re-run the effect on every
  // render → setState → render → … an infinite loop (React #185, seen live
  // the instant a served stage-0 was adopted). Key the effect on this stable
  // string instead: it republishes on a real content change (a served
  // session opening/closing, the entry appearing/disappearing) and never on
  // bare identity churn.
  const extraLoadedStagesKey = JSON.stringify(opts.extraLoadedStages ?? []);
  // REUSE-STAGE0 — the CURRENT claim (`preloadStage`, when set) read fresh
  // inside the "answer" effect's `handleSessionOpen` without that effect
  // depending on `opts.preloadStage`'s identity (same ref-read idiom as
  // every other option this hook reads without restarting the answer
  // effect on every render).
  const claimedRangeRef = useRef<UseStageHostOptions['preloadStage']>(opts.preloadStage ?? null);
  claimedRangeRef.current = opts.preloadStage ?? null;
  // M3 — bridge from the "preload watcher" effect (below) into the
  // "answer" effect's `applyPreload`, same ref-bridge pattern as
  // `republishNowRef` (two independent effects, one triggers the other
  // without becoming a dependency of it).
  const preloadRequestRef = useRef<(req: NonNullable<UseStageHostOptions['preloadStage']>) => void>(() => undefined);
  // M3 follow-up — bridge from the "force-disconnect watcher" effect
  // (below) into the "answer" effect's `forceDisconnectAll`, same
  // ref-bridge pattern as `preloadRequestRef`/`republishNowRef`.
  const forceDisconnectRequestRef = useRef<(reason: string) => void>(() => undefined);

  // The loaded worker + its sessions live HERE, at hook lifetime — NOT as
  // `let`s inside the "answer" effect — so a re-subscribe of that effect
  // (leader-election churn flipping `enabled`, or any other dep change)
  // cannot dispose a stage the host already spent minutes loading into
  // VRAM. See StageEngine's doc. Disposal is deferred to true unmount below.
  const engineRef = useRef<StageEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = { workerClient: undefined, loadedConfig: undefined, loadInFlight: undefined, hostSessions: new Map(), loadEpoch: 0 };
  }
  const disposeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Free the resident stage and stop advertising it. */
  const disposeResident = useCallback((reason: string): void => {
    const eng = engineRef.current;
    if (!eng) return;
    const w = eng.workerClient;
    eng.workerClient = undefined;
    eng.loadedConfig = undefined;
    eng.loadInFlight = undefined;
    eng.hostSessions.clear();
    // Never leave an ad up for weights we no longer hold (see disposeWorker).
    loadedStagesRef.current = [];
    sessionCapacityRef.current = { maxSessions: driverMaxSessions, activeSessions: 0 };
    republishNowRef.current();
    if (w) {
      logRef.current(`[stage-host] freeing resident stage (${reason})`);
      void w.dispose().catch(() => undefined);
    }
  }, [driverMaxSessions]);

  // True unmount (tab/route gone) — free immediately, nothing left to serve.
  useEffect(() => {
    return () => disposeResident('unmounted');
  }, [disposeResident]);

  // A SUSTAINED hosting-off frees the GPU; a transient one must not.
  //
  // Two failure modes to thread between. Disposing the instant `enabled` goes
  // false (the original behavior, via the answer effect's cleanup) throws away
  // a stage that cost minutes to load whenever leader-election merely blips —
  // and `enabled` is `hosting && isLeader`, so colocation hands it a reason to
  // blip. But never disposing (the engineRef refactor's mistake) means
  // switching hosting OFF silently keeps 4.4GB pinned in VRAM until the tab
  // closes, and a leadership handoff between two tabs has the old leader
  // holding its weights while the new one loads its own — double VRAM, on
  // exactly the hardware where that OOMs.
  //
  // So: keep it resident across a blip, free it once the peer has genuinely
  // stopped hosting. The runway is deliberately long — a cold reload is a
  // multi-minute 4.4GB round trip, so holding VRAM a while is the far cheaper
  // bet than paying that back for a toggle the user reverses.
  useEffect(() => {
    if (enabled) {
      // Hosting (re)enabled inside the window — cancel the pending free.
      if (disposeTimerRef.current !== undefined) {
        clearTimeout(disposeTimerRef.current);
        disposeTimerRef.current = undefined;
      }
      return;
    }
    disposeTimerRef.current = setTimeout(() => {
      disposeTimerRef.current = undefined;
      disposeResident(`hosting off for ${Math.round(RESIDENT_GRACE_MS / 60_000)}min`);
    }, RESIDENT_GRACE_MS);
    return () => {
      if (disposeTimerRef.current !== undefined) {
        clearTimeout(disposeTimerRef.current);
        disposeTimerRef.current = undefined;
      }
    };
  }, [enabled, disposeResident]);

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
        const extra = extraLoadedStagesRef.current;
        if (extra.length > 0 && limits) {
          // REUSE-STAGE0: THIS host's own [driverLayers,totalLayers)
          // hosting is off (or this tab isn't the hosting-colocation
          // leader), but a sibling server on this SAME peer
          // (`useLocalStageServe.ts`) still has something to advertise —
          // publish JUST that instead of unconditionally wiping
          // `cap.stageHost` to nothing (the pre-existing behavior below,
          // preserved byte-for-byte when there is nothing extra to carry).
          const cap = buildStageHostCap(
            { ...limits, contributionBudgetBytes: opts.contributionBudgetBytes },
            { keepalive: !!keepaliveEnabled, visible, onBattery, uptimeMs: Date.now() - mountedAtRef.current },
            cachedFragments,
            undefined,
            extra,
            opts.failureDomainId,
          );
          setStageHostCap(cap);
          peer.setCap({ ...baseCapRef.current, ts: Date.now(), stageHost: cap });
        } else if (extra.length === 0) {
          setStageHostCap(undefined);
          peer.setCap({ ...baseCapRef.current, ts: Date.now() });
        }
        // else: extra stages exist but `limits` hasn't resolved yet —
        // wait for a later tick (this effect re-runs once `limits`
        // settles) instead of publishing a wrong/incomplete cap.
      }
      return;
    }
    const publish = (): void => {
      const cap = buildStageHostCap(
        { ...limits, contributionBudgetBytes: opts.contributionBudgetBytes },
        {
          keepalive: !!keepaliveEnabled,
          visible,
          onBattery,
          uptimeMs: Date.now() - mountedAtRef.current,
        },
        cachedFragments,
        sessionCapacityRef.current,
        // REUSE-STAGE0: union a sibling server's own advertised stage(s)
        // (e.g. `useLocalStageServe.ts`'s [0,driverLayers) entry) onto
        // THIS host's own — see `extraLoadedStages`'s doc comment for why
        // this must be the ONE place `peer.setCap` is called for
        // `stageHost`, not two independent callers racing to clobber each
        // other (`Peer.setCap` fully replaces the previous cap).
        unionLoadedStages(suppressAdvertiseRef.current ? [] : loadedStagesRef.current, extraLoadedStagesRef.current),
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
  }, [peer, enabled, limits, supportState.ok, visible, onBattery, keepaliveEnabled, republishMs, opts.failureDomainId, opts.contributionBudgetBytes, extraLoadedStagesKey]);

  // ── Answer stage-control + activation frames while enabled ──────────
  useEffect(() => {
    if (!peer || !enabled) return;
    const meshPeer: Peer = peer;
    const log = (line: string) => logRef.current(line);

    // Worker/session/load state lives on the hook-lifetime `engineRef` (see
    // StageEngine's doc), NOT as effect-local `let`s — so a re-subscribe of
    // THIS effect (leader-election churn etc.) cannot dispose a stage the
    // host already loaded into VRAM. `engine.loadInFlight` still guards two
    // near-simultaneous opens from each starting their OWN `.load()` (M2:
    // two driver tabs can both `stage.session.open` before either finishes —
    // the second awaits THIS SAME promise). `engine.loadEpoch` bumps every
    // successful (re)load (MeshLoadedStage.epoch's doc). `hostSessions` is
    // aliased to the same persistent Map (mutated in place, never reassigned)
    // so active sessions survive a re-subscribe too.
    const engine = engineRef.current!;
    const hostSessions = engine.hostSessions;
    let queue: readonly QueueEntry<PendingOpen>[] = [];

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
        engine.workerClient && engine.loadedConfig
          ? [
              {
                modelId: engine.loadedConfig.modelId,
                layerStart: engine.loadedConfig.layerStart,
                layerEnd: engine.loadedConfig.layerEnd,
                includeEmbeddings: engine.workerClient.isFirst,
                includeOutput: engine.workerClient.isFinal,
                ctxSize: engine.loadedConfig.ctxSize,
                wireDtype: engine.loadedConfig.wireDtype,
                maxSessions: driverMaxSessions,
                activeSessions: hostSessions.size,
                epoch: engine.loadEpoch,
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
      const w = engine.workerClient;
      engine.workerClient = undefined;
      engine.loadedConfig = undefined;
      // RETRACT THE ADVERTISEMENT THE INSTANT THE WEIGHTS GO AWAY.
      // `loadedStagesRef` is what the publish loop broadcasts, and it is only
      // recomputed by syncPublicState(). Without this call it kept the OLD
      // stage after a dispose — and since `doLoad` begins with
      // `await disposeWorker()`, the peer went on telling the mesh "I have
      // [2,36) loaded" for the ENTIRE multi-minute reload. Drivers believed
      // the ad, routed real work to a host holding no weights, and sat
      // waiting through the download. A host must never be listed for a
      // stage it does not currently have resident.
      syncPublicState();
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
      // INSTRUMENTATION: this decision — reuse vs await-in-flight vs full
      // reload — is the difference between answering instantly and making a
      // caller wait out a multi-minute reload of weights we may already have.
      // It used to be silent, so a log could show "loading stage [2,36)" one
      // second after [2,36) finished preloading with NO way to tell which
      // branch fired or why. Never make anyone guess at this again.
      const cfgStr = (c: LoadedConfig | undefined): string =>
        c ? `[${c.layerStart},${c.layerEnd}) ctx=${c.ctxSize} ${c.wireDtype} ${c.modelId}` : 'none';
      log(
        `[stage-host] ensureWorkerLoaded want=${cfgStr(want)} resident=${cfgStr(engine.loadedConfig)} ` +
          `hasWorker=${!!engine.workerClient} loadInFlight=${!!engine.loadInFlight} sessions=${hostSessions.size} origin=${req.origin}`,
      );
      if (engine.workerClient && engine.loadedConfig && sameConfig(engine.loadedConfig, want)) {
        log(`[stage-host] REUSING resident stage ${cfgStr(engine.loadedConfig)} — no reload`);
        return;
      }

      if (engine.loadInFlight) {
        // Someone else is already loading (the common concurrent-open
        // race) — wait for THAT load, then re-check instead of starting
        // a second one.
        log('[stage-host] a load is already in flight — awaiting it instead of starting a second');
        await engine.loadInFlight.catch(() => undefined);
        if (engine.workerClient && engine.loadedConfig && sameConfig(engine.loadedConfig, want)) {
          log(`[stage-host] REUSING stage ${cfgStr(engine.loadedConfig)} after awaiting the in-flight load`);
          return;
        }
        log(
          `[stage-host] in-flight load settled but did NOT satisfy this request ` +
            `(resident=${cfgStr(engine.loadedConfig)} hasWorker=${!!engine.workerClient}) — reloading`,
        );
      }

      if (engine.workerClient && hostSessions.size > 0) {
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
        setLoadProgress(undefined);
        // Mirror the local shard-download progress OUT to the driver that
        // asked us to load (skip the self-directed preload, which has no
        // waiting driver). Before this the driver saw nothing between
        // stage.load and stage.ready ~8 min later — its wait was a flat
        // timeout that fired mid-download and forced a spurious replan, and
        // the chat UI had no "shard 24/36…" to show. See
        // StageLoadProgressPayload's doc.
        let lastProgress: StageWorkerLoadProgress | undefined;
        const notifyDriverLoadProgress = (p: StageWorkerLoadProgress, phase: 'downloading' | 'opening' | 'warming'): void => {
          if (req.peerId === '__preload__') return;
          void meshPeer
            .sendTool(
              encodeStageControl(
                makeStageLoadProgress(req.sessionId, {
                  shardsFetched: p.shardsFetched,
                  totalShards: p.totalShards,
                  bytesFetched: p.bytesFetched,
                  totalBytes: p.totalBytes,
                  phase,
                }),
              ),
              req.peerId,
            )
            .catch(() => undefined);
        };
        // A multi-GB model download has no fixed duration a flat timeout
        // could safely encode (observed live: Qwen3-8B's 4.7GB tripped a
        // 240s flat deadline mid-download, killing a perfectly healthy
        // load — "stage worker load exceeded 240000ms (worker died
        // silently or stalled)" — then it restarted and re-served from
        // the OPFS cache). Instead: watch for a STALL (no shard-progress
        // for LOAD_STALL_MS) and keep a generous LOAD_CEILING_MS backstop
        // for the pathological "progress never actually finishes" case —
        // see loadWatchdog.ts's module doc.
        // Rebuild download progress MONOTONICALLY from the SET of completed
        // shards. The loader fetches shards in PARALLEL and reports each
        // completion by its 1-based index with a prefix-by-index byte sum
        // (it assumes every lower-indexed shard is also done), so out-of-order
        // completion makes the raw numbers bounce — shard 6 → 990MB, then
        // shard 1 → 6MB — rolling the UI bar BACKWARD. A set only grows, and
        // req.shardBytes gives each shard's real size, so this only ever
        // climbs and reflects what's actually downloaded.
        const completedShardIdx = new Set<number>();
        const shardSizes = req.shardBytes;
        await runWithStallWatchdog(
          (progressTick) =>
            client.load(
              {
                modelId: req.modelId,
                layerStart: req.layerStart,
                layerEnd: req.layerEnd,
                totalLayers: req.totalLayers,
                shardUrls: req.shardUrls,
                shardHashes: req.shardHashes,
                shardBytes: req.shardBytes,
                shardRoles: req.shardRoles,
                ctxSize: req.ctxSize,
                // +1: legion_stage_open always creates one FUSED session
                // internally (used here only for the warm-up dispatch below) —
                // see this file's top doc comment and MULTI-SESSION.md.
                maxSessions: driverMaxSessions + 1,
              },
              {
                useMemoryShardStore: req.useMemoryShardStore,
                localFolderHandle: req.localFolderHandle,
                // GATED ROLLOUT (#47): opt into the incremental shard-by-shard
                // loader via ?incrementalLoad=1. Needs per-shard roles (the
                // artifact-slice manifest path) — a legacy full.gguf open has
                // none and stays on the monolithic loadStage. Read here (main
                // thread) so no flag has to thread through every hook.
                incrementalLoad:
                  !!req.shardRoles &&
                  req.shardRoles.length === req.shardUrls.length &&
                  typeof location !== 'undefined' &&
                  new URLSearchParams(location.search).get('incrementalLoad') === '1',
              },
              (progress) => {
                progressTick();
                // `progress.shardsFetched` is the just-completed shard's
                // 1-based INDEX (not a count). Fold it into the completed set
                // and recompute a monotonic count + real-byte sum; dupes
                // (the loader re-reports some shards) are absorbed by the set.
                if (progress.shardsFetched > 0) completedShardIdx.add(progress.shardsFetched);
                const monotonicShards = completedShardIdx.size;
                let monotonicBytes = progress.bytesFetched;
                if (shardSizes && shardSizes.length > 0) {
                  monotonicBytes = 0;
                  for (const idx of completedShardIdx) monotonicBytes += shardSizes[idx - 1] ?? 0;
                }
                const monotonic: StageWorkerLoadProgress = {
                  ...progress,
                  shardsFetched: monotonicShards,
                  bytesFetched: monotonicBytes,
                };
                setLoadProgress(monotonic);
                lastProgress = monotonic;
                // Prefer the loader's OWN phase — it knows whether it's still
                // fetching or already inside legion_stage_open pushing weights
                // to VRAM. The shard-count guess below is only a fallback for
                // an older runtime that doesn't report one, and it is wrong in
                // exactly the case that matters: a cache-warm load hits
                // shardsFetched===totalShards within seconds and then spends
                // minutes in the GPU upload.
                const phase =
                  progress.phase ??
                  (monotonic.totalShards > 0 && monotonic.shardsFetched >= monotonic.totalShards ? 'opening' : 'downloading');
                notifyDriverLoadProgress(monotonic, phase);
                log(
                  `[stage-host] load progress: ${monotonic.shardsFetched}/${monotonic.totalShards} shards` +
                    (monotonic.totalBytes
                      ? ` (${(monotonic.bytesFetched / 1048576).toFixed(0)}/${(monotonic.totalBytes / 1048576).toFixed(0)} MB)`
                      : ''),
                );
              },
            ),
          { stallMs: LOAD_STALL_MS, ceilingMs: LOAD_CEILING_MS },
        ).catch(async (err) => {
          // Dispose the worker whose load FAILED before the caller retries with
          // a fresh one. A failed load never reaches `engine.workerClient =
          // client` below, so `disposeWorker()` (which only frees the ASSIGNED
          // worker) would never touch it — its partial in-heap MEMFS staging
          // (up to ~the model's byte size) would linger and STACK across
          // retries, making each attempt OOM sooner (observed on 14B: fail at
          // shard 38 → shard 1 → before any shard). Terminating the worker
          // frees that heap so every retry starts from a clean slate.
          await client.dispose().catch(() => undefined);
          if (err instanceof StallTimeoutError) {
            throw new Error(`stage worker load ${err.message}`);
          }
          throw err;
        });
        // Keep progress flowing to the driver through the silent warm-up
        // tail (a throwaway WebGPU dispatch, seconds but not instant) so its
        // stall clock stays reset and the UI shows "warming up…" rather than
        // freezing on the last shard count.
        notifyDriverLoadProgress(
          lastProgress ?? { shardsFetched: 0, totalShards: 0, bytesFetched: 0 },
          'warming',
        );
        log('[stage-host] warming up WebGPU shader pipelines before accepting sessions…');
        // Same disposal discipline as the load catch above — a warm-up failure
        // (it allocates too) must free the worker rather than orphan its heap.
        try {
          await warmUpStageWorker(client, log);
        } catch (err) {
          await client.dispose().catch(() => undefined);
          throw err;
        }
        engine.workerClient = client;
        engine.loadedConfig = want;
        engine.loadEpoch += 1;
      })();
      engine.loadInFlight = doLoad;
      try {
        await doLoad;
      } finally {
        if (engine.loadInFlight === doLoad) engine.loadInFlight = undefined;
        // `loadProgress` must mean EXACTLY "a load is in flight right now" —
        // it's the signal the UI uses to decide whether to show the download
        // readout AT ALL (see deriveHostingLifecycleState). Left un-cleared it
        // lingered at its final value forever after a load, which would make a
        // finished stage look like it were perpetually "opening". Cleared on
        // success AND failure; the per-shard ticks above re-populate it the
        // moment the next load (e.g. the user raising their layer budget)
        // starts fetching.
        setLoadProgress(undefined);
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
        shardRoles: req.shardRoles,
        useMemoryShardStore: req.useMemoryShardStore,
        localFolderHandle: req.localFolderHandle,
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
        const client = engine.workerClient!;
        await client.sessionCreate(req.sessionId);
        let decoder: LegionActivationWireDecoder | undefined;
        let awaitingHeader = true;
        if (req.wireHeaderB64) {
          decoder = createLegionActivationWireDecoder(base64ToBytes(req.wireHeaderB64));
          awaitingHeader = false;
        }
        // TEXT-RELAY: tokenize `promptText` server-side NOW, at accept time —
        // only meaningful on the isFirst stage (the only one that embeds from
        // token ids at all). A driver with no local tokenizer can't populate
        // the first `sf` frame's `tokens` sideband itself; this session's
        // very first prefill frame will use these ids instead (see
        // onStageFrame below), discarding whatever placeholder that frame
        // carries. A tokenize failure here fails the whole open (caught by
        // this function's outer try/catch, same as any other open failure) —
        // there is no way to serve a session whose prompt can't be tokenized.
        let pendingPromptTokens: number[] | undefined;
        if (req.promptText !== undefined && client.isFirst) {
          pendingPromptTokens = await client.tokenize(req.promptText, true);
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
          // RELAY: the driver decides finality. It knows the whole plan; the
          // host only knows its own artifacts. Absent (pre-relay / legacy) ⇒
          // fall back to the artifact-derived answer, which is correct for the
          // proven single-remote-stage shape.
          isFinal: req.isFinalOverride ?? client.isFinal,
          layerStart: req.layerStart,
          layerEnd: req.layerEnd,
          totalLayers: req.totalLayers,
          // Accept `sf` from the upstream hop (driver for stage 1, prior relay
          // for ≥2); default to the opener so a legacy/2-stage open is unchanged.
          prevPeerId: req.prevPeerId ?? req.peerId,
          nextPeerId: req.nextPeerId,
          modelId: req.modelId,
          stageIndex: req.stageIndex ?? 1,
          wireDtype: req.wireDtype,
          pendingPromptTokens,
          textOutput: req.textOutput ?? false,
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
      await engine.workerClient?.sessionFree(sessionId).catch(() => undefined);
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
        // Propagate the teardown BOTH ways: upstream to the driver (owns the
        // token stream) AND, for a relay, downstream to the next hop (whose
        // session is now orphaned). For a 2-stage session prevPeerId ===
        // driverPeerId and nextPeerId is undefined, so this is one send.
        const notify = new Set<string>([state.driverPeerId]);
        if (state.nextPeerId) notify.add(state.nextPeerId);
        for (const target of notify) {
          await meshPeer.sendTool(encodeStageControl(makeStageStop(sessionId, reason)), target).catch(() => undefined);
        }
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
      // REUSE-STAGE0 — when this host operates under a CLAIM-DRIVEN regime
      // (`preloadStage` set, i.e. `useCommunalHost.ts`'s assembly loop owns
      // what this host loads), a request for a DIFFERENT range than the
      // current claim is not meant for this hook at all — most likely a
      // peer that ALSO runs `useLocalStageServe.ts` for a fixed different
      // range on the SAME connection (see that module's cap-union doc
      // comment). Silently ignoring it (rather than `ensureWorkerLoaded`,
      // which would otherwise reconfigure — or outright fail — this host's
      // OWN claim out from under it) is what keeps two independent servers
      // on one peer from fighting over the same wire message. A legacy/
      // Phase-C `useStagePipeline` driver (no `preloadStage`) is
      // unaffected — this guard only engages once a claim exists, and in
      // every pre-existing flow a driver only ever requests the EXACT
      // range this host currently advertises, so this is a no-op there.
      const claim = claimedRangeRef.current;
      if (claim && (msg.payload.layerStart !== claim.layerStart || msg.payload.layerEnd !== claim.layerEnd)) {
        log(
          `[stage-host] stage.session.open for [${msg.payload.layerStart},${msg.payload.layerEnd}) IGNORED — this host's claim is [${claim.layerStart},${claim.layerEnd})`,
        );
        return;
      }
      log(`[stage-host] stage.session.open from ${peerId} sessionId=${msg.sessionId} layers=[${msg.payload.layerStart},${msg.payload.layerEnd})`);
      // The `stage.session.open` payload carries NO shard info by design — the
      // host resolves shards for the requested range from its OWN manifest.
      // Without this a served session loads zero shards and `legion_stage_open`
      // fails ("paths, path_count, and out_model are required").
      let shardUrls: readonly string[] = [];
      if (resolveSessionShardsRef.current) {
        try {
          shardUrls = await resolveSessionShardsRef.current({
            modelId: msg.payload.modelId,
            layerStart: msg.payload.layerStart,
            layerEnd: msg.payload.layerEnd,
            totalLayers: msg.payload.totalLayers,
          });
        } catch (err) {
          log(
            `[stage-host] shard resolution failed for [${msg.payload.layerStart},${msg.payload.layerEnd}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
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
        shardUrls,
        wireHeaderB64: msg.payload.wireHeader,
        // RELAY: driver-assigned position. Absent ⇒ pre-relay 2-stage
        // assumption (final stage, driver upstream, no downstream).
        isFinalOverride: msg.payload.isFinal,
        nextPeerId: msg.payload.nextPeerId,
        prevPeerId: msg.payload.prevPeerId,
        stageIndex: msg.payload.stageIndex,
        promptText: msg.payload.promptText,
        textOutput: msg.payload.textOutput,
      });
    }

    async function handlePing(msg: StageControlMessageFor<'stage.ping'>, peerId: string): Promise<void> {
      await meshPeer.sendTool(encodeStageControl(makeStagePong(msg.sessionId, msg.payload.sentAtMs, msg.callId)), peerId);
    }

    async function handleStop(msg: StageControlMessageFor<'stage.stop'>, peerId: string): Promise<void> {
      const state = hostSessions.get(msg.sessionId);
      // A stop is legitimate from any peer in THIS session's pipeline — the
      // driver, our upstream, or our downstream (a relay tears down both ways).
      // notifyDriver:true so the stop keeps propagating to the OTHER neighbour.
      if (!state || (peerId !== state.driverPeerId && peerId !== state.prevPeerId && peerId !== state.nextPeerId)) return;
      log(`[stage-host] stage.stop from ${peerId} sessionId=${msg.sessionId}: ${msg.payload.reason}`);
      await freeSession(msg.sessionId, msg.payload.reason, true);
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
        // NOT an error, so NOT logged (see #55): `peer.onStageFrame`
        // broadcasts every inbound frame to ALL listeners, so a tab running
        // both this body-host engine AND localStageServeEngine sees the
        // sibling engine's frames (and selfId loopback frames) here. A
        // sessionId absent from THIS engine's map belongs to another engine
        // or was already freed — a filter-miss, not a drop. The old "DROPPED
        // — unknown sessionId" warning fired once per token in the solo
        // self-host case and actively misled diagnosis. A genuinely orphaned
        // frame shows up as a generation stall upstream, not as noise here.
        return;
      }
      // Spoof guard: only this session's UPSTREAM peer may drive it — the
      // driver for stage 1, the previous relay for a hop ≥2. (For a 2-stage
      // session prevPeerId === driverPeerId, so this is unchanged.)
      if (peerId !== state.prevPeerId) {
        // A peer that serves MULTIPLE stages for one driver receives every
        // frame the driver (or its own internal forward) addresses to it and
        // hands it to ALL local stage handlers; whichever stage the frame
        // isn't for lands here and is dropped. That's expected co-located
        // routing, not a spoof — only warn when the sender isn't a known
        // participant of THIS session (driver / downstream / self).
        const knownParticipant = peerId === state.driverPeerId || peerId === state.nextPeerId || peerId === meshPeer.selfId;
        if (!knownParticipant) {
          log(`[stage-host] onStageFrame DROPPED — peerId=${peerId} is not the upstream of sessionId=${sessionId} (expected=${state.prevPeerId})`);
        }
        return;
      }
      state.lastFrameAt = Date.now();
      void (async () => {
        try {
          const client = engine.workerClient;
          if (!client) return;
          if (state.awaitingHeader) {
            state.decoder = createLegionActivationWireDecoder(bytes);
            state.awaitingHeader = false;
            log(`[stage-host] wire header sessionId=${sessionId}: modelId=${state.decoder.modelId} nEmbd=${state.decoder.nEmbd} dtype=${state.decoder.dtype}`);
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
          // TEXT-RELAY: this session's very first prefill frame — if it was
          // opened with `promptText` (isFirst stage only), the REAL token ids
          // came from tokenizing that text server-side at open time (see
          // openNow above), not from this frame's own placeholder
          // tokens/activation (a textRelay driver has no local tokenizer to
          // populate them with). Override once, then clear so every later
          // frame on this session (real decode-step token ids, always known
          // to the driver via the previous stage.token reply) uses the
          // ordinary path unchanged.
          if (isPrefill && state.pendingPromptTokens) {
            tokens = state.pendingPromptTokens;
            state.pendingPromptTokens = undefined;
            wireFrame = dummyActivationFrame(tokens.length, client.nEmbd);
          }
          const positions = tokens.map((_, i) => (frame.posStart ?? 0) + i);
          const result = isPrefill
            ? await client.prefill(tokens as number[], positions, wireFrame, sessionId)
            : await client.decode((tokens[0] as number) ?? 0, wireFrame, sessionId);

          if (!state.isFinal) {
            // ── RELAY: this stage is NOT final. Its worker returned the
            // boundary activation for the next slice; forward it to the
            // downstream peer instead of sampling. seq/tokens/posStart/done
            // are carried through verbatim so the downstream re-derives
            // isPrefill (seq===0) and positions exactly as this host did.
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
              // One header, before the first activation frame — the downstream
              // host (opened with NO wireHeader) is awaitingHeader and takes
              // this as its decoder header (the legacy first-frame path).
              await meshPeer.sendStageFrame(encodeStageFrameEnvelope(sessionId, state.forwardEncoder.headerBytes()), state.nextPeerId);
              state.forwardHeaderSent = true;
            }
            const activationF32 = new Float32Array(result.activation.payload);
            const outBytes = state.forwardEncoder.encodeFrame(activationF32, {
              seq: frame.seq,
              posStart: frame.posStart ?? 0,
              tokens: frame.tokens,
              done: frame.done,
              ...(frame.finishReason !== undefined ? { finishReason: frame.finishReason } : {}),
            });
            await meshPeer.sendStageFrame(encodeStageFrameEnvelope(sessionId, outBytes), state.nextPeerId);
            state.decodedCount += 1;
            syncPublicState();
            return;
          }

          // ── FINAL stage: sample and return the token to the DRIVER.
          if (result.predictedToken === undefined) {
            throw new Error('final-stage host produced no predictedToken');
          }
          state.decodedCount += 1;
          syncPublicState();
          const isEog = await client.tokenIsEog(result.predictedToken);
          // TEXT-RELAY: this session's driver has no local tokenizer — stream
          // the incremental decoded TEXT alongside the numeric token id
          // instead of leaving detokenization to the driver. Redecodes the
          // WHOLE growing token sequence every step (never a single token in
          // isolation — see `incrementalTextStream.ts`'s doc comment for why
          // that would be unsound) and buffers any still-incomplete trailing
          // multi-byte character until a later step completes it; `flush` on
          // eos so nothing sampled is silently dropped if generation ends
          // mid-sequence.
          let textDelta: string | undefined;
          if (state.textOutput) {
            state.sampledTokens = state.sampledTokens ?? [];
            // Never fold a stop token (e.g. ChatML <|im_end|>) into the
            // streamed text — it's a control signal, not content, and the
            // detokenizer renders it as the literal "<|im_end|>", which
            // leaked into thin-client output. isEog is the stop; the text
            // stops with it.
            if (!isEog) state.sampledTokens.push(result.predictedToken);
            const fullText = await client.detokenize(state.sampledTokens);
            const { delta, cursor } = extractIncrementalTextDelta(fullText, state.textCursor ?? INITIAL_TEXT_CURSOR, {
              flush: isEog,
            });
            state.textCursor = cursor;
            if (delta.length > 0) textDelta = delta;
          }
          // Reply to the DRIVER, not the inbound sender — under relay the
          // frame arrived from the previous hop, but the token stream belongs
          // to the driver's session. (For a 2-stage session prevPeerId ===
          // driverPeerId, so this is unchanged.)
          await meshPeer.sendTool(
            encodeStageControl(
              makeStageToken(sessionId, result.predictedToken, frame.seq, isEog, isEog ? 'eos' : undefined, textDelta),
            ),
            state.driverPeerId,
          );
          if (state.decodedCount % progressEveryN === 0) {
            await meshPeer.sendTool(encodeStageControl(makeStageProgress(sessionId, state.decodedCount, frame.seq)), state.driverPeerId);
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
        // A relay session dies if ANY of its pipeline neighbours vanish — the
        // driver, our upstream (no more frames coming), or our downstream (no
        // one to forward to). notifyDriver:true so the surviving neighbours
        // learn to tear down too.
        const goneDriver = !present.has(state.driverPeerId);
        const gonePrev = !present.has(state.prevPeerId);
        const goneNext = state.nextPeerId !== undefined && !present.has(state.nextPeerId);
        if (goneDriver || gonePrev || goneNext) {
          const who = goneDriver ? 'driver' : gonePrev ? 'upstream' : 'downstream';
          void freeSession(sessionId, `${who} left the mesh`, true);
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
      // Deliberately NOT disposing the worker here. This effect re-subscribes
      // on `enabled`/leadership churn, and disposing on every re-subscribe is
      // exactly what silently threw away a stage already loaded into VRAM
      // (see StageEngine's doc). The weights live on `engineRef` and are
      // disposed only on true unmount (the []-effect near the top of the
      // hook); a re-subscribe re-adopts the same resident engine and reuses it.
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
    // Was MISSING: every shard called setLoadProgress(...) and logged
    // "[stage-host] load progress: shard 3/12 (251/1274 MB)" to the console,
    // but the handle never handed it back — so `useCommunalHost`'s
    // `downloadProgress` (and therefore the right drawer's progress bar) was
    // permanently undefined and the user saw a bare "Downloading model…" with
    // no numbers during a multi-minute download. `loadProgress?:` being
    // OPTIONAL on the interface is why tsc never flagged the omission.
    loadProgress,
  };
}
