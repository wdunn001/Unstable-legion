/**
 * Pure unit tests for `stageSessionAdmission.ts` — admission, bounded/TTL'd
 * queue, priority-ordered pop, idle-eviction. No React, no worker, no
 * mesh — every test drives an explicit mock clock (`now`), never
 * `Date.now()`, so timing assertions are deterministic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canAdmitNow,
  enqueue,
  expireQueue,
  popNextByPriority,
  isSessionIdle,
  DEFAULT_QUEUE_CAP,
  DEFAULT_QUEUE_TTL_MS,
  DEFAULT_IDLE_EVICT_MS,
  type QueueEntry,
} from '../src/stageSessionAdmission.ts';

function entry(sessionId: string, peerId: string, enqueuedAt: number): QueueEntry<{ note: string }> {
  return { sessionId, peerId, enqueuedAt, request: { note: `req-${sessionId}` } };
}

// ── canAdmitNow ──────────────────────────────────────────────────────────

test('canAdmitNow: true while under the ceiling, false at/over it', () => {
  assert.equal(canAdmitNow(0, 4), true);
  assert.equal(canAdmitNow(3, 4), true);
  assert.equal(canAdmitNow(4, 4), false);
  assert.equal(canAdmitNow(5, 4), false);
  assert.equal(canAdmitNow(0, 1), true); // the always-legal single-session case
});

// ── enqueue ──────────────────────────────────────────────────────────────

test('enqueue: accepts under cap and reports 1-based queuePosition', () => {
  let queue: readonly QueueEntry[] = [];
  const r1 = enqueue(queue, entry('s1', 'p1', 0), 3);
  assert.equal(r1.accepted, true);
  assert.equal(r1.queuePosition, 1);
  queue = r1.queue;

  const r2 = enqueue(queue, entry('s2', 'p2', 10), 3);
  assert.equal(r2.accepted, true);
  assert.equal(r2.queuePosition, 2);
  queue = r2.queue;
  assert.equal(queue.length, 2);
});

test('enqueue: rejects once the queue is at cap, queue left unchanged', () => {
  let queue: readonly QueueEntry[] = [];
  queue = enqueue(queue, entry('s1', 'p1', 0), 2).queue;
  queue = enqueue(queue, entry('s2', 'p2', 0), 2).queue;
  const r3 = enqueue(queue, entry('s3', 'p3', 0), 2);
  assert.equal(r3.accepted, false);
  assert.equal(r3.queue, queue); // same reference — no-op on reject
  assert.equal(r3.queue.length, 2);
});

test('enqueue: default cap matches DEFAULT_QUEUE_CAP (16)', () => {
  let queue: readonly QueueEntry[] = [];
  for (let i = 0; i < DEFAULT_QUEUE_CAP; i++) {
    const r = enqueue(queue, entry(`s${i}`, `p${i}`, 0));
    assert.equal(r.accepted, true);
    queue = r.queue;
  }
  const overflow = enqueue(queue, entry('overflow', 'p-of', 0));
  assert.equal(overflow.accepted, false);
});

test('enqueue never mutates the input array', () => {
  const original: readonly QueueEntry[] = [entry('s1', 'p1', 0)];
  const snapshot = [...original];
  enqueue(original, entry('s2', 'p2', 0), 8);
  assert.deepEqual(original, snapshot);
});

// ── expireQueue ──────────────────────────────────────────────────────────

test('expireQueue: drops entries older than the TTL, keeps the rest, preserves order', () => {
  const queue: readonly QueueEntry[] = [entry('s1', 'p1', 0), entry('s2', 'p2', 5_000), entry('s3', 'p3', 29_000)];
  const now = 31_000; // TTL 30_000 -> s1 (age 31000) expired, s2 (age 26000) alive, s3 (age 2000) alive
  const { queue: alive, expired } = expireQueue(queue, now, DEFAULT_QUEUE_TTL_MS);
  assert.deepEqual(alive.map((e) => e.sessionId), ['s2', 's3']);
  assert.deepEqual(expired.map((e) => e.sessionId), ['s1']);
});

test('expireQueue: exactly-at-TTL is NOT expired (strict greater-than)', () => {
  const queue: readonly QueueEntry[] = [entry('s1', 'p1', 0)];
  const { queue: alive, expired } = expireQueue(queue, 30_000, 30_000);
  assert.equal(alive.length, 1);
  assert.equal(expired.length, 0);
});

test('expireQueue: empty queue is a no-op', () => {
  const { queue, expired } = expireQueue([], 100_000, DEFAULT_QUEUE_TTL_MS);
  assert.equal(queue.length, 0);
  assert.equal(expired.length, 0);
});

// ── popNextByPriority ────────────────────────────────────────────────────

test('popNextByPriority: default priority (all zero) is pure FIFO', () => {
  const queue: readonly QueueEntry[] = [entry('s1', 'p1', 0), entry('s2', 'p2', 10), entry('s3', 'p3', 20)];
  const { next, queue: rest } = popNextByPriority(queue);
  assert.equal(next?.sessionId, 's1');
  assert.deepEqual(rest.map((e) => e.sessionId), ['s2', 's3']);
});

test('popNextByPriority: highest score wins regardless of queue position', () => {
  const queue: readonly QueueEntry[] = [entry('s1', 'low', 0), entry('s2', 'high', 10), entry('s3', 'mid', 20)];
  const score = (peerId: string) => (peerId === 'low' ? 0 : peerId === 'mid' ? 5 : 10);
  const { next, queue: rest } = popNextByPriority(queue, score);
  assert.equal(next?.sessionId, 's2'); // 'high' peer
  assert.deepEqual(rest.map((e) => e.sessionId), ['s1', 's3']);
});

test('popNextByPriority: ties broken by FIFO (earliest enqueuedAt, i.e. first in array)', () => {
  const queue: readonly QueueEntry[] = [entry('s1', 'a', 0), entry('s2', 'b', 10)];
  const { next } = popNextByPriority(queue, () => 7); // equal scores
  assert.equal(next?.sessionId, 's1'); // first entry wins ties (strict > required to displace)
});

test('popNextByPriority: empty queue returns next=undefined, queue unchanged', () => {
  const { next, queue } = popNextByPriority([]);
  assert.equal(next, undefined);
  assert.equal(queue.length, 0);
});

// ── isSessionIdle ────────────────────────────────────────────────────────

test('isSessionIdle: false before the idle window, true after', () => {
  const lastFrameAt = 1_000;
  assert.equal(isSessionIdle(lastFrameAt, lastFrameAt + DEFAULT_IDLE_EVICT_MS, DEFAULT_IDLE_EVICT_MS), false); // exactly at boundary
  assert.equal(isSessionIdle(lastFrameAt, lastFrameAt + DEFAULT_IDLE_EVICT_MS + 1, DEFAULT_IDLE_EVICT_MS), true);
  assert.equal(isSessionIdle(lastFrameAt, lastFrameAt + 1_000, DEFAULT_IDLE_EVICT_MS), false);
});

// ── Combined admission/queue/idle-evict scenario (the shape useStageHost.ts drives) ──

test('scenario: at capacity -> enqueue -> a session frees -> next queued entry is admitted by priority', () => {
  const maxSessions = 2;
  let activeCount = 2; // full
  let queue: readonly QueueEntry[] = [];

  // Two more open requests arrive while full.
  queue = enqueue(queue, entry('s3', 'peer-late', 0), DEFAULT_QUEUE_CAP).queue;
  queue = enqueue(queue, entry('s4', 'peer-vip', 100), DEFAULT_QUEUE_CAP).queue;
  assert.equal(canAdmitNow(activeCount, maxSessions), false);

  // A session frees (explicit stop / idle-evict / roster-leave).
  activeCount -= 1;
  assert.equal(canAdmitNow(activeCount, maxSessions), true);

  // VIP peer has priority 10, the late one 0 — VIP should be admitted
  // first even though it queued second.
  const priorityScore = (peerId: string) => (peerId === 'peer-vip' ? 10 : 0);
  const { next, queue: afterPop } = popNextByPriority(queue, priorityScore);
  assert.equal(next?.sessionId, 's4');
  queue = afterPop;
  activeCount += 1;

  assert.equal(canAdmitNow(activeCount, maxSessions), false); // full again
  assert.deepEqual(queue.map((e) => e.sessionId), ['s3']); // late request still waiting
});

test('scenario: a queued request outlives the TTL and is dropped, never admitted', () => {
  let queue: readonly QueueEntry[] = [];
  queue = enqueue(queue, entry('stale', 'peer-x', 0), DEFAULT_QUEUE_CAP).queue;
  const now = DEFAULT_QUEUE_TTL_MS + 1;
  const { queue: alive, expired } = expireQueue(queue, now, DEFAULT_QUEUE_TTL_MS);
  assert.equal(alive.length, 0);
  assert.equal(expired.length, 1);
  assert.equal(expired[0]!.sessionId, 'stale');
  // A freed lane afterward has nothing left to admit.
  const { next } = popNextByPriority(alive);
  assert.equal(next, undefined);
});
