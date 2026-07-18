/**
 * useLocalStageServe — REUSE-STAGE0 Phase 1's serving layer. Wires
 * `localStageServeEngine.ts`'s ADOPTED-mode engine to a real `Peer` and
 * `useCommunalChat.ts`'s resident stage-0 worker (`ResidentStageZero`,
 * via its `residentStageZeroRef`), so a capable peer can serve its
 * already-loaded, already-embeddings-including `[0, driverLayers)` stage
 * to thin/text-relay clients — no second GPU load, no second download.
 *
 * ── Gating ────────────────────────────────────────────────────────────
 *
 * Active only when ALL of:
 *   1. `enabled` (the "Serve the first stage" opt-in — see
 *      `useHostingConsent.ts`'s `serveFirstStage`) is true.
 *   2. This tab holds a DEDICATED cross-tab leader lock
 *      (`leaderLockName`) — same `acquireLeaderLock` idiom
 *      `useCommunalChat.ts`/`useStagePipeline.ts` use, but a DIFFERENT
 *      lock name from the chat driver's own. Reusing the CHAT lock would
 *      be wrong: that lock is held only transiently, for the duration of
 *      one chat turn (`useCommunalChat.ts`'s `start()`/`finally`) — a
 *      persistent hold here (for as long as `enabled` is true) would
 *      starve this SAME tab's own `start()` from ever acquiring it. This
 *      dedicated lock instead answers "which ONE tab in this browser
 *      profile serves stage-0" — orthogonal to which tab (if any) is
 *      currently mid-chat-turn.
 *   3. `residentStageZeroRef.current` is non-null (the resident worker
 *      has actually loaded — see `useCommunalChat.ts`'s `serveFirstStage`
 *      doc comment: loading is lazy, triggered by the driver's own first
 *      chat turn after the toggle goes on).
 *
 * The resident ref is a plain mutable ref (not React state — a future
 * serving layer must never force `useCommunalChat` to re-render just to
 * expose a worker it already loaded), so this hook POLLS it
 * (`RESIDENT_POLL_MS`) rather than subscribing to a change event that
 * doesn't exist. A serving engine typically appears within one poll tick
 * after the driver's first post-toggle chat turn finishes loading it —
 * acceptable staleness for a UI-timescale feature (nothing here is
 * latency-sensitive at sub-second granularity).
 *
 * ── Cross-talk with `useStageHost.ts` ────────────────────────────────
 *
 * A peer can run BOTH this hook (serving `[0, driverLayers)`) AND
 * `useCommunalHost.ts`'s own `useStageHost` (serving
 * `[driverLayers, totalLayers)`) at once — both listen on the SAME
 * `peer.onTool`/`peer.onStageFrame`. This hook only ever acts on a
 * `stage.session.open`/`sf` frame whose range matches ITS OWN fixed
 * `[0, driverLayers)` (never anything wider), and `useStageHost.ts` has
 * a symmetric guard (`claimedRangeRef`) that ignores a request outside
 * its OWN claim — see that file's `handleSessionOpen` doc comment.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  decodeStageControl,
  isStageControlFrame,
  type MeshLoadedStage,
  type Peer,
  type StandingLedger,
} from '@unstable-legion/core';
import type { ResidentStageZero } from './useCommunalChat.js';
import { acquireLeaderLock } from './useStagePipeline.js';
import type { StageWorkerLog } from './stageWorkerClient.js';
import type { UseStageHostSession } from './useStageHost.js';
import {
  createLocalStageServeEngine,
  sameServedConfig,
  type LocalStageServeEngine,
  type ServedStageConfig,
} from './localStageServeEngine.js';
import { DEFAULT_IDLE_EVICT_MS, type PriorityScoreFn } from './stageSessionAdmission.js';

export interface UseLocalStageServeOptions {
  /** The "Serve the first stage" opt-in — see this module's doc comment. */
  enabled: boolean;
  peer: Peer | null;
  /** `useCommunalChat.ts`'s `residentStageZeroRef` — read fresh, never
   * cached (see that ref's own doc comment). */
  residentStageZeroRef: { readonly current: ResidentStageZero | null };
  /** Ceiling on served lanes. Default: the resident worker's own
   * `serveMaxSessions` (recommended — the resident was loaded with room
   * for exactly that many; passing something LARGER here would admit more
   * concurrent lanes than the native `legion_stage_open` call reserved). */
  desiredMaxSessions?: number;
  priorityScore?: PriorityScoreFn;
  standingLedger?: StandingLedger;
  /** How often (ms) to sweep for idle sessions to evict. Default 30_000
   * (mirrors `useStageHost.ts`'s identical default). */
  idleSweepMs?: number;
  /** Idle threshold (ms, no inbound `sf` frame) before eviction. Default
   * `DEFAULT_IDLE_EVICT_MS` (5 minutes — same as `useStageHost.ts`). */
  idleEvictMs?: number;
  /** How often (ms) to poll `residentStageZeroRef` for a new/changed/gone
   * worker. Default 1000 — see this module's doc comment on why polling. */
  residentPollMs?: number;
  /** Dedicated cross-tab leader lock name — see this module's doc comment
   * for why it MUST differ from the chat driver's own `leaderLockName`.
   * Default `DEFAULT_SERVE_LOCK_NAME`. */
  leaderLockName?: string;
  log?: StageWorkerLog;
}

