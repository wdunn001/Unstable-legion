/**
 * communalTopology unit tests — coverage/gaps/seats math + route spread
 * distribution over synthetic roster snapshots (no mesh, no I/O — this
 * module is pure).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommunalTopology,
  planCommunalRoute,
  communalAttachOrder,
  deterministicHash,
  adFailureDomainId,
  distinctFailureDomainIds,
  distinctFailureDomainCount,
} from '../src/communalTopology.ts';
import type { MeshRosterEntry } from '../src/types.ts';

const MODEL = 'qwen3-0.6b-q8_0';
const TOTAL_LAYERS = 28;
const DRIVER_LAYERS = 2;

function makePeer(
  peerId: string,
  loadedStages: {
    layerStart: number;
    layerEnd: number;
    includeOutput?: boolean;
    includeEmbeddings?: boolean;
    maxSessions?: number;
    activeSessions?: number;
    modelId?: string;
    epoch?: number;
  }[],
  stability?: { keepalive?: boolean; visible?: boolean; uptimeMs?: number },
  failureDomainId?: string,
): MeshRosterEntry {
  return {
    v: 1,
    ts: Date.now(),
    peerId,
    lastSeen: Date.now(),
    nick: peerId,
    modelId: 'n/a',
    available: true,
    skills: [],
    systemPromptSummary: '',
    tools: [],
    stageHost: {
      maxStorageBufferBytes: 1_000_000_000,
      wasmHeapBudget: 1_000_000_000,
      ...(failureDomainId !== undefined ? { failureDomainId } : {}),
      stability: { keepalive: false, visible: true, uptimeMs: 0, ...stability },
      loadedStages: loadedStages.map((s) => ({
        modelId: s.modelId ?? MODEL,
        layerStart: s.layerStart,
        layerEnd: s.layerEnd,
        includeEmbeddings: s.includeEmbeddings ?? false,
        includeOutput: s.includeOutput ?? false,
        ctxSize: 512,
        wireDtype: 'f32' as const,
        maxSessions: s.maxSessions ?? 4,
        activeSessions: s.activeSessions ?? 0,
        epoch: s.epoch ?? 1,
      })),
    },
  };
}

test('buildCommunalTopology: empty roster -> one big gap, seats 0, coverage 0', () => {
  const topo = buildCommunalTopology([], { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
  assert.deepEqual(topo.gaps, [{ layerStart: 2, layerEnd: 28 }]);
  assert.equal(topo.segments.length, 0);
  assert.equal(topo.seats, 0);
  assert.equal(topo.coverageFraction, 0);
  assert.equal(topo.outputCovered, false);
});

test('buildCommunalTopology: driverLayers >= totalLayers -> trivially fully covered', () => {
  const topo = buildCommunalTopology([], { modelId: MODEL, totalLayers: 2, driverLayers: 2 });
  assert.deepEqual(topo.gaps, []);
  assert.equal(topo.coverageFraction, 1);
  assert.equal(topo.outputCovered, true);
});

test('buildCommunalTopology: single host covering the whole remainder -> full coverage, 1 segment', () => {
  const roster = [makePeer('hostA', [{ layerStart: 2, layerEnd: 28, includeOutput: true }])];
  const topo = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
  assert.deepEqual(topo.gaps, []);
  assert.equal(topo.segments.length, 1);
  assert.deepEqual(topo.segments[0], {
    layerStart: 2,
    layerEnd: 28,
    candidates: topo.segments[0]!.candidates, // shape-checked below
  });
  assert.equal(topo.segments[0]!.candidates.length, 1);
  assert.equal(topo.segments[0]!.candidates[0]!.peerId, 'hostA');
  assert.equal(topo.outputCovered, true);
  assert.equal(topo.coverageFraction, 1);
  assert.equal(topo.seats, 4); // maxSessions(4) - activeSessions(0)
});

test('buildCommunalTopology: two disjoint partial hosts leave a gap between them', () => {
  const roster = [
    makePeer('hostA', [{ layerStart: 2, layerEnd: 10 }]),
    makePeer('hostB', [{ layerStart: 15, layerEnd: 28, includeOutput: true }]),
  ];
  const topo = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
  assert.deepEqual(topo.gaps, [{ layerStart: 10, layerEnd: 15 }]);
  assert.equal(topo.segments.length, 2);
  assert.equal(topo.seats, 0); // any gap -> 0 seats, nothing routes end-to-end
  assert.ok(topo.coverageFraction > 0 && topo.coverageFraction < 1);
});

test('buildCommunalTopology: exact-tiling two hosts -> full coverage, correct seats bottleneck', () => {
  const roster = [
    makePeer('hostA', [{ layerStart: 2, layerEnd: 15, maxSessions: 4, activeSessions: 1 }]),
    makePeer('hostB', [{ layerStart: 15, layerEnd: 28, includeOutput: true, maxSessions: 2, activeSessions: 0 }]),
  ];
  const topo = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
  assert.deepEqual(topo.gaps, []);
  assert.equal(topo.segments.length, 2);
  // hostA headroom=3, hostB headroom=2 -> bottleneck 2
  assert.equal(topo.seats, 2);
  assert.equal(topo.coverageFraction, 1);
});

test('buildCommunalTopology: duplicate (spare) ads on the same exact range become multiple candidates for one segment', () => {
  const roster = [
    makePeer('hostA', [{ layerStart: 2, layerEnd: 28, includeOutput: true, maxSessions: 4, activeSessions: 0 }]),
    makePeer('hostB', [{ layerStart: 2, layerEnd: 28, includeOutput: true, maxSessions: 3, activeSessions: 1 }]),
  ];
  const topo = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
  assert.equal(topo.segments.length, 1);
  assert.equal(topo.segments[0]!.candidates.length, 2);
  // seats = sum of headroom across BOTH candidates of the one segment: 4 + 2 = 6
  assert.equal(topo.seats, 6);
});

// ── failureDomainId propagation + domain-counting helpers ───────────────

test('buildCommunalTopology: candidate ads carry the advertising peer\'s failureDomainId through to the segment', () => {
  const roster = [
    makePeer('hostA', [{ layerStart: 2, layerEnd: 28, includeOutput: true }], undefined, 'fd-machine-1'),
    makePeer('hostB', [{ layerStart: 2, layerEnd: 28, includeOutput: true }], undefined, 'fd-machine-1'),
  ];
  const topo = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
  assert.equal(topo.segments.length, 1);
  const candidates = topo.segments[0]!.candidates;
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]!.failureDomainId, 'fd-machine-1');
  assert.equal(candidates[1]!.failureDomainId, 'fd-machine-1');
});

test('adFailureDomainId: explicit id wins; absent -> falls back to peerId', () => {
  assert.equal(adFailureDomainId({ peerId: 'p1', failureDomainId: 'fd-x' }), 'fd-x');
  assert.equal(adFailureDomainId({ peerId: 'p1', failureDomainId: undefined }), 'p1');
});

test('distinctFailureDomainIds / distinctFailureDomainCount: two same-origin (same-domain) candidates count as ONE domain; two distinct domains count as TWO', () => {
  const colocated = [
    { peerId: 'tabA', failureDomainId: 'fd-machine-1' },
    { peerId: 'tabB', failureDomainId: 'fd-machine-1' },
  ];
  assert.equal(distinctFailureDomainCount(colocated), 1);
  assert.deepEqual([...distinctFailureDomainIds(colocated)], ['fd-machine-1']);

  const distinct = [
    { peerId: 'tabA', failureDomainId: 'fd-machine-1' },
    { peerId: 'tabB', failureDomainId: 'fd-machine-2' },
  ];
  assert.equal(distinctFailureDomainCount(distinct), 2);
});

test('distinctFailureDomainCount: missing failureDomainId -> each peer is its own domain (back-compat)', () => {
  const noDomainIds = [{ peerId: 'p1', failureDomainId: undefined }, { peerId: 'p2', failureDomainId: undefined }];
  assert.equal(distinctFailureDomainCount(noDomainIds), 2);
});

test('buildCommunalTopology: staggered partial overlap resolves via furthest-reach greedy walk, no crash', () => {
  const roster = [
    makePeer('hostA', [{ layerStart: 2, layerEnd: 20 }]),
    makePeer('hostB', [{ layerStart: 10, layerEnd: 28, includeOutput: true }]),
  ];
  const topo = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
  // At cursor=2, hostA reaches furthest among reaching ads that start <=2 (only hostA covers 2).
  // Segment 1 = hostA's full range [2,20). Cursor jumps to 20. hostB covers [10,28) which reaches
  // past 20 and starts <=20, so segment 2 = hostB's full range [10,28) (harmless overlap [10,20)).
  assert.deepEqual(topo.gaps, []);
  assert.equal(topo.segments.length, 2);
  assert.equal(topo.segments[0]!.layerStart, 2);
  assert.equal(topo.segments[0]!.layerEnd, 20);
  assert.equal(topo.segments[1]!.layerStart, 10);
  assert.equal(topo.segments[1]!.layerEnd, 28);
  assert.equal(topo.outputCovered, true);
});

test('buildCommunalTopology: ads for a different modelId are ignored', () => {
  const roster = [makePeer('hostA', [{ layerStart: 2, layerEnd: 28, modelId: 'some-other-model' }])];
  const topo = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
  assert.deepEqual(topo.gaps, [{ layerStart: 2, layerEnd: 28 }]);
});

test('buildCommunalTopology: excludePeerIds removes a host from candidacy (churn replan)', () => {
  const roster = [makePeer('hostA', [{ layerStart: 2, layerEnd: 28, includeOutput: true }])];
  const topo = buildCommunalTopology(
    roster,
    { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS },
    { excludePeerIds: ['hostA'] },
  );
  assert.deepEqual(topo.gaps, [{ layerStart: 2, layerEnd: 28 }]);
});

test('buildCommunalTopology: totalLayers/driverLayers validation', () => {
  assert.throws(() => buildCommunalTopology([], { modelId: MODEL, totalLayers: 0, driverLayers: 0 }), /totalLayers/);
  assert.throws(() => buildCommunalTopology([], { modelId: MODEL, totalLayers: 10, driverLayers: -1 }), /driverLayers/);
});

// ── planCommunalRoute ────────────────────────────────────────────────────

test('planCommunalRoute: null when a gap exists', () => {
  const roster = [makePeer('hostA', [{ layerStart: 2, layerEnd: 10 }])];
  const topo = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
  const route = planCommunalRoute(topo, { driverPeerId: 'driver1', nEmbd: 1024 });
  assert.equal(route, null);
});

test('planCommunalRoute: null when segments exist but nEmbd is omitted', () => {
  const roster = [makePeer('hostA', [{ layerStart: 2, layerEnd: 28, includeOutput: true }])];
  const topo = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
  const route = planCommunalRoute(topo, { driverPeerId: 'driver1' });
  assert.equal(route, null);
});

test('planCommunalRoute: produces a StagePlan-shaped local stage 0 + one remote stage', () => {
  const roster = [makePeer('hostA', [{ layerStart: 2, layerEnd: 28, includeOutput: true }])];
  const topo = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
  const plan = planCommunalRoute(topo, { driverPeerId: 'driver1', nEmbd: 1024, wireDtype: 'f32' });
  assert.ok(plan);
  assert.equal(plan!.stages.length, 2);
  assert.equal(plan!.stages[0]!.stageIndex, 0);
  assert.equal(plan!.stages[0]!.peerId, 'driver1');
  assert.equal(plan!.stages[0]!.isFirst, true);
  assert.equal(plan!.stages[0]!.layerStart, 0);
  assert.equal(plan!.stages[0]!.layerEnd, DRIVER_LAYERS);
  assert.equal(plan!.stages[1]!.stageIndex, 1);
  assert.equal(plan!.stages[1]!.peerId, 'hostA');
  assert.equal(plan!.stages[1]!.isFinal, true);
  assert.equal(plan!.perTokenHopBytes, 4 * 1024 * 1); // wireDtype f32 -> 4 bytes/elem, 1 hop
});

test('planCommunalRoute: wireDtype affects perTokenHopBytes (f16 halves f32)', () => {
  const roster = [makePeer('hostA', [{ layerStart: 2, layerEnd: 28, includeOutput: true }])];
  const topo = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
  const f16Plan = planCommunalRoute(topo, { driverPeerId: 'driver1', nEmbd: 1024, wireDtype: 'f16' });
  const f32Plan = planCommunalRoute(topo, { driverPeerId: 'driver1', nEmbd: 1024, wireDtype: 'f32' });
  assert.equal(f32Plan!.perTokenHopBytes, f16Plan!.perTokenHopBytes * 2);
});

test('planCommunalRoute: driverLayers >= totalLayers -> trivial single local stage, no remote hop', () => {
  const topo = buildCommunalTopology([], { modelId: MODEL, totalLayers: 2, driverLayers: 2 });
  const plan = planCommunalRoute(topo, { driverPeerId: 'driver1', nEmbd: 1024 });
  assert.ok(plan);
  assert.equal(plan!.stages.length, 1);
  assert.equal(plan!.stages[0]!.isFirst, true);
  assert.equal(plan!.stages[0]!.isFinal, true);
  assert.equal(plan!.perTokenHopBytes, 0);
});

test('planCommunalRoute: hotSparePeerId picked from a segment runner-up when present', () => {
  const roster = [
    makePeer('hostA', [{ layerStart: 2, layerEnd: 28, includeOutput: true, activeSessions: 0 }]),
    makePeer('hostB', [{ layerStart: 2, layerEnd: 28, includeOutput: true, activeSessions: 3 }]), // less headroom -> ranked lower
  ];
  const topo = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
  const plan = planCommunalRoute(topo, { driverPeerId: 'driver1', nEmbd: 1024, spreadWidth: 1 });
  assert.ok(plan);
  // spreadWidth=1 forces deterministic top-pick = hostA (more headroom); hostB is the spare.
  assert.equal(plan!.stages[1]!.peerId, 'hostA');
  assert.equal(plan!.hotSparePeerId, 'hostB');
  assert.deepEqual(plan!.unselectedPeerIds, ['hostB']);
});

test('planCommunalRoute: anti-stampede spread fans different drivers across the top candidates', () => {
  const roster = [
    makePeer('hostA', [{ layerStart: 2, layerEnd: 28, includeOutput: true }]),
    makePeer('hostB', [{ layerStart: 2, layerEnd: 28, includeOutput: true }]),
    makePeer('hostC', [{ layerStart: 2, layerEnd: 28, includeOutput: true }]),
  ];
  const topo = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
  // All three candidates tie on headroom/priority/stability/rtt, so ranking
  // falls back to peerId ascending: [hostA, hostB, hostC]. With spreadWidth=3,
  // different driverPeerIds should land on different indices of that list.
  const picks = new Set<string>();
  for (const driverPeerId of ['driver-alpha', 'driver-bravo', 'driver-charlie', 'driver-delta', 'driver-echo']) {
    const plan = planCommunalRoute(topo, { driverPeerId, nEmbd: 1024, spreadWidth: 3 });
    picks.add(plan!.stages[1]!.peerId);
  }
  // Not a strict requirement that ALL three appear (hash distribution over
  // 5 samples could miss one), but it must not collapse to a single host
  // every time — that would mean spread isn't doing anything.
  assert.ok(picks.size > 1, `expected spread across candidates, got only ${[...picks].join(',')}`);
});

test('planCommunalRoute: deterministic — same inputs always produce the same chosen peer', () => {
  const roster = [
    makePeer('hostA', [{ layerStart: 2, layerEnd: 28, includeOutput: true }]),
    makePeer('hostB', [{ layerStart: 2, layerEnd: 28, includeOutput: true }]),
  ];
  const topo = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
  const p1 = planCommunalRoute(topo, { driverPeerId: 'driver-x', nEmbd: 1024 });
  const p2 = planCommunalRoute(topo, { driverPeerId: 'driver-x', nEmbd: 1024 });
  assert.equal(p1!.stages[1]!.peerId, p2!.stages[1]!.peerId);
});

// ── communalAttachOrder ──────────────────────────────────────────────────

test('communalAttachOrder: head matches planCommunalRoute\'s chosen peer, rest are fallback candidates', () => {
  const roster = [
    makePeer('hostA', [{ layerStart: 2, layerEnd: 28, includeOutput: true }]),
    makePeer('hostB', [{ layerStart: 2, layerEnd: 28, includeOutput: true }]),
    makePeer('hostC', [{ layerStart: 2, layerEnd: 28, includeOutput: true }]),
  ];
  const topo = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
  const opts = { driverPeerId: 'driver-x', nEmbd: 1024 };
  const plan = planCommunalRoute(topo, opts);
  const attachOrder = communalAttachOrder(topo, opts);
  const order = attachOrder.get(1);
  assert.ok(order);
  assert.equal(order![0]!.peerId, plan!.stages[1]!.peerId);
  assert.equal(order!.length, 3);
  const peerIds = new Set(order!.map((c) => c.peerId));
  assert.equal(peerIds.size, 3); // no duplicates, everyone appears exactly once
});

// ── deterministicHash ────────────────────────────────────────────────────

test('deterministicHash: same input -> same output, different inputs usually differ', () => {
  assert.equal(deterministicHash('peer-1'), deterministicHash('peer-1'));
  assert.notEqual(deterministicHash('peer-1'), deterministicHash('peer-2'));
  assert.ok(deterministicHash('') >= 0);
});

test('planCommunalRoute: maxStages kill-switch rejects a route needing more hops than allowed', () => {
  // Two adjacent hosts tile [2,28) as two segments → local[0,2) + 2 remote =
  // 3 stages. maxStages:2 (driver + one remote) must reject it; undefined must
  // still route it (the relay handles it).
  const roster = [
    makePeer('hostA', [{ layerStart: 2, layerEnd: 15 }]),
    makePeer('hostB', [{ layerStart: 15, layerEnd: 28, includeOutput: true }]),
  ];
  const topo = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
  assert.equal(topo.segments.length, 2);

  const capped = planCommunalRoute(topo, { driverPeerId: 'drv', nEmbd: 1024, maxStages: 2 });
  assert.equal(capped, null, 'maxStages:2 rejects a 3-stage route');

  const uncapped = planCommunalRoute(topo, { driverPeerId: 'drv', nEmbd: 1024 });
  assert.ok(uncapped, 'no cap still routes it (relay-capable)');
  assert.equal(uncapped!.stages.length, 3);
});

test('planCommunalRoute: maxStages does not reject the proven 2-stage route', () => {
  const roster = [makePeer('hostA', [{ layerStart: 2, layerEnd: 28, includeOutput: true }])];
  const topo = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
  const routed = planCommunalRoute(topo, { driverPeerId: 'drv', nEmbd: 1024, maxStages: 2 });
  assert.ok(routed, 'a single full-range host is 2 stages — within the cap');
  assert.equal(routed!.stages.length, 2);
});
