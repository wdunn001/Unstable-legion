/**
 * Traffic limiting / anti-flood for the user-to-user room chat.
 *
 * Pure + deterministic — every method that needs "now" takes it explicitly
 * (never `Date.now()` internally), so the whole module is a pure function
 * of its inputs and its own prior writes, exactly as testable as
 * `standing.ts` (same discipline, same reasons). A mock clock in the tests
 * exercises refill/burst edges with zero real-time sleeps.
 *
 * Design (a deliberate echo of `standing.ts`'s economy philosophy —
 * "degrade, don't deny"):
 *
 *   - A classic token bucket per peer: `capacity` tokens (the burst cap),
 *     refilled at `refillPerSec`. Each chat message costs one token. Empty
 *     bucket ⇒ the message is dropped (inbound) or soft-rejected with a
 *     `retryAfterMs` (outbound) — NEVER a ban, never a permanent block.
 *   - Standing-gated ceilings: a peer's bucket size + refill scale with its
 *     contribution standing (the `priorityScore` from `standing.ts`).
 *     Established contributors get more chat headroom; brand-new peers get
 *     the newcomer allotment; a peer running a standing debt gets the
 *     smallest lane — but every lane is strictly > 0. A newcomer always
 *     outranks a debtor and is always still served (matches AI Horde's
 *     anonymous-lane rule the economy is modelled on).
 *
 * This module does NOT itself read the ledger — the caller passes the
 * already-computed standing score (keeps the limiter a leaf with no
 * dependency on `standing.ts`, so either can be tested in isolation).
 */

// ── Standing → lane mapping ────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Burst cap for a peer at the LOWEST lane (standing debt / score ≤ 0). */
  minBurst: number;
  /** Burst cap ceiling — no peer, however high its standing, exceeds this. */
  maxBurst: number;
  /** Refill (tokens/sec) at the LOWEST lane. Strictly > 0 — a debtor still
   * drains their bucket and recovers, just slowly. */
  minRefillPerSec: number;
  /** Refill ceiling (tokens/sec). */
  maxRefillPerSec: number;
  /** Burst added per unit of standing score above zero (before clamping). */
  burstPerStanding: number;
  /** Refill (tokens/sec) added per unit of standing score above zero. */
  refillPerStanding: number;
}

/**
 * Default lanes, tuned for human chat cadence (not machine traffic):
 *
 *   score 0   (debt)      → burst 2,  refill 0.50/s
 *   score 1   (newcomer)  → burst 3,  refill 0.75/s
 *   score 8   (regular)   → burst 10, refill 2.50/s
 *   score ≥18 (top)       → burst 20, refill 5.00/s (clamped)
 *
 * Monotonic in standing, every lane strictly positive.
 */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  minBurst: 2,
  maxBurst: 20,
  minRefillPerSec: 0.5,
  maxRefillPerSec: 5,
  burstPerStanding: 1,
  refillPerStanding: 0.25,
};

