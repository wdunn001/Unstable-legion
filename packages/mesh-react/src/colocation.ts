/**
 * Same-origin tab colocation — collapses the STAGE-HOSTING role to
 * exactly ONE tab per browser profile per machine.
 *
 * ── The gap this closes ───────────────────────────────────────────────
 *
 * Opening N same-origin tabs of this app used to make N independent
 * `useCommunalHost` instances, each joining the mesh as its OWN Trystero
 * peer and independently deciding what to claim. Two problems fell out of
 * that:
 *
 *   1. If those tabs couldn't actually see each other over the mesh (a
 *      same-machine WebRTC/ICE connection failing silently behind a NAT
 *      with no TURN configured — plausible and observed: `Roster.upsert`
 *      only fires on a received `cap`, never on Trystero's `onPeerJoin`
 *      alone), every tab independently computed the SAME "lowest
 *      uncovered gap" and claimed it — N tabs, one duplicated range, zero
 *      spread, N redundant GPU loads (largely masked by the shared
 *      same-origin OPFS cache — see `legion-stage-runtime`'s
 *      `shardCache.ts` — into looking like "one shared load" when it was
 *      really N independent ones).
 *   2. Even when mesh visibility DID work, two tabs on one machine still
 *      only represent ONE real failure domain (the machine dying takes
 *      both out at once) — counting them as independent redundancy
 *      defeats the whole warm-spare design.
 *
 * The fix: only ONE tab per origin ever runs the actual hosting loop
 * (GPU worker, OPFS load, mesh `cap.stageHost` advertisement). Every
 * other same-origin tab is a passive VIEW that mirrors the leader's
 * status. Net effect: N tabs open == 1 GPU load, 1 claimed range, 1 OPFS
 * load, exactly as if only one tab existed.
 *
 * Scope: hosting only. Each tab keeps its OWN mesh `peer` for driving its
 * OWN chat conversation (`useCommunalChat`) — this module has no opinion
 * about chat, which is unaffected.
 *
 * ── Mechanism ────────────────────────────────────────────────────────
 *
 *   - Leader election: `navigator.locks.request('legion-host-leader',
 *     {mode:'exclusive'}, cb)`. The browser grants the lock to exactly
 *     one holder; `cb` is invoked once granted and the lock is held for
 *     as long as the returned promise stays pending — released
 *     automatically when the tab closes/crashes (or `close()` resolves
 *     it), at which point the NEXT waiting tab is granted the lock and
 *     promotes itself. That promotion IS the failover: the newly-leader
 *     tab starts its own `useStageHost` loop, which re-loads from the
 *     shared OPFS cache (near-instant if already resident) and
 *     re-advertises — an ordinary churn/replan event the rest of the mesh
 *     already handles.
 *   - Status relay: `BroadcastChannel('legion-colocation')`. The leader
 *     publishes a small serializable snapshot of its hosting status
 *     whenever it changes; every follower mirrors it for display. A
 *     freshly-mounted follower asks for the current status immediately
 *     (`status-request`) rather than waiting for the leader's next
 *     natural publish.
 *
 * Both are optional/feature-detected — an environment missing either
 * (older Safari, some embedded webviews) degrades to "every tab is its
 * own leader," i.e. exactly today's pre-this-fix behavior. Never a hard
 * failure, never a follower stuck leaderless.
 *
 * WHY NOT SharedWorker: it would need to run the GPU worker OR relay for
 * it, but WebGPU inside a SharedWorker has spotty/absent support across
 * browsers (and no support at all in browsers lacking SharedWorker, e.g.
 * iOS Safari, which DOES have BroadcastChannel) — so the actual hosting
 * stays in the leader tab's ordinary DedicatedWorker regardless, and
 * BroadcastChannel + Web Locks alone already fully cover the coordination
 * need (leader election + small status relay) without a second worker
 * script's added complexity for equivalent capability.
 */

