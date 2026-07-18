/**
 * colocation.ts unit tests — same-origin tab leader election + status
 * relay, and the localStorage-backed failure-domain id. No React
 * rendering needed (the coordinator itself is framework-free); a fake
 * `BroadcastChannel` (in-memory pub/sub keyed by channel name, mirroring
 * the real API's "never echoes to self" semantics) and a fake
 * `LockManager` (FIFO exclusive-lock queue per lock name) drive it
 * directly, simulating multiple same-origin "tabs".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getOrCreateFailureDomainId, createColocationCoordinator, type SharedHostStatus } from '../src/colocation.ts';

// ── Fakes ─────────────────────────────────────────────────────────────

class FakeStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/** In-memory BroadcastChannel: every instance sharing a `name` sees every
 * OTHER instance's `postMessage` (never its own — matches the real API). */
class FakeBroadcastChannel {
  static bus = new Map<string, Set<FakeBroadcastChannel>>();
  name: string;
  private listeners = new Set<(ev: { data: unknown }) => void>();
  private closed = false;
  constructor(name: string) {
    this.name = name;
    const set = FakeBroadcastChannel.bus.get(name) ?? new Set();
    set.add(this);
    FakeBroadcastChannel.bus.set(name, set);
  }
  postMessage(data: unknown): void {
    if (this.closed) return;
    const set = FakeBroadcastChannel.bus.get(this.name);
    if (!set) return;
    for (const ch of set) {
      if (ch === this || ch.closed) continue;
      for (const cb of ch.listeners) cb({ data });
    }
  }
  addEventListener(type: string, cb: (ev: { data: unknown }) => void): void {
    if (type === 'message') this.listeners.add(cb);
  }
  removeEventListener(type: string, cb: (ev: { data: unknown }) => void): void {
    this.listeners.delete(cb);
  }
  close(): void {
    this.closed = true;
    FakeBroadcastChannel.bus.get(this.name)?.delete(this);
  }
}

/** Minimal exclusive-lock FIFO queue per lock name — mirrors the ONLY
 * behavior `colocation.ts` depends on: exactly one holder at a time,
 * granted in request order, next waiter promoted once the holder's
 * callback-returned promise resolves. */
class FakeLockManager {
  private held = new Set<string>();
  private queues = new Map<string, Array<() => void>>();
  request(name: string, _opts: unknown, callback: () => Promise<void> | void): Promise<void> {
    return new Promise((resolveOuter, rejectOuter) => {
      const attempt = (): void => {
        this.held.add(name);
        // Real Web Locks `request()` ALWAYS grants asynchronously (a
        // microtask at the very least), even when the lock is
        // immediately free — deferring here (rather than invoking
        // `callback()` synchronously) mirrors that so a consumer
        // subscribing to `onLeaderChange` right after calling
        // `createColocationCoordinator()` (the normal usage pattern)
        // never misses the very first grant.
        queueMicrotask(() => {
          void Promise.resolve(callback())
            .then(() => resolveOuter())
            .catch((err) => rejectOuter(err))
            .finally(() => {
              this.held.delete(name);
              const queue = this.queues.get(name);
              const next = queue?.shift();
              if (next) next();
            });
        });
      };
      if (!this.held.has(name)) {
        attempt();
      } else {
        const queue = this.queues.get(name) ?? [];
        this.queues.set(name, queue);
        queue.push(attempt);
      }
    });
  }
}

function tick(n = 1): Promise<void> {
  return new Promise((resolve) => {
    let i = 0;
    const step = (): void => {
      i += 1;
      if (i >= n) resolve();
      else setTimeout(step, 0);
    };
    setTimeout(step, 0);
  });
}

function baseStatus(overrides: Partial<SharedHostStatus> = {}): SharedHostStatus {
  return {
    phase: 'active',
    claim: { layerStart: 2, layerEnd: 13, includeOutput: false },
    active: true,
    sessionCount: 1,
    tokensDecoded: 42,
    maxSessions: 4,
    queueLength: 0,
    retrying: false,
    retryAttempt: 0,
    ts: Date.now(),
    ...overrides,
  };
}

// ── getOrCreateFailureDomainId ───────────────────────────────────────────

