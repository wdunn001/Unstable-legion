/**
 * Rate-limiter tests — the anti-flood core for user-to-user room chat.
 * Pure token-bucket logic driven entirely by an explicit mock clock; no
 * real timers, no `Date.now()`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TokenBucket,
  PerPeerRateLimiter,
  laneForStanding,
  DEFAULT_RATE_LIMIT_CONFIG,
} from '../src/rateLimiter.ts';

// ── laneForStanding: standing-gated ceilings ─────────────────────────────────

test('laneForStanding: monotonic non-decreasing capacity and refill in standing', () => {
  let prevCap = -Infinity;
  let prevRefill = -Infinity;
  for (const score of [-10, -1, 0, 0.5, 1, 2, 5, 8, 12, 18, 40, 1000]) {
    const lane = laneForStanding(score);
    assert.ok(lane.capacity >= prevCap, `capacity monotonic at score ${score}`);
    assert.ok(lane.refillPerMs >= prevRefill, `refill monotonic at score ${score}`);
    prevCap = lane.capacity;
    prevRefill = lane.refillPerMs;
  }
});

test('laneForStanding: a debtor (score 0) gets a strictly smaller lane than a newcomer (score 1)', () => {
  const debt = laneForStanding(0);
  const newcomer = laneForStanding(1);
  assert.ok(newcomer.capacity > debt.capacity || newcomer.refillPerMs > debt.refillPerMs);
});

test('laneForStanding: every lane is strictly positive — degrade, never deny', () => {
  for (const score of [-1000, -1, 0]) {
    const lane = laneForStanding(score);
    assert.ok(lane.capacity >= DEFAULT_RATE_LIMIT_CONFIG.minBurst);
    assert.ok(lane.capacity > 0);
    assert.ok(lane.refillPerMs > 0, 'a debtor still refills, just slowly');
  }
});

test('laneForStanding: clamps at the configured ceilings for very high standing', () => {
  const top = laneForStanding(1_000_000);
  assert.equal(top.capacity, DEFAULT_RATE_LIMIT_CONFIG.maxBurst);
  assert.equal(top.refillPerMs, DEFAULT_RATE_LIMIT_CONFIG.maxRefillPerSec / 1000);
});

// ── TokenBucket: burst + refill ──────────────────────────────────────────────

test('TokenBucket: starts full, allows a burst up to capacity then drops', () => {
  const lane = { capacity: 3, refillPerMs: 1 / 1000 }; // 1 token/sec
  const b = new TokenBucket(lane, 0);
  assert.equal(b.tryConsume(0).allowed, true);
  assert.equal(b.tryConsume(0).allowed, true);
  assert.equal(b.tryConsume(0).allowed, true);
  const dropped = b.tryConsume(0);
  assert.equal(dropped.allowed, false, 'burst exhausted');
  assert.ok(dropped.retryAfterMs > 0);
});

test('TokenBucket: refills at the configured rate over (mock) time', () => {
  const lane = { capacity: 5, refillPerMs: 1 / 1000 }; // 1 token/sec
  const b = new TokenBucket(lane, 0);
  for (let i = 0; i < 5; i++) b.tryConsume(0); // drain
  assert.equal(b.tryConsume(0).allowed, false);
  // 1 second later → exactly one token back.
  assert.equal(b.tryConsume(1000).allowed, true);
  assert.equal(b.tryConsume(1000).allowed, false);
  // 3 seconds later → 3 tokens (capacity not yet hit).
  assert.equal(b.peek(4000), 3);
});

test('TokenBucket: refill never exceeds capacity', () => {
  const lane = { capacity: 4, refillPerMs: 1 / 1000 };
  const b = new TokenBucket(lane, 0);
  b.tryConsume(0);
  // A very long idle → capped at capacity, not capacity + elapsed.
  assert.equal(b.peek(10_000_000), 4);
});

test('TokenBucket: retryAfterMs reflects the deficit at the current refill rate', () => {
  const lane = { capacity: 1, refillPerMs: 1 / 1000 }; // 1 token/sec
  const b = new TokenBucket(lane, 0);
  assert.equal(b.tryConsume(0).allowed, true);
  const r = b.tryConsume(0);
  assert.equal(r.allowed, false);
  assert.equal(r.retryAfterMs, 1000, 'need one full second for one token');
});

test('TokenBucket: setLane preserves fill fraction (no free burst on promotion)', () => {
  const small = { capacity: 2, refillPerMs: 0 }; // no refill, isolate the fraction math
  const b = new TokenBucket(small, 0);
  b.tryConsume(0); // 1 of 2 left → 50% full
  const big = { capacity: 10, refillPerMs: 0 };
  b.setLane(big, 0);
  assert.equal(b.peek(0), 5, '50% of the new capacity, not a full bucket');
});

// ── PerPeerRateLimiter: isolation + flood + standing gating ──────────────────

test('PerPeerRateLimiter: one peer flooding does not consume another peer’s budget', () => {
  const rl = new PerPeerRateLimiter({ standingOf: () => 1 });
  const flooderLane = laneForStanding(1);
  // Drain the flooder.
  let allowedForFlooder = 0;
  for (let i = 0; i < flooderLane.capacity + 5; i++) {
    if (rl.check('flooder', 0).allowed) allowedForFlooder++;
  }
  assert.equal(allowedForFlooder, flooderLane.capacity, 'flooder capped at its own burst');
  assert.equal(rl.check('flooder', 0).allowed, false, 'flooder now throttled');
  // A different peer is completely unaffected.
  assert.equal(rl.check('victim', 0).allowed, true);
});

test('PerPeerRateLimiter: flood drop — excess messages in a burst window are denied', () => {
  const rl = new PerPeerRateLimiter({ standingOf: () => 1 });
  const cap = laneForStanding(1).capacity;
  let allowed = 0;
  let denied = 0;
  for (let i = 0; i < cap + 20; i++) {
    if (rl.check('spammer', 0).allowed) allowed++;
    else denied++;
  }
  assert.equal(allowed, cap);
  assert.equal(denied, 20, 'every message past the burst cap is dropped');
});

test('PerPeerRateLimiter: higher standing buys strictly more chat headroom', () => {
  const scores: Record<string, number> = { newcomer: 1, contributor: 12 };
  const rl = new PerPeerRateLimiter({ standingOf: (p) => scores[p] ?? 0 });
  const count = (peer: string) => {
    let n = 0;
    for (let i = 0; i < 100; i++) if (rl.check(peer, 0).allowed) n++;
    return n;
  };
  const newcomer = count('newcomer');
  const contributor = count('contributor');
  assert.ok(contributor > newcomer, `contributor ${contributor} > newcomer ${newcomer}`);
});

test('PerPeerRateLimiter: a debtor is throttled harder than a newcomer but still eventually served', () => {
  const scores: Record<string, number> = { debtor: 0, newcomer: 1 };
  const rl = new PerPeerRateLimiter({ standingOf: (p) => scores[p] ?? 0 });
  const burst = (peer: string) => {
    let n = 0;
    for (let i = 0; i < 100; i++) if (rl.check(peer, 0).allowed) n++;
    return n;
  };
  const debtorBurst = burst('debtor');
  const newcomerBurst = burst('newcomer');
  assert.ok(debtorBurst <= newcomerBurst, 'debtor burst ≤ newcomer burst');
  // Even fully drained, the debtor recovers a token with enough time → never a hard block.
  const rl2 = new PerPeerRateLimiter({ standingOf: () => 0 });
  for (let i = 0; i < 50; i++) rl2.check('debtor', 0);
  assert.equal(rl2.check('debtor', 0).allowed, false, 'drained now');
  assert.equal(rl2.check('debtor', 60_000).allowed, true, 'served after a minute — degrade, not deny');
});

test('PerPeerRateLimiter: peek does not spend a token', () => {
  const rl = new PerPeerRateLimiter({ standingOf: () => 1 });
  const before = rl.peek('p', 0);
  rl.peek('p', 0);
  rl.peek('p', 0);
  assert.equal(rl.peek('p', 0), before, 'peek is side-effect free');
  assert.equal(rl.check('p', 0).allowed, true, 'a real check still succeeds');
});

test('PerPeerRateLimiter: forget clears a peer’s bucket', () => {
  const rl = new PerPeerRateLimiter({ standingOf: () => 1 });
  const cap = laneForStanding(1).capacity;
  for (let i = 0; i < cap; i++) rl.check('p', 0);
  assert.equal(rl.check('p', 0).allowed, false);
  rl.forget('p');
  assert.equal(rl.check('p', 0).allowed, true, 'a forgotten peer starts fresh');
});