export interface UseLocalStageServeHandle {
  /** True once this tab holds the serve lock AND has adopted a resident
   * worker (an engine exists). */
  active: boolean;
  sessions: readonly UseStageHostSession[];
  queueLength: number;
  lastError?: string;
  /** This hook's `cap.stageHost.loadedStages` entry, or `undefined` while
   * inactive — union this into `useCommunalHost`'s `extraLoadedStages`
   * (see that option's doc comment for why it must flow through ONE
   * `peer.setCap` call site). Reactive (state-backed) so passing it
   * straight into another hook's prop triggers that hook's own effects
   * the normal React way — no manual pub/sub needed. */
  loadedStageEntry?: MeshLoadedStage;
  /** Same value as `loadedStageEntry`, as a synchronous accessor — for a
   * caller that wants the CURRENT value without waiting for a re-render
   * (e.g. inside another effect's cleanup). */
  getLoadedStageEntry: () => MeshLoadedStage | undefined;
}

const DEFAULT_IDLE_SWEEP_MS = 30_000;
const DEFAULT_RESIDENT_POLL_MS = 1000;
const DEFAULT_SERVE_LOCK_NAME = 'unstable-legion-serve-first-stage-leader-v1';

interface EngineHolder {
  engine: LocalStageServeEngine;
  clientIdentity: unknown;
  config: ServedStageConfig;
  maxSessions: number;
  epoch: number;
}