test('getOrCreateFailureDomainId: mints once and persists across calls with the same storage (simulates a page reload)', () => {
  const storage = new FakeStorage();
  const first = getOrCreateFailureDomainId(storage);
  const second = getOrCreateFailureDomainId(storage);
  assert.ok(first);
  assert.equal(first, second);
});

test('getOrCreateFailureDomainId: different storage instances (different profiles) mint different ids', () => {
  const a = getOrCreateFailureDomainId(new FakeStorage());
  const b = getOrCreateFailureDomainId(new FakeStorage());
  assert.notEqual(a, b);
});

test('getOrCreateFailureDomainId: unavailable storage -> undefined, never throws', () => {
  assert.equal(getOrCreateFailureDomainId(undefined), undefined);
});

// ── createColocationCoordinator: unsupported environment ────────────────

test('createColocationCoordinator: no locks (Web Locks unsupported) -> unsupported, unconditionally its own leader', () => {
  // NOTE: both overrides are pinned to non-undefined stand-ins, even the
  // "absent" one — Node 18+/21+ ship REAL globals for both
  // `BroadcastChannel` and `navigator.locks`, and `opts.x ?? (global
  // fallback)` can't distinguish "caller explicitly passed undefined"
  // from "caller omitted the option" (`??` treats both the same). Passing
  // literal `undefined` here would silently fall through to Node's REAL
  // implementations — a real BroadcastChannel is a genuine open handle
  // that can hang the process if never closed, and a real Web Lock grant
  // is real PROCESS-GLOBAL state outliving this one test. An empty
  // `locks` stand-in (no `.request` method) proves "unsupported"
  // (`supported` requires a callable `.request`) without touching either
  // real global.
  const coordinator = createColocationCoordinator({
    BroadcastChannelCtor: FakeBroadcastChannel as unknown as typeof BroadcastChannel,
    locks: {} as unknown as LockManager,
  });
  assert.equal(coordinator.supported, false);
  assert.equal(coordinator.isLeader(), true);
  coordinator.close();
});

// ── Leader election across simulated "tabs" ──────────────────────────────

test('createColocationCoordinator: first tab to request the lock becomes leader; a second sibling tab is a follower', async () => {
  const locks = new FakeLockManager();
  const tabA = createColocationCoordinator({ BroadcastChannelCtor: FakeBroadcastChannel as unknown as typeof BroadcastChannel, locks: locks as unknown as LockManager, tabId: 'tabA' });
  const tabB = createColocationCoordinator({ BroadcastChannelCtor: FakeBroadcastChannel as unknown as typeof BroadcastChannel, locks: locks as unknown as LockManager, tabId: 'tabB' });
  await tick(3);
  assert.equal(tabA.supported, true);
  assert.equal(tabA.isLeader(), true);
  assert.equal(tabB.isLeader(), false);
  tabA.close();
  tabB.close();
});

test('createColocationCoordinator: onLeaderChange fires exactly once for the winner, never for the loser (while both stay open)', async () => {
  const locks = new FakeLockManager();
  const events: boolean[] = [];
  const tabA = createColocationCoordinator({ BroadcastChannelCtor: FakeBroadcastChannel as unknown as typeof BroadcastChannel, locks: locks as unknown as LockManager, tabId: 'tabA' });
  tabA.onLeaderChange((leader) => events.push(leader));
  const tabB = createColocationCoordinator({ BroadcastChannelCtor: FakeBroadcastChannel as unknown as typeof BroadcastChannel, locks: locks as unknown as LockManager, tabId: 'tabB' });
  const bEvents: boolean[] = [];
  tabB.onLeaderChange((leader) => bEvents.push(leader));
  await tick(3);
  assert.deepEqual(events, [true]);
  assert.deepEqual(bEvents, []); // tabB never became leader while tabA holds the lock
  tabA.close();
  tabB.close();
});

// ── Status relay ──────────────────────────────────────────────────────

