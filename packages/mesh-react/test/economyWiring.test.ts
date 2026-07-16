/**
 * M4 wiring — telemetry -> ledger -> priority, exercised end to end with
 * the SAME math `useStageHost.ts`'s `freeSession` (consumption debit) and
 * `useCommunalChat.ts`'s `recordSegmentTelemetry` (service credit) compute,
 * fed through `bindPriorityScore` into the exact consumers those hooks
 * wire it to: `stageSessionAdmission.popNextByPriority` (host admission
 * queue) and `communalTopology.ts`'s `rankCandidates`/`spreadPick` (via
 * `planCommunalRoute`, mesh-core). No React rendering needed — this proves
 * the WIRING (does a recorded session actually move the priority a
 * consumer of the ledger sees), not the hooks' own React lifecycle, which
 * this repo has no jsdom/testing-library harness for (see the mesh-react
 * package's existing `resolveCommunalShardPlan` precedent: pull the pure
 * logic out and test IT directly).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StandingLedger, bindPriorityScore, buildCommunalTopology, planCommunalRoute } from '@unstable-legion/core';
import { popNextByPriority, type QueueEntry } from '../src/stageSessionAdmission.ts';

// ── Host-side: useStageHost.ts's freeSession telemetry -> admission queue ──

test('economy wiring: a driver that consumed a big/long session is deprioritized in the HOST admission queue behind a light consumer', () => {
  const ledger = new StandingLedger();
  const clock = { now: 1_000 };
  const priorityScore = bindPriorityScore(ledger, () => clock.now);

  // Mirrors useStageHost.ts's freeSession: recordConsumption is fed from
  // the session's own layerStart/layerEnd/decodedCount/createdAt, NOT
  // gated on how the session ended.
  ledger.recordConsumption(
    { consumerPeerId: 'heavy-driver', layersConsumed: 26, framesConsumed: 500, consumingMs: 120_000 },
    clock.now,
  );
  ledger.recordConsumption(
    { consumerPeerId: 'light-driver', layersConsumed: 26, framesConsumed: 8, consumingMs: 2_000 },
    clock.now,
  );

  clock.now += 1_000;
  let queue: readonly QueueEntry<{ note: string }>[] = [
    { sessionId: 's-heavy', peerId: 'heavy-driver', enqueuedAt: clock.now, request: { note: 'heavy' } },
    { sessionId: 's-light', peerId: 'light-driver', enqueuedAt: clock.now, request: { note: 'light' } },
  ];

  const popped = popNextByPriority(queue, priorityScore);
  assert.equal(popped.next?.peerId, 'light-driver', 'the lighter consumer should be admitted first');
  queue = popped.queue;
  const second = popNextByPriority(queue, priorityScore);
  assert.equal(second.next?.peerId, 'heavy-driver');

  // The heavy consumer's debt pushes it into the lowest lane (standing <= 0
  // once its debit outweighs any credit — it has none here), which is
  // still a real number that WOULD be admitted eventually (no-cutoff),
  // never a refusal.
  assert.ok(Number.isFinite(priorityScore('heavy-driver')));
  assert.ok(priorityScore('light-driver') > priorityScore('heavy-driver'));
});

test('economy wiring: an UNSEEN driver (never recorded) still outranks one carrying a standing debt in the admission queue', () => {
  const ledger = new StandingLedger();
  const clock = { now: 5_000 };
  ledger.recordConsumption({ consumerPeerId: 'debtor', layersConsumed: 26, framesConsumed: 300, consumingMs: 60_000 }, clock.now);
  const priorityScore = bindPriorityScore(ledger, () => clock.now);

  const queue: readonly QueueEntry<null>[] = [
    { sessionId: 's1', peerId: 'debtor', enqueuedAt: clock.now, request: null },
    { sessionId: 's2', peerId: 'newcomer', enqueuedAt: clock.now, request: null },
  ];
  const { next } = popNextByPriority(queue, priorityScore);
  assert.equal(next?.peerId, 'newcomer');
});

// ── Driver-side: useCommunalChat.ts's recordSegmentTelemetry -> route rank ──

function loadedStagesRoster(entries: { peerId: string; layerStart: number; layerEnd: number }[]) {
  return entries.map((e) => ({
    v: 1 as const,
    ts: 0,
    peerId: e.peerId,
    lastSeen: 0,
    nick: e.peerId,
    modelId: 'n/a',
    available: true,
    skills: [],
    systemPromptSummary: '',
    tools: [],
    stageHost: {
      maxStorageBufferBytes: 1,
      wasmHeapBudget: 1,
      loadedStages: [
        {
          modelId: 'm',
          layerStart: e.layerStart,
          layerEnd: e.layerEnd,
          includeEmbeddings: false,
          includeOutput: e.layerEnd === 28,
          ctxSize: 512,
          wireDtype: 'f32' as const,
          maxSessions: 4,
          activeSessions: 0,
          epoch: 0,
        },
      ],
    },
  }));
}

test('economy wiring: a host this driver directly witnessed completing service outranks an unseen candidate for the SAME segment', () => {
  const ledger = new StandingLedger();
  const clock = { now: 10_000 };

  // Mirrors useCommunalChat.ts's recordSegmentTelemetry on a 'finished'
  // event: credit the attached host for the layers/frames/time it served,
  // gated on sessionCompleted.
  ledger.recordService(
    { hostPeerId: 'good-host', layersServed: 26, framesServed: 64, servingMs: 8_000, sessionCompleted: true },
    clock.now,
  );
  clock.now += 500;
  const priorityScore = bindPriorityScore(ledger, () => clock.now);

  // Two candidates advertise the EXACT same segment [2,28) — 'good-host'
  // (known-good, real credit) and 'unknown-host' (never observed).
  const roster = loadedStagesRoster([
    { peerId: 'good-host', layerStart: 2, layerEnd: 28 },
    { peerId: 'unknown-host', layerStart: 2, layerEnd: 28 },
  ]);
  const topology = buildCommunalTopology(roster, { modelId: 'm', totalLayers: 28, driverLayers: 2 });
  assert.equal(topology.gaps.length, 0);
  assert.equal(topology.segments.length, 1);

  // spreadWidth=1 forces "top-ranked candidate only" so this test asserts
  // the RANKING itself, not the anti-stampede spread's own randomization.
  const route = planCommunalRoute(topology, { driverPeerId: 'me', priorityScore, nEmbd: 1024, spreadWidth: 1 });
  assert.ok(route);
  const chosen = route!.stages.find((s) => s.stageIndex === 1);
  assert.equal(chosen?.peerId, 'good-host', 'the ledger-credited host should rank first once headroom/stability tie');
});

test('economy wiring: a host whose only recorded session ABORTED gets no credit (still ranks like an unseen peer)', () => {
  const ledger = new StandingLedger();
  const clock = { now: 20_000 };

  // Mirrors useCommunalChat.ts's recordSegmentTelemetry on an 'aborted' or
  // superseding 'replan' event: sessionCompleted:false credits nothing.
  ledger.recordService(
    { hostPeerId: 'flaky-host', layersServed: 26, framesServed: 64, servingMs: 8_000, sessionCompleted: false },
    clock.now,
  );
  const priorityScore = bindPriorityScore(ledger, () => clock.now);

  assert.equal(ledger.standingOf('flaky-host', clock.now), 0);
  // Still "seen" (eventCount > 0) but zero standing -> lowest lane, exactly
  // like a heavy-debt peer, strictly below an unseen peer's newcomer floor.
  assert.ok(priorityScore('flaky-host') < priorityScore('never-seen-host'));
});