const FAILURE_DOMAIN_STORAGE_KEY = 'legion:failureDomainId';

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeLocalStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    // Some sandboxed/private-mode contexts throw a SecurityError just
    // touching `localStorage` — treat identically to "unavailable".
    return undefined;
  }
}

/**
 * Mint (once) or read back a stable id for "this browser profile, on this
 * machine" — persisted in localStorage, so every same-origin tab of this
 * profile shares it, stable across restarts. Populates the cap's additive
 * `failureDomainId` (see `@unstable-legion/core`'s `types.ts` doc
 * comment) — cheap defense-in-depth for the residual edge case this
 * module's leader/follower design doesn't itself cover (e.g. two
 * DIFFERENT browsers/profiles on the same physical machine, which can't
 * coordinate via localStorage/BroadcastChannel/Web Locks at all — the
 * mesh-side distinct-domain accounting is the only thing that can still
 * catch that one). Returns `undefined` when `localStorage` is
 * unavailable — callers treat an absent id as "this peer is its own
 * domain" (its peerId), never crashing on it.
 */
export function getOrCreateFailureDomainId(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = safeLocalStorage(),
): string | undefined {
  if (!storage) return undefined;
  try {
    const existing = storage.getItem(FAILURE_DOMAIN_STORAGE_KEY);
    if (existing) return existing;
    const minted = `fd-${randomId()}`;
    storage.setItem(FAILURE_DOMAIN_STORAGE_KEY, minted);
    return minted;
  } catch {
    return undefined;
  }
}

// ── Shared hosting-status snapshot (leader -> followers) ────────────────

/** Small, serializable mirror of the leader's hosting state — everything
 * a follower tab needs to render the SAME status the leader sees.
 * Deliberately excludes per-session driver detail (not rendered by any
 * current UI, and not worth the relay/PII surface). */
export interface SharedHostStatus {
  phase: string;
  claim?: { layerStart: number; layerEnd: number; includeOutput: boolean };
  active: boolean;
  sessionCount: number;
  tokensDecoded: number;
  maxSessions: number;
  queueLength: number;
  errorMessage?: string;
  retrying: boolean;
  retryAttempt: number;
  /** Epoch-ms this snapshot was published — see `STATUS_STALE_MS`. */
  ts: number;
}

interface ColocationMessage {
  kind: 'status' | 'status-request' | 'bye';
  tabId: string;
  status?: SharedHostStatus;
}

export interface ColocationCoordinatorOptions {
  /** Injectable for tests. Defaults to `globalThis.BroadcastChannel`. */
  BroadcastChannelCtor?: typeof BroadcastChannel;
  /** Injectable for tests. Defaults to `navigator.locks`. */
  locks?: LockManager;
  channelName?: string;
  leaderLockName?: string;
  /** Unique id for THIS tab. Default random. */
  tabId?: string;
}

export interface ColocationCoordinatorHandle {
  tabId: string;
  /** True iff BOTH BroadcastChannel and Web Locks are available. When
   * `false`, `isLeader()` is unconditionally `true` — every tab acts
   * alone (the only safe degrade for an environment that can't
   * coordinate at all: a follower with no possible leader would never
   * host anything). */
  supported: boolean;
  isLeader(): boolean;
  onLeaderChange(cb: (leader: boolean) => void): () => void;
  /** The leader calls this whenever its own hosting status changes —
   * relayed to every follower. No-op when called by a non-leader (a
   * follower calling this by mistake never corrupts the shared status). */
  publishStatus(status: SharedHostStatus): void;
  /** Followers read the most recently relayed leader status here.
   * `undefined` before the first relay, or once it's older than
   * `STATUS_STALE_MS` (a leader that vanished without a clean `bye`). */
  latestStatus(): SharedHostStatus | undefined;
  onStatusChange(cb: () => void): () => void;
  close(): void;
}

const DEFAULT_CHANNEL_NAME = 'legion-colocation';
const DEFAULT_LEADER_LOCK_NAME = 'legion-host-leader';
/** A follower stops trusting the leader's last relayed status past this
 * age. Web Locks releasing on tab close is the REAL failover signal
 * (immediate, reliable); this is only staleness for the status MIRROR a
 * follower renders in the meantime, covering a leader that crashed hard
 * enough to skip its `bye` message. */