test('createColocationCoordinator: the leader publishing status is mirrored by a follower', async () => {
  const locks = new FakeLockManager();
  const tabA = createColocationCoordinator({ BroadcastChannelCtor: FakeBroadcastChannel as unknown as typeof BroadcastChannel, locks: locks as unknown as LockManager, tabId: 'tabA' });
  const tabB = createColocationCoordinator({ BroadcastChannelCtor: FakeBroadcastChannel as unknown as typeof BroadcastChannel, locks: locks as unknown as LockManager, tabId: 'tabB' });
  await tick(3);

  let notified = 0;
  tabB.onStatusChange(() => (notified += 1));
  const status = baseStatus({ phase: 'active', claim: { layerStart: 2, layerEnd: 13, includeOutput: false } });
  tabA.publishStatus(status);

  assert.equal(notified, 1);
  assert.deepEqual(tabB.latestStatus(), status);
  tabA.close();
  tabB.close();
});

test('createColocationCoordinator: publishStatus called by a follower is a no-op (never corrupts the shared status)', async () => {
  const locks = new FakeLockManager();
  const tabA = createColocationCoordinator({ BroadcastChannelCtor: FakeBroadcastChannel as unknown as typeof BroadcastChannel, locks: locks as unknown as LockManager, tabId: 'tabA' });
  const tabB = createColocationCoordinator({ BroadcastChannelCtor: FakeBroadcastChannel as unknown as typeof BroadcastChannel, locks: locks as unknown as LockManager, tabId: 'tabB' });
  await tick(3);

  const leaderStatus = baseStatus({ phase: 'active' });
  tabA.publishStatus(leaderStatus);
  assert.deepEqual(tabB.latestStatus(), leaderStatus);

  // tabB (a follower) tries to publish its own status — must be ignored:
  // no BroadcastChannel message is even sent (publishStatus no-ops before
  // touching the channel), so tabA (the real leader, tracking its OWN
  // last-published status) sees no change, and tabB's own mirrored copy
  // of tabA's status is untouched too.
  tabB.publishStatus(baseStatus({ phase: 'error', errorMessage: 'should never surface' }));
  assert.deepEqual(tabA.latestStatus(), leaderStatus); // unaffected — still tabA's own last publish
  assert.deepEqual(tabB.latestStatus(), leaderStatus); // tabB's own (ignored) publish didn't even change its OWN mirrored copy

  tabA.close();
  tabB.close();
});

test('createColocationCoordinator: a freshly-mounted follower immediately requests and receives the current status (no wait for the next natural publish)', async () => {
  const locks = new FakeLockManager();
  const tabA = createColocationCoordinator({ BroadcastChannelCtor: FakeBroadcastChannel as unknown as typeof BroadcastChannel, locks: locks as unknown as LockManager, tabId: 'tabA' });
  await tick(2);
  const status = baseStatus({ phase: 'active' });
  tabA.publishStatus(status);

  // tabB mounts LATER, after tabA already settled into leadership and
  // already published once — it should still get the current status via
  // its own status-request round-trip, not have to wait for tabA's next
  // spontaneous change.
  const tabB = createColocationCoordinator({ BroadcastChannelCtor: FakeBroadcastChannel as unknown as typeof BroadcastChannel, locks: locks as unknown as LockManager, tabId: 'tabB' });
  await tick(2);
  assert.deepEqual(tabB.latestStatus(), status);

  tabA.close();
  tabB.close();
});

// ── Failover ──────────────────────────────────────────────────────────

test('createColocationCoordinator: leader tab closing promotes the next waiting tab, and clears the stale status via "bye"', async () => {
  const locks = new FakeLockManager();
  const tabA = createColocationCoordinator({ BroadcastChannelCtor: FakeBroadcastChannel as unknown as typeof BroadcastChannel, locks: locks as unknown as LockManager, tabId: 'tabA' });
  const tabB = createColocationCoordinator({ BroadcastChannelCtor: FakeBroadcastChannel as unknown as typeof BroadcastChannel, locks: locks as unknown as LockManager, tabId: 'tabB' });
  await tick(3);
  assert.equal(tabA.isLeader(), true);
  assert.equal(tabB.isLeader(), false);

  tabA.publishStatus(baseStatus({ phase: 'active' }));
  assert.ok(tabB.latestStatus());

  tabA.close(); // simulates the leader tab closing
  await tick(3);

  assert.equal(tabB.isLeader(), true); // failover: tabB promoted
  assert.equal(tabB.latestStatus(), undefined); // stale status cleared by tabA's 'bye'

  tabB.close();
});
