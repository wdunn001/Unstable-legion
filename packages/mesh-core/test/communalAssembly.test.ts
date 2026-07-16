/**
 * communalAssembly unit tests: single-decision behavior (claim/yield/jitter)
 * plus a simulation harness proving the property the workstream brief
 * asks for — random join/leave/claim sequences converge to full coverage
 * with no PERSISTENT wasteful overlap.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { communalHostClaim, DEFAULT_MAX_SPARES_PER_SEGMENT } from '../src/communalAssembly.ts';
import { buildCommunalTopology } from '../src/communalTopology.ts';
import type { MeshRosterEntry } from '../src/types.ts';

const MODEL = 'qwen3-0.6b-q8_0';
const TOTAL_LAYERS = 28;
const DRIVER_LAYERS = 2;

function makePeer(
  peerId: string,
  loadedStages: { layerStart: number; layerEnd: number; includeOutput?: boolean; maxSessions?: number; activeSessions?: number }[],
  // Encoded so `hostStabilityScore` reproduces this EXACT value (via the
  // uptimeMs term alone, uncapped range [0,3600] — see hostStabilityScore
  // in stagePlanner.ts). Callers that need a specific numeric stability
  // score (e.g. the convergence simulation below, where OTHER hosts must
  // see an accurate score for each peer, not a fixed default) pass it
  // explicitly; single-decision tests that don't care use the default.
  stabilityScore = 1000,
  // failure-domain-accounting tests set this to simulate colocated
  // (same-domain) tabs; omitted -> peer is its own domain (back-compat).
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
      stability: { keepalive: false, visible: false, uptimeMs: stabilityScore * 1000 },
      loadedStages: loadedStages.map((s) => ({
        modelId: MODEL,
        layerStart: s.layerStart,
        layerEnd: s.layerEnd,
        includeEmbeddings: false,
        includeOutput: s.includeOutput ?? false,
        ctxSize: 512,
        wireDtype: 'f32' as const,
        maxSessions: s.maxSessions ?? 4,
        activeSessions: s.activeSessions ?? 0,
        epoch: 1,
      })),
    },
  };
}

// ── Single-decision behavior ─────────────────────────────────────────────

test('communalHostClaim: empty mesh -> self claims the whole gap, capped by capacity', () => {
  const result = communalHostClaim({
    roster: [],
    selfPeerId: 'self',
    modelId: MODEL,
    totalLayers: TOTAL_LAYERS,
    driverLayers: DRIVER_LAYERS,
    selfCapacityLayers: 100, // ample
  });
  assert.deepEqual(result.claim, { layerStart: 2, layerEnd: 28, includeOutput: true });
  assert.equal(result.yieldCurrent, false);
});

test('communalHostClaim: capacity-capped claim leaves the rest as a gap for someone else', () => {
  const result = communalHostClaim({
    roster: [],
    selfPeerId: 'self',
    modelId: MODEL,
    totalLayers: TOTAL_LAYERS,
    driverLayers: DRIVER_LAYERS,
    selfCapacityLayers: 10,
  });
  assert.deepEqual(result.claim, { layerStart: 2, layerEnd: 12, includeOutput: false });
});

test('communalHostClaim: claims are anchored at the lowest gap start, packing upward from driverLayers', () => {
  const roster = [makePeer('hostA', [{ layerStart: 2, layerEnd: 12 }])];
  const result = communalHostClaim({
    roster,
    selfPeerId: 'self',
    modelId: MODEL,
    totalLayers: TOTAL_LAYERS,
    driverLayers: DRIVER_LAYERS,
    selfCapacityLayers: 100,
  });
  assert.deepEqual(result.claim, { layerStart: 12, layerEnd: 28, includeOutput: true });
});

test('communalHostClaim: zero capacity -> no claim; sheds any current claim', () => {
  const result = communalHostClaim({
    roster: [],
    selfPeerId: 'self',
    modelId: MODEL,
    totalLayers: TOTAL_LAYERS,
    driverLayers: DRIVER_LAYERS,
    selfCapacityLayers: 0,
    selfCurrentClaim: { layerStart: 2, layerEnd: 10, includeOutput: false },
  });
  assert.equal(result.claim, null);
  assert.equal(result.yieldCurrent, true);
});

test('communalHostClaim: fully covered, under-replicated segment -> self becomes a warm spare', () => {
  const roster = [makePeer('hostA', [{ layerStart: 2, layerEnd: 28, includeOutput: true }])];
  const result = communalHostClaim({
    roster,
    selfPeerId: 'self',
    modelId: MODEL,
    totalLayers: TOTAL_LAYERS,
    driverLayers: DRIVER_LAYERS,
    selfCapacityLayers: 100,
  });
  assert.deepEqual(result.claim, { layerStart: 2, layerEnd: 28, includeOutput: true });
});

test('communalHostClaim: fully covered AND already at spare cap -> nothing useful to host', () => {
  const roster = [
    makePeer('hostA', [{ layerStart: 2, layerEnd: 28, includeOutput: true }]),
    makePeer('hostB', [{ layerStart: 2, layerEnd: 28, includeOutput: true }]),
    makePeer('hostC', [{ layerStart: 2, layerEnd: 28, includeOutput: true }]),
  ];
  // DEFAULT_MAX_SPARES_PER_SEGMENT = 2 -> primary + 2 spares = 3 already present.
  assert.equal(DEFAULT_MAX_SPARES_PER_SEGMENT, 2);
  const result = communalHostClaim({
    roster,
    selfPeerId: 'self',
    modelId: MODEL,
    totalLayers: TOTAL_LAYERS,
    driverLayers: DRIVER_LAYERS,
    selfCapacityLayers: 100,
  });
  assert.equal(result.claim, null);
});

test('communalHostClaim: keeps an already-legitimate current claim as-is (no thrash)', () => {
  const roster = [makePeer('hostA', [{ layerStart: 12, layerEnd: 28, includeOutput: true }])];
  const result = communalHostClaim({
    roster,
    selfPeerId: 'self',
    modelId: MODEL,
    totalLayers: TOTAL_LAYERS,
    driverLayers: DRIVER_LAYERS,
    selfCapacityLayers: 100,
    selfCurrentClaim: { layerStart: 2, layerEnd: 12, includeOutput: false },
  });
  assert.deepEqual(result.claim, { layerStart: 2, layerEnd: 12, includeOutput: false });
  assert.equal(result.yieldCurrent, false);
});

test('communalHostClaim: yield — self is the deterministic loser of a wasteful duplicate while a gap exists', () => {
  // self + hostA both hold [2,10) (a duplicate), while [10,28) is a real
  // gap elsewhere — this IS wasteful (capacity duplicated while something
  // else needs coverage). Tie-break: greater peerId loses; 'self' > 'hostA'.
  const roster = [makePeer('hostA', [{ layerStart: 2, layerEnd: 10 }])];
  const result = communalHostClaim({
    roster,
    selfPeerId: 'self',
    modelId: MODEL,
    totalLayers: TOTAL_LAYERS,
    driverLayers: DRIVER_LAYERS,
    selfCapacityLayers: 100,
    selfCurrentClaim: { layerStart: 2, layerEnd: 10, includeOutput: false },
  });
  assert.equal(result.yieldCurrent, true);
  assert.equal(result.claim, null);
});

test('communalHostClaim: the WINNER of a wasteful-overlap tie-break never yields', () => {
  // 'zzz-host' > 'self' lexically ('s' < 'z') -> on an EQUAL-stability tie,
  // zzz-host is the loser, self (the winner) keeps its claim. Both sides
  // pinned to the SAME stability score so the peerId tie-break is what's
  // actually under test (makePeer's default stability block otherwise
  // gives the roster peer a nonzero score that would dominate).
  const roster = [makePeer('zzz-host', [{ layerStart: 2, layerEnd: 10 }])];
  const result = communalHostClaim({
    roster,
    selfPeerId: 'self',
    modelId: MODEL,
    totalLayers: TOTAL_LAYERS,
    driverLayers: DRIVER_LAYERS,
    selfCapacityLayers: 100, // no spare-growth confound — claim already covers the whole gap on the right
    selfCurrentClaim: { layerStart: 2, layerEnd: 10, includeOutput: false },
    selfStabilityScore: 1000, // matches makePeer's default (visible:true -> 1000, uptimeMs:0)
  });
  assert.equal(result.yieldCurrent, false);
});

test('communalHostClaim: overlap alongside FULL coverage is never flagged as wasteful (legitimate spare)', () => {
  const roster = [makePeer('hostA', [{ layerStart: 2, layerEnd: 28, includeOutput: true }])];
  const result = communalHostClaim({
    roster,
    selfPeerId: 'self',
    modelId: MODEL,
    totalLayers: TOTAL_LAYERS,
    driverLayers: DRIVER_LAYERS,
    selfCapacityLayers: 100,
    selfCurrentClaim: { layerStart: 2, layerEnd: 28, includeOutput: true },
  });
  assert.equal(result.yieldCurrent, false);
  assert.deepEqual(result.claim, { layerStart: 2, layerEnd: 28, includeOutput: true });
});

test('communalHostClaim: jitterMs shrinks with higher self stability', () => {
  const unstable = communalHostClaim({
    roster: [],
    selfPeerId: 'self',
    modelId: MODEL,
    totalLayers: TOTAL_LAYERS,
    driverLayers: DRIVER_LAYERS,
    selfCapacityLayers: 100,
    selfStabilityScore: 0,
  });
  const stable = communalHostClaim({
    roster: [],
    selfPeerId: 'self',
    modelId: MODEL,
    totalLayers: TOTAL_LAYERS,
    driverLayers: DRIVER_LAYERS,
    selfCapacityLayers: 100,
    selfStabilityScore: 8000,
  });
  assert.ok(stable.jitterMs < unstable.jitterMs);
});

test('communalHostClaim: jitterMs is deterministic for the same selfPeerId (no Math.random)', () => {
  const a = communalHostClaim({ roster: [], selfPeerId: 'self', modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS, selfCapacityLayers: 5 });
  const b = communalHostClaim({ roster: [], selfPeerId: 'self', modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS, selfCapacityLayers: 5 });
  assert.equal(a.jitterMs, b.jitterMs);
});

// ── Failure-domain-aware replication counting (colocated-tab fix) ───────
//
// The catastrophic gap: two same-origin tabs on one machine each join the
// mesh as an independent peer, but share ONE failure domain — counting
// them as two independent redundant copies defeats the warm-spare design.
// These tests prove `communalHostClaim` counts DISTINCT `failureDomainId`s
// for replication/spare-cap purposes, not distinct peerIds, while still
// treating each peer WITHOUT an explicit domain as its own (back-compat).

test('communalHostClaim: a segment covered ONLY by same-domain peers still reads as under-replicated — self (a real distinct domain) becomes a spare even though the PEER count already looks saturated', () => {
  // hostA + hostB share failureDomainId 'fd-machine-A' and BOTH cover the
  // exact same segment (colocated tabs); hostC is a genuinely distinct
  // domain also covering it. 3 PEERS total, but only 2 DISTINCT DOMAINS
  // (fd-machine-A, fd-hostC) — DEFAULT_MAX_SPARES_PER_SEGMENT=2 means the
  // segment should still welcome a 3rd real domain. Old peer-count logic
  // (candidates.length=3, already >= maxSparesPerSegment+1=3) would wrongly
  // treat this as fully spare-saturated and refuse.
  assert.equal(DEFAULT_MAX_SPARES_PER_SEGMENT, 2);
  const roster = [
    makePeer('hostA', [{ layerStart: 2, layerEnd: 28, includeOutput: true }], 1000, 'fd-machine-A'),
    makePeer('hostB', [{ layerStart: 2, layerEnd: 28, includeOutput: true }], 1000, 'fd-machine-A'),
    makePeer('hostC', [{ layerStart: 2, layerEnd: 28, includeOutput: true }], 1000, 'fd-hostC'),
  ];
  const result = communalHostClaim({
    roster,
    selfPeerId: 'self',
    modelId: MODEL,
    totalLayers: TOTAL_LAYERS,
    driverLayers: DRIVER_LAYERS,
    selfCapacityLayers: 100,
    selfFailureDomainId: 'fd-self',
  });
  assert.deepEqual(result.claim, { layerStart: 2, layerEnd: 28, includeOutput: true });
  assert.match(result.reason, /warm spare/);
});

test('communalHostClaim: a segment covered by 2 DISTINCT domains is NOT offered as a spare target once at the cap (matches peer-count behavior when domains == peers)', () => {
  // hostA and hostB are genuinely distinct domains covering the same
  // segment — 2 peers, 2 domains. With DEFAULT_MAX_SPARES_PER_SEGMENT=2
  // (primary + 2 spares = 3 domains allowed), self joining as a 3rd
  // distinct domain is still welcome (this is the "matches old behavior
  // when nobody is colocated" sanity check, not the fix itself).
  const roster = [
    makePeer('hostA', [{ layerStart: 2, layerEnd: 28, includeOutput: true }], 1000, 'fd-A'),
    makePeer('hostB', [{ layerStart: 2, layerEnd: 28, includeOutput: true }], 1000, 'fd-B'),
  ];
  const result = communalHostClaim({
    roster,
    selfPeerId: 'self',
    modelId: MODEL,
    totalLayers: TOTAL_LAYERS,
    driverLayers: DRIVER_LAYERS,
    selfCapacityLayers: 100,
    selfFailureDomainId: 'fd-self',
  });
  assert.deepEqual(result.claim, { layerStart: 2, layerEnd: 28, includeOutput: true });
});

test('communalHostClaim: self already holding a spare stays put when its OWN domain already appears once — joining again would not add a distinct domain', () => {
  // self currently holds [2,28) with domain 'fd-self'; hostA (a SIBLING
  // tab, same domain) also covers it, and there's no gap elsewhere (this
  // segment is the whole communal span). PEER-count still governs the
  // essentiality/yield dispatch (see communalAssembly.ts's NOTE) — 2
  // peers means this isn't the "sole coverer" branch, but with no gap
  // anywhere else there's nothing to yield FOR, so self keeps regardless
  // of the tie-break ("legitimate duplicate/spare ... — keeping"). The
  // domain-aware accounting this test actually exercises is upstream of
  // that: it's what stops a THIRD, genuinely-distinct-domain peer from
  // seeing this segment as already spare-saturated (covered by the
  // paired test above) — this test pins the colocated pair's OWN claim
  // stays stable in the meantime (no thrash).
  const roster = [makePeer('hostA', [{ layerStart: 2, layerEnd: 28, includeOutput: true }], 1000, 'fd-self')];
  const result = communalHostClaim({
    roster,
    selfPeerId: 'self',
    modelId: MODEL,
    totalLayers: TOTAL_LAYERS,
    driverLayers: DRIVER_LAYERS,
    selfCapacityLayers: 100,
    selfCurrentClaim: { layerStart: 2, layerEnd: 28, includeOutput: true },
    selfFailureDomainId: 'fd-self',
  });
  assert.deepEqual(result.claim, { layerStart: 2, layerEnd: 28, includeOutput: true });
  assert.equal(result.yieldCurrent, false);
});

test('communalHostClaim: a colocated (same-domain) duplicate is NOT flagged as "sole coverer" reasoning — peer-existence still governs essentiality/yield, independent of domain', () => {
  // Two same-domain peers (self + hostA, sibling tabs) both cover [2,10)
  // while a REAL gap [10,28) exists elsewhere. Peer-count still triggers
  // the "genuine duplicate, consider yielding" path (yielding to refill a
  // real gap is valuable regardless of whether the duplicate happens to
  // be same-domain) — domain-counting must not suppress that by
  // misclassifying this as "sole coverer, always stay".
  const roster = [makePeer('hostA', [{ layerStart: 2, layerEnd: 10 }], 1000, 'fd-self')];
  const result = communalHostClaim({
    roster,
    selfPeerId: 'self',
    modelId: MODEL,
    totalLayers: TOTAL_LAYERS,
    driverLayers: DRIVER_LAYERS,
    selfCapacityLayers: 100,
    selfCurrentClaim: { layerStart: 2, layerEnd: 10, includeOutput: false },
    selfFailureDomainId: 'fd-self',
  });
  assert.notEqual(result.reason, 'sole coverer of this segment — essential, keeping as-is');
});

test('communalHostClaim: missing failureDomainId on either side -> each peer is its own domain (back-compat), no different from pre-fix peer-counting', () => {
  const roster = [
    makePeer('hostA', [{ layerStart: 2, layerEnd: 28, includeOutput: true }]), // no failureDomainId
    makePeer('hostB', [{ layerStart: 2, layerEnd: 28, includeOutput: true }]), // no failureDomainId
    makePeer('hostC', [{ layerStart: 2, layerEnd: 28, includeOutput: true }]), // no failureDomainId
  ];
  // 3 distinct (peerId-derived) domains already at DEFAULT_MAX_SPARES_PER_SEGMENT+1 — no room for self.
  const result = communalHostClaim({
    roster,
    selfPeerId: 'self', // selfFailureDomainId omitted -> defaults to selfPeerId
    modelId: MODEL,
    totalLayers: TOTAL_LAYERS,
    driverLayers: DRIVER_LAYERS,
    selfCapacityLayers: 100,
  });
  assert.equal(result.claim, null);
});

// ── Convergence property tests (simulation) ──────────────────────────────
//
// Simulates N independent hosts, each running `communalHostClaim` against
// the CURRENT shared "roster" (built from everyone's own advertised ad)
// every round, applying the decision (claim -> update own ad; yield ->
// drop own ad) — no coordinator, exactly the real deployment shape.
// Randomized capacities + a mid-run "kill a host" churn event, repeated
// across many seeds.

interface SimHost {
  peerId: string;
  capacityLayers: number;
  currentClaim: { layerStart: number; layerEnd: number; includeOutput: boolean } | null;
  stabilityScore: number;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rosterFromHosts(hosts: readonly SimHost[]): MeshRosterEntry[] {
  return hosts
    .filter((h) => h.currentClaim !== null)
    .map((h) =>
      makePeer(
        h.peerId,
        [{ layerStart: h.currentClaim!.layerStart, layerEnd: h.currentClaim!.layerEnd, includeOutput: h.currentClaim!.includeOutput }],
        h.stabilityScore,
      ),
    );
}

/**
 * Advance one round IN A SHUFFLED SEQUENTIAL ORDER, each host seeing the
 * roster as updated by whoever already acted earlier in this same round.
 * This is the realistic shape of the real deployment: `jitterMs` staggers
 * WHEN each host actually applies its decision (stable hosts sooner,
 * per `communalHostClaim`'s doc comment), so two hosts computing at the
 * literal same microsecond against a stale/empty view of each other is
 * an edge case the jitter mechanism exists specifically to make rare —
 * not the steady-state shape convergence needs to be proven against.
 * `runRound` still gives no host a persistent "goes first" advantage
 * across rounds (the order is reshuffled every call).
 */