export function useLocalStageServe(opts: UseLocalStageServeOptions): UseLocalStageServeHandle {
  const {
    enabled,
    peer,
    residentStageZeroRef,
    desiredMaxSessions,
    idleSweepMs = DEFAULT_IDLE_SWEEP_MS,
    idleEvictMs = DEFAULT_IDLE_EVICT_MS,
    residentPollMs = DEFAULT_RESIDENT_POLL_MS,
    leaderLockName = DEFAULT_SERVE_LOCK_NAME,
    log = () => undefined,
  } = opts;

  const logRef = useRef(log);
  logRef.current = log;
  const priorityScoreRef = useRef<PriorityScoreFn>(opts.priorityScore ?? (() => 0));
  priorityScoreRef.current = opts.priorityScore ?? (() => 0);
  const standingLedgerRef = useRef<StandingLedger | undefined>(opts.standingLedger);
  standingLedgerRef.current = opts.standingLedger;

  const [isLeader, setIsLeader] = useState(false);
  const lockRef = useRef<{ release: () => void } | null>(null);

  // Hold the DEDICATED serve lock — see this module's doc comment for why
  // it must not be the chat driver's own transient lock.
  useEffect(() => {
    if (!enabled) {
      setIsLeader(false);
      return;
    }
    let cancelled = false;
    void acquireLeaderLock(leaderLockName).then((lock) => {
      if (cancelled) {
        lock?.release();
        return;
      }
      if (lock) {
        lockRef.current = lock;
        setIsLeader(true);
      } else {
        setIsLeader(false);
      }
    });
    return () => {
      cancelled = true;
      lockRef.current?.release();
      lockRef.current = null;
      setIsLeader(false);
    };
  }, [enabled, leaderLockName]);

  const [sessions, setSessions] = useState<readonly UseStageHostSession[]>([]);
  const [queueLength, setQueueLength] = useState(0);
  const [lastError, setLastError] = useState<string | undefined>(undefined);
  const [loadedStageEntry, setLoadedStageEntry] = useState<MeshLoadedStage | undefined>(undefined);

  const holderRef = useRef<EngineHolder | null>(null);
  const loadedStageEntryRef = useRef<MeshLoadedStage | undefined>(undefined);

  const syncPublicState = useCallback((): void => {
    const holder = holderRef.current;
    if (!holder) {
      setSessions((prev) => (prev.length === 0 ? prev : []));
      setQueueLength((prev) => (prev === 0 ? prev : 0));
      setLastError(undefined);
      loadedStageEntryRef.current = undefined;
      setLoadedStageEntry(undefined);
      return;
    }
    setSessions(holder.engine.getSessions());
    setQueueLength(holder.engine.getQueueLength());
    setLastError(holder.engine.getLastError());
    const entry = holder.engine.getLoadedStageEntry();
    loadedStageEntryRef.current = entry;
    setLoadedStageEntry(entry);
  }, []);

  useEffect(() => {
    if (!enabled || !isLeader || !peer) {
      const holder = holderRef.current;
      if (holder) {
        holderRef.current = null;
        void holder.engine.stopAll('serving disabled').finally(syncPublicState);
      } else {
        syncPublicState();
      }
      return;
    }
    const meshPeer = peer;
    let cancelled = false;

    function adopt(): void {
      if (cancelled) return;
      const resident = residentStageZeroRef.current;
      const holder = holderRef.current;
      if (!resident) {
        if (holder) {
          holderRef.current = null;
          void holder.engine.stopAll('resident worker no longer available').finally(syncPublicState);
        }
        return;
      }
      const ceiling = desiredMaxSessions ?? resident.serveMaxSessions;
      const wantConfig: ServedStageConfig = {
        modelId: resident.modelId,
        layerStart: resident.layerStart,
        layerEnd: resident.layerEnd,
        totalLayers: resident.totalLayers,
        ctxSize: resident.ctxSize,
        wireDtype: resident.wireDtype,
      };
      if (
        holder &&
        holder.clientIdentity === resident.client &&
        sameServedConfig(holder.config, wantConfig) &&
        holder.maxSessions === ceiling &&
        holder.epoch === resident.epoch
      ) {
        return; // already correctly adopting this exact resident instance
      }
      if (holder) {
        holderRef.current = null;
        void holder.engine.stopAll('resident worker changed');
      }
      const engine = createLocalStageServeEngine({
        meshPeer,
        client: resident.client,
        config: wantConfig,
        maxSessions: ceiling,
        epoch: resident.epoch,
        priorityScore: (peerId) => priorityScoreRef.current(peerId),
        standingLedger: standingLedgerRef.current,
        log: (line) => logRef.current(line),
        onChange: syncPublicState,
      });
      holderRef.current = { engine, clientIdentity: resident.client, config: wantConfig, maxSessions: ceiling, epoch: resident.epoch };
      syncPublicState();
    }

    adopt();
    const pollTimer = setInterval(adopt, residentPollMs);

    const unsubTool = meshPeer.onTool((frame, peerId) => {
      const holder = holderRef.current;
      if (!holder || !isStageControlFrame(frame)) return;
      const decoded = decodeStageControl(frame);
      if (!decoded) return;
      if (decoded.kind === 'stage.session.open') {
        // Only ours — see this module's "Cross-talk" doc section.
        if (decoded.payload.layerStart !== holder.config.layerStart || decoded.payload.layerEnd !== holder.config.layerEnd) return;
        void holder.engine.handleSessionOpen(decoded.payload, peerId, decoded.callId);
      } else if (decoded.kind === 'stage.stop') {
        void holder.engine.handleStop(decoded.sessionId, peerId, decoded.payload.reason);
      }
    });
    const unsubFrame = meshPeer.onStageFrame((bytes, peerId) => {
      holderRef.current?.engine.handleStageFrame(bytes, peerId);
    });
    const idleTimer = setInterval(() => {
      holderRef.current?.engine.idleSweep(Date.now(), idleEvictMs);
    }, idleSweepMs);
    const unsubRoster = meshPeer.roster.subscribe((snapshot) => {
      holderRef.current?.engine.onRosterChange(new Set(snapshot.map((e) => e.peerId)));
    });
    const onPageHide = (): void => {
      void holderRef.current?.engine.stopAll('peer pagehide');
    };
    if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);

    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      clearInterval(idleTimer);
      unsubTool();
      unsubFrame();
      unsubRoster();
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
      const holder = holderRef.current;
      holderRef.current = null;
      if (holder) void holder.engine.stopAll('serve effect torn down');
    };
  }, [enabled, isLeader, peer, residentStageZeroRef, desiredMaxSessions, idleSweepMs, idleEvictMs, residentPollMs, syncPublicState]);

  const getLoadedStageEntry = useCallback((): MeshLoadedStage | undefined => loadedStageEntryRef.current, []);

  return {
    active: !!holderRef.current,
    sessions,
    queueLength,
    lastError,
    loadedStageEntry,
    getLoadedStageEntry,
  };
}