const STATUS_STALE_MS = 20_000;

export function createColocationCoordinator(opts: ColocationCoordinatorOptions = {}): ColocationCoordinatorHandle {
  const tabId = opts.tabId ?? randomId();
  const channelName = opts.channelName ?? DEFAULT_CHANNEL_NAME;
  const leaderLockName = opts.leaderLockName ?? DEFAULT_LEADER_LOCK_NAME;
  const BC = opts.BroadcastChannelCtor ?? (typeof BroadcastChannel !== 'undefined' ? BroadcastChannel : undefined);
  const locks = opts.locks ?? (typeof navigator !== 'undefined' ? navigator.locks : undefined);
  const supported = !!BC && !!locks?.request;

  let leader = !supported; // unsupported -> every tab is unconditionally its own leader
  let closed = false;
  let releaseLock: (() => void) | undefined;
  let lastStatus: SharedHostStatus | undefined;
  const leaderCbs = new Set<(leader: boolean) => void>();
  const statusCbs = new Set<() => void>();

  const channel = BC ? new BC(channelName) : undefined;

  function setLeader(next: boolean): void {
    if (leader === next) return;
    leader = next;
    for (const cb of leaderCbs) cb(leader);
  }

  function setStatus(status: SharedHostStatus | undefined): void {
    lastStatus = status;
    for (const cb of statusCbs) cb();
  }

  channel?.addEventListener('message', (ev: MessageEvent<ColocationMessage>) => {
    const msg = ev.data;
    if (!msg || msg.tabId === tabId) return;
    if (msg.kind === 'status') {
      if (msg.status) setStatus(msg.status);
      return;
    }
    if (msg.kind === 'status-request') {
      // A follower just mounted and wants the current status without
      // waiting for the leader's next natural publish — only the actual
      // leader replies (a follower has nothing useful to relay).
      if (leader && lastStatus) channel.postMessage({ kind: 'status', tabId, status: lastStatus } satisfies ColocationMessage);
      return;
    }
    // 'bye' — the leader announced a clean handoff. Stop showing its now-
    // stale status; the newly-elected leader publishes fresh status
    // shortly after its own lock-acquired promotion.
    setStatus(undefined);
  });

  if (supported && locks?.request) {
    void locks
      .request(leaderLockName, { mode: 'exclusive' }, () => {
        if (closed) return; // closed before the lock was actually granted — release immediately, never promote
        setLeader(true);
        return new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
      })
      .catch(() => {
        // Locks present but the request itself failed (denied, or a mode
        // this UA doesn't support) — degrade to "every tab is its own
        // leader" rather than a tab that can never be promoted.
        setLeader(true);
      });
    // Ask whoever's already leader for their current status, in case this
    // tab mounted after the leader's last periodic publish.
    channel?.postMessage({ kind: 'status-request', tabId } satisfies ColocationMessage);
  }

  return {
    tabId,
    supported,
    isLeader: () => leader,
    onLeaderChange(cb) {
      leaderCbs.add(cb);
      return () => leaderCbs.delete(cb);
    },
    publishStatus(status) {
      if (!leader) return;
      lastStatus = status;
      channel?.postMessage({ kind: 'status', tabId, status } satisfies ColocationMessage);
    },
    latestStatus() {
      if (lastStatus && Date.now() - lastStatus.ts > STATUS_STALE_MS) return undefined;
      return lastStatus;
    },
    onStatusChange(cb) {
      statusCbs.add(cb);
      return () => statusCbs.delete(cb);
    },
    close() {
      if (closed) return;
      closed = true;
      if (leader) channel?.postMessage({ kind: 'bye', tabId } satisfies ColocationMessage);
      channel?.close();
      releaseLock?.();
      leaderCbs.clear();
      statusCbs.clear();
    },
  };
}