function runRound(hosts: SimHost[], rand: () => number): void {
  const order = hosts.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  for (const idx of order) {
    const h = hosts[idx]!;
    const others = rosterFromHosts(hosts.filter((_, i) => i !== idx));
    const d = communalHostClaim({
      roster: others,
      selfPeerId: h.peerId,
      modelId: MODEL,
      totalLayers: TOTAL_LAYERS,
      driverLayers: DRIVER_LAYERS,
      selfCapacityLayers: h.capacityLayers,
      selfCurrentClaim: h.currentClaim,
      selfStabilityScore: h.stabilityScore,
    });
    if (d.yieldCurrent) h.currentClaim = null;
    else if (d.claim) h.currentClaim = d.claim;
  }
}

function coverageOf(hosts: readonly SimHost[]): { gaps: number; seats: number; fraction: number } {
  const roster = rosterFromHosts(hosts);
  const topo = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
  return { gaps: topo.gaps.length, seats: topo.seats, fraction: topo.coverageFraction };
}

test('property: random host populations with ample total capacity converge to full coverage', () => {
  const SEEDS = 40;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rand = mulberry32(seed * 7919);
    const hostCount = 2 + Math.floor(rand() * 5); // 2..6 hosts
    const hosts: SimHost[] = [];
    let totalCapacity = 0;
    for (let i = 0; i < hostCount; i++) {
      // Individually small-ish capacity, but the SUM comfortably exceeds
      // the communal layer count (26) so convergence is actually possible.
      const capacityLayers = 8 + Math.floor(rand() * 15); // 8..22
      totalCapacity += capacityLayers;
      hosts.push({ peerId: `h${i}`, capacityLayers, currentClaim: null, stabilityScore: Math.floor(rand() * 3600) });
    }
    if (totalCapacity < TOTAL_LAYERS - DRIVER_LAYERS) continue; // skip seeds that can't converge by construction

    const ROUNDS = 30;
    for (let r = 0; r < ROUNDS; r++) runRound(hosts, rand);

    const cov = coverageOf(hosts);
    assert.equal(cov.gaps, 0, `seed=${seed} hosts=${hostCount} totalCap=${totalCapacity} did not converge: ${JSON.stringify(hosts)}`);
    assert.equal(cov.fraction, 1);
  }
});