export interface Lane {
  /** Bucket capacity (max tokens = burst cap). */
  capacity: number;
  /** Refill rate in tokens per millisecond. */
  refillPerMs: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Map a standing score (from `standing.ts`'s `priorityScore`) to a rate
 * lane. Negative / zero scores collapse to the lowest lane; the mapping is
 * monotonic non-decreasing in score and every lane is strictly positive
 * (degrade, never deny).
 */
export function laneForStanding(
  score: number,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT_CONFIG,
): Lane {
  const s = Math.max(0, score);
  const capacity = clamp(
    Math.round(config.minBurst + s * config.burstPerStanding),
    config.minBurst,
    config.maxBurst,
  );
  const refillPerSec = clamp(
    config.minRefillPerSec + s * config.refillPerStanding,
    config.minRefillPerSec,
    config.maxRefillPerSec,
  );
  return { capacity, refillPerMs: refillPerSec / 1000 };
}

// ── Token bucket ────────────────────────────────────────────────────────────

export interface TokenBucketState {
  /** Current token count (fractional — refill is continuous). */
  tokens: number;
  /** Last `now` the bucket was refilled to. */
  lastRefill: number;
  /** The lane this bucket is currently sized to. */
  lane: Lane;
}

export interface ConsumeResult {
  /** True ⇒ the message is allowed; a token was spent. */
  allowed: boolean;
  /** Tokens left after this call (post-refill, post-spend). */
  remaining: number;
  /** When `allowed` is false, the ms until ONE token is available again. */
  retryAfterMs: number;
}

/** Refill a bucket up to `now`, never exceeding its capacity. Pure. */
function refill(state: TokenBucketState, now: number): void {
  const elapsed = Math.max(0, now - state.lastRefill);
  if (elapsed > 0) {
    state.tokens = Math.min(state.lane.capacity, state.tokens + elapsed * state.lane.refillPerMs);
    state.lastRefill = now;
  }
}

/**
 * A single peer's token bucket. `now` is always injected. Re-sizing the
 * lane (because the peer's standing changed) preserves the *fraction* of
 * the bucket that was full, so a peer moving up a lane doesn't get an
 * instant free burst, and one moving down doesn't lose everything it had.
 */
export class TokenBucket {
  private state: TokenBucketState;

  constructor(lane: Lane, now: number, startFull = true) {
    this.state = {
      tokens: startFull ? lane.capacity : 0,
      lastRefill: now,
      lane,
    };
  }

  /** Update the lane (standing changed). Keeps the current fill fraction. */
  setLane(lane: Lane, now: number): void {
    refill(this.state, now);
    const prevCap = this.state.lane.capacity;
    const frac = prevCap > 0 ? this.state.tokens / prevCap : 1;
    this.state.lane = lane;
    this.state.tokens = clamp(frac * lane.capacity, 0, lane.capacity);
  }

  /** Try to spend `cost` tokens at `now`. Never throws, never blocks. */
  tryConsume(now: number, cost = 1): ConsumeResult {
    refill(this.state, now);
    if (this.state.tokens >= cost) {
      this.state.tokens -= cost;
      return { allowed: true, remaining: this.state.tokens, retryAfterMs: 0 };
    }
    const deficit = cost - this.state.tokens;
    const retryAfterMs =
      this.state.lane.refillPerMs > 0 ? Math.ceil(deficit / this.state.lane.refillPerMs) : Infinity;
    return { allowed: false, remaining: this.state.tokens, retryAfterMs };
  }

  /** Current token count (post-refill to `now`). For UI / tests. */
  peek(now: number): number {
    refill(this.state, now);
    return this.state.tokens;
  }
}

// ── Per-peer limiter ─────────────────────────────────────────────────────────

export interface PerPeerRateLimiterOptions {
  config?: RateLimitConfig;
  /**
   * How a peer's standing score is resolved at check time. Optional — when
   * absent, every peer sits in the newcomer lane (`laneForStanding(1)`),
   * which is exactly the behaviour a deployment with no economy wired gets.
   */
  standingOf?: (peerId: string) => number;
  /** Evict a peer's bucket after this many ms of no activity (memory hygiene
   * for long-lived rooms). Default 10 min. `0` disables eviction. */
  idleEvictMs?: number;
}

/**
 * One bucket per peer, sized to that peer's standing lane. Used for BOTH
 * directions: an outbound limiter keyed on `selfId`, and an inbound limiter
 * keyed on each sender's peerId. A flooding peer simply runs its own bucket
 * dry and its excess messages are dropped — no shared state to exhaust, no
 * ban list to maintain.
 */
export class PerPeerRateLimiter {
  private readonly buckets = new Map<string, { bucket: TokenBucket; lastSeen: number }>();
  private readonly config: RateLimitConfig;
  private readonly standingOf: (peerId: string) => number;
  private readonly idleEvictMs: number;

  constructor(opts: PerPeerRateLimiterOptions = {}) {
    this.config = opts.config ?? DEFAULT_RATE_LIMIT_CONFIG;
    this.standingOf = opts.standingOf ?? (() => 1); // newcomer lane by default
    this.idleEvictMs = opts.idleEvictMs ?? 10 * 60_000;
  }

  /** Try to admit one message from/to `peerId` at `now`. */
  check(peerId: string, now: number, cost = 1): ConsumeResult {
    this.evictIdle(now);
    const lane = laneForStanding(this.standingOf(peerId), this.config);
    let entry = this.buckets.get(peerId);
    if (!entry) {
      entry = { bucket: new TokenBucket(lane, now, true), lastSeen: now };
      this.buckets.set(peerId, entry);
    } else {
      entry.bucket.setLane(lane, now);
      entry.lastSeen = now;
    }
    return entry.bucket.tryConsume(now, cost);
  }

  /** Peek a peer's available tokens (post-refill) — UI "you're sending too
   * fast" affordances read this without spending. */
  peek(peerId: string, now: number): number {
    const entry = this.buckets.get(peerId);
    if (!entry) return laneForStanding(this.standingOf(peerId), this.config).capacity;
    entry.bucket.setLane(laneForStanding(this.standingOf(peerId), this.config), now);
    return entry.bucket.peek(now);
  }

  /** Forget a peer entirely (e.g. on `onPeerLeave`). */
  forget(peerId: string): void {
    this.buckets.delete(peerId);
  }

  private evictIdle(now: number): void {
    if (this.idleEvictMs <= 0) return;
    for (const [peerId, entry] of this.buckets) {
      if (now - entry.lastSeen > this.idleEvictMs) this.buckets.delete(peerId);
    }
  }
}
