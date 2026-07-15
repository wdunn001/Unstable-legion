/**
 * M2 — pure admission/queue/idle-evict state machine for a multi-session
 * stage host. Deliberately has NO I/O, NO Date.now() calls, and NO
 * dependency on `useStageHost.ts`'s React/worker/mesh plumbing — every
 * function takes `now` explicitly so tests can drive it with a mock
 * clock (see `test/stageSessionAdmission.test.ts`). `useStageHost.ts`
 * wires these functions to actual session state + a `Date.now()`-fed
 * timer; this module only decides WHAT should happen, never DOES it.
 *
 * Policy this implements (see the M2 workstream brief):
 *   - admit immediately while `activeCount < maxSessions`.
 *   - otherwise enqueue, bounded (`DEFAULT_QUEUE_CAP`) and TTL'd
 *     (`DEFAULT_QUEUE_TTL_MS`) — a request older than the TTL is treated
 *     as abandoned and dropped rather than admitted stale.
 *   - a freed lane pulls the next queued entry by `priorityScore(peerId)`
 *     (highest first, FIFO among ties) — defaults to `() => 0` (pure
 *     FIFO) until a future milestone wires real prioritization.
 *   - a session idle longer than `DEFAULT_IDLE_EVICT_MS` (no `sf` frame
 *     seen) is evictable — `useStageHost.ts` sends `stage.stop` with an
 *     idle-evicted reason and frees the lane.
 */

export const DEFAULT_QUEUE_CAP = 16;
export const DEFAULT_QUEUE_TTL_MS = 30_000;
export const DEFAULT_IDLE_EVICT_MS = 5 * 60_000;

export interface QueueEntry<TRequest = unknown> {
  readonly sessionId: string;
  readonly peerId: string;
  readonly enqueuedAt: number;
  readonly request: TRequest;
}

export type PriorityScoreFn = (peerId: string) => number;

/** `activeCount < maxSessions` — nothing more than that, but named so
 * call sites read as policy, not arithmetic. */
export function canAdmitNow(activeCount: number, maxSessions: number): boolean {
  return activeCount < maxSessions;
}

export interface EnqueueResult<TRequest> {
  queue: readonly QueueEntry<TRequest>[];
  accepted: boolean;
  /** 1-based position in the queue immediately after insertion (only
   * meaningful when `accepted`). */
  queuePosition?: number;
}

/** Append `entry` to `queue` unless it's already at `cap`. Never mutates
 * the input array — every function here returns a fresh array, so a
 * caller can hold the previous snapshot for logging/diffing if it wants. */
export function enqueue<TRequest>(
  queue: readonly QueueEntry<TRequest>[],
  entry: QueueEntry<TRequest>,
  cap: number = DEFAULT_QUEUE_CAP,
): EnqueueResult<TRequest> {
  if (queue.length >= cap) {
    return { queue, accepted: false };
  }
  const next = [...queue, entry];
  return { queue: next, accepted: true, queuePosition: next.length };
}

export interface ExpireResult<TRequest> {
  queue: readonly QueueEntry<TRequest>[];
  expired: readonly QueueEntry<TRequest>[];
}

/** Split `queue` into (still-alive, expired-by-TTL) at wall-clock `now`.
 * Order-preserving for the surviving entries. */
export function expireQueue<TRequest>(
  queue: readonly QueueEntry<TRequest>[],
  now: number,
  ttlMs: number = DEFAULT_QUEUE_TTL_MS,
): ExpireResult<TRequest> {
  const alive: QueueEntry<TRequest>[] = [];
  const expired: QueueEntry<TRequest>[] = [];
  for (const entry of queue) {
    if (now - entry.enqueuedAt > ttlMs) expired.push(entry);
    else alive.push(entry);
  }
  return { queue: alive, expired };
}

export interface PopResult<TRequest> {
  queue: readonly QueueEntry<TRequest>[];
  next?: QueueEntry<TRequest>;
}

/** Remove and return the highest-`priorityScore` entry (ties broken by
 * earliest `enqueuedAt`, i.e. FIFO — `queue` is scanned in order and a
 * later entry only displaces the current best on a STRICT improvement).
 * Returns `next: undefined` for an empty queue (no-op). */
export function popNextByPriority<TRequest>(
  queue: readonly QueueEntry<TRequest>[],
  priorityScore: PriorityScoreFn = () => 0,
): PopResult<TRequest> {
  if (queue.length === 0) return { queue };
  let bestIdx = 0;
  let bestScore = priorityScore(queue[0]!.peerId);
  for (let i = 1; i < queue.length; i++) {
    const score = priorityScore(queue[i]!.peerId);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  const next = queue[bestIdx]!;
  const rest = [...queue.slice(0, bestIdx), ...queue.slice(bestIdx + 1)];
  return { queue: rest, next };
}

/** True when `lastFrameAt` (last inbound `sf` frame for this session) is
 * more than `idleMs` behind `now`. */
export function isSessionIdle(lastFrameAt: number, now: number, idleMs: number = DEFAULT_IDLE_EVICT_MS): boolean {
  return now - lastFrameAt > idleMs;
}