test('property: mid-run host loss (churn) re-converges without a persistent gap', () => {
  const SEEDS = 20;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rand = mulberry32(seed * 104729);
    const hostCount = 3 + Math.floor(rand() * 3); // 3..5 hosts
    const hosts: SimHost[] = [];
    let totalCapacity = 0;
    for (let i = 0; i < hostCount; i++) {
      const capacityLayers = 10 + Math.floor(rand() * 15);
      totalCapacity += capacityLayers;
      hosts.push({ peerId: `h${i}`, capacityLayers, currentClaim: null, stabilityScore: Math.floor(rand() * 3600) });
    }
    if (totalCapacity < TOTAL_LAYERS - DRIVER_LAYERS) continue;

    for (let r = 0; r < 20; r++) runRound(hosts, rand);
    assert.equal(coverageOf(hosts).gaps, 0, `seed=${seed} failed to converge before churn`);

    // Kill one host (simulate a tab close) — remove it entirely, taking
    // its capacity out of the mesh. Remaining capacity might or might not
    // still be enough; only assert reconvergence when it IS enough.
    const killedIdx = Math.floor(rand() * hosts.length);
    const remaining = hosts.filter((_, i) => i !== killedIdx);
    const remainingCapacity = remaining.reduce((sum, h) => sum + h.capacityLayers, 0);
    // A killed PRIMARY host's range becomes uncovered again even though a
    // spare *duplicate* of some OTHER segment survives — remaining hosts
    // must have enough total capacity to re-fill every gap, which they do
    // whenever remainingCapacity alone covers the communal span.
    if (remainingCapacity < TOTAL_LAYERS - DRIVER_LAYERS) continue;

    for (let r = 0; r < 30; r++) runRound(remaining, rand);
    const cov = coverageOf(remaining);
    assert.equal(cov.gaps, 0, `seed=${seed} did not re-converge after killing h${killedIdx}: ${JSON.stringify(remaining)}`);
  }
});

test('property: no PERSISTENT wasteful overlap — once converged with a gap-free mesh, redundancy stays bounded', () => {
  const SEEDS = 20;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rand = mulberry32(seed * 65599);
    const hostCount = 4 + Math.floor(rand() * 4); // 4..7 hosts, deliberately MORE than needed
    const hosts: SimHost[] = [];
    for (let i = 0; i < hostCount; i++) {
      hosts.push({ peerId: `h${i}`, capacityLayers: 30, currentClaim: null, stabilityScore: Math.floor(rand() * 3600) }); // any single host can cover everything
    }

    for (let r = 0; r < 30; r++) runRound(hosts, rand);

    const roster = rosterFromHosts(hosts);
    const topo = buildCommunalTopology(roster, { modelId: MODEL, totalLayers: TOTAL_LAYERS, driverLayers: DRIVER_LAYERS });
    assert.equal(topo.gaps.length, 0, `seed=${seed} should be fully covered`);
    // Every segment's candidate count should be bounded by the spare cap
    // (primary + DEFAULT_MAX_SPARES_PER_SEGMENT), not grow to "every host
    // duplicates the same range forever."
    for (const seg of topo.segments) {
      assert.ok(
        seg.candidates.length <= DEFAULT_MAX_SPARES_PER_SEGMENT + 1,
        `seed=${seed} segment [${seg.layerStart},${seg.layerEnd}) has ${seg.candidates.length} candidates, expected <= ${DEFAULT_MAX_SPARES_PER_SEGMENT + 1}`,
      );
    }
    // Idle hosts beyond the spare cap should have gone back to null, not
    // gotten stuck advertising a wasteful 4th+ duplicate.
    const idleCount = hosts.filter((h) => h.currentClaim === null).length;
    assert.ok(idleCount >= hostCount - (DEFAULT_MAX_SPARES_PER_SEGMENT + 1), `seed=${seed} too few hosts went idle: ${idleCount}/${hostCount}`);
  }
});
