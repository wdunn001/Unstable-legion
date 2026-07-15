/**
 * stagePlanner unit tests — capacity math, stability ordering, cache
 * preference, hot-spare designation, and degenerate cases.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planPipeline,
  filterStageHosts,
  hostCapacityBytes,
  hostStabilityScore,
  layerFragmentId,
  type RosterEntryWithStageHost,
  type StagePipelineRequest,
} from '../src/stagePlanner.ts';
import type { MeshRosterEntry } from '../src/types.ts';

// ── Fixture builder ───────────────────────────────────────────────────────

function stageHost(
  peerId: string,
  overrides: Partial<NonNullable<MeshRosterEntry['stageHost']>> = {},
): RosterEntryWithStageHost {
  const base: MeshRosterEntry = {
    peerId,
    lastSeen: 1000,
    v: 1 as const,
    ts: 1000,
    nick: peerId,
    modelId: 'qwen3-0.6b-q8_0',
    available: true,
    skills: [],
    systemPromptSummary: '',
    tools: [],
  };
  return {
    ...base,
    stageHost: {
      maxStorageBufferBytes: 1_000_000_000,
      wasmHeapBudget: 1_000_000_000,
      ...overrides,
    },
  };
}

const REQ: StagePipelineRequest = {
  modelId: 'qwen3-0.6b-q8_0',
  totalLayers: 28,
  avgLayerBytes: 22_000_000, // ~22MB/layer per SLICING.md
  nEmbd: 1024,
};

// ── capacity math ─────────────────────────────────────────────────────────

test('hostCapacityBytes: min(vramBytes, wasmHeapBudget, maxStorageBufferBytes)', () => {
  assert.equal(
    hostCapacityBytes({ vramBytes: 8e9, wasmHeapBudget: 2e9, maxStorageBufferBytes: 4e9 }),
    2e9,
  );
  // vramBytes absent -> falls back to maxStorageBufferBytes as the effective vram.
  assert.equal(
    hostCapacityBytes({ wasmHeapBudget: 3e9, maxStorageBufferBytes: 1e9 }),
    1e9,
  );
});

test('planPipeline: single host with ample capacity gets the whole model, isFirst+isFinal', () => {
  const hosts = [stageHost('solo', { vramBytes: 2_000_000_000 })];
  const plan = planPipeline(REQ, hosts);
  assert.ok(plan);
  assert.equal(plan!.stages.length, 1);
  assert.equal(plan!.stages[0]!.peerId, 'solo');
  assert.equal(plan!.stages[0]!.isFirst, true);
  assert.equal(plan!.stages[0]!.isFinal, true);
  assert.equal(plan!.stages[0]!.layerStart, 0);
  assert.equal(plan!.stages[0]!.layerEnd, 28);
  assert.equal(plan!.perTokenHopBytes, 0); // single stage, no hops
});

test('planPipeline: minimizes stage count — prefers 1 strong host over splitting across weak ones', () => {
  const strong = stageHost('strong', { vramBytes: 1_000_000_000 }); // fits all 28 layers alone
  const weak1 = stageHost('weak1', { vramBytes: 100_000_000 });
  const weak2 = stageHost('weak2', { vramBytes: 100_000_000 });
  const plan = planPipeline(REQ, [weak1, weak2, strong]);
  assert.ok(plan);
  assert.equal(plan!.stages.length, 1);
  assert.equal(plan!.stages[0]!.peerId, 'strong');
});

test('planPipeline: splits proportionally across hosts when no single host fits', () => {
  // Total need: 28 * 22MB = 616MB. Two hosts, 3:1 VRAM ratio, each individually too small.
  const big = stageHost('big', { vramBytes: 480_000_000 });
  const small = stageHost('small', { vramBytes: 160_000_000 });
  const plan = planPipeline(REQ, [big, small], { wantHotSpare: false });
  assert.ok(plan);
  assert.equal(plan!.stages.length, 2);
  const total = plan!.stages.reduce((a, s) => a + (s.layerEnd - s.layerStart), 0);
  assert.equal(total, 28);
  // Bigger host gets more layers (weighted split).
  const bigStage = plan!.stages.find((s) => s.peerId === 'big')!;
  const smallStage = plan!.stages.find((s) => s.peerId === 'small')!;
  assert.ok(bigStage.layerEnd - bigStage.layerStart > smallStage.layerEnd - smallStage.layerStart);
  // Contiguous, covering [0, 28).
  const sorted = [...plan!.stages].sort((a, b) => a.layerStart - b.layerStart);
  assert.equal(sorted[0]!.layerStart, 0);
  assert.equal(sorted[0]!.layerEnd, sorted[1]!.layerStart);
  assert.equal(sorted[1]!.layerEnd, 28);
  // Exactly one isFirst and one isFinal.
  assert.equal(plan!.stages.filter((s) => s.isFirst).length, 1);
  assert.equal(plan!.stages.filter((s) => s.isFinal).length, 1);
  // Hop cost is nonzero for a 2-stage plan.
  assert.ok(plan!.perTokenHopBytes > 0);
});

test('planPipeline: uneven layerBytes can force more stages than uniform math would suggest', () => {
  // 4 layers, wildly uneven sizes; two hosts each only fit half the bytes.
  const layerBytes = [10, 10, 500, 10]; // layer 2 is huge
  const req: StagePipelineRequest = { modelId: 'm', totalLayers: 4, layerBytes, nEmbd: 8 };
  const h1 = stageHost('h1', { vramBytes: 300 });
  const h2 = stageHost('h2', { vramBytes: 300 });
  // Uniform 2-layer/2-layer weighted split would give h1 or h2 the big
  // layer-2 (500 bytes) which busts a 300-byte capacity — planner must
  // reject k=2 here as infeasible and fall through (no host can ever fit
  // layer 2 alone at this capacity, so this must return null).
  const plan = planPipeline(req, [h1, h2], { wantHotSpare: false });
  assert.equal(plan, null);
});

// ── stability ordering ────────────────────────────────────────────────────

test('hostStabilityScore: keepalive+visible+pinned outrank raw uptime; onBattery penalized', () => {
  const stableDesktop = hostStabilityScore({
    maxStorageBufferBytes: 1,
    wasmHeapBudget: 1,
    stability: { keepalive: true, visible: true, pinned: true, uptimeMs: 3_600_000 },
  });
  const freshTab = hostStabilityScore({
    maxStorageBufferBytes: 1,
    wasmHeapBudget: 1,
    stability: { keepalive: false, visible: true, uptimeMs: 40_000 },
  });
  assert.ok(stableDesktop > freshTab);

  const onBattery = hostStabilityScore({
    maxStorageBufferBytes: 1,
    wasmHeapBudget: 1,
    stability: { keepalive: true, visible: true, onBattery: true, uptimeMs: 0 },
  });
  const onAc = hostStabilityScore({
    maxStorageBufferBytes: 1,
    wasmHeapBudget: 1,
    stability: { keepalive: true, visible: true, onBattery: false, uptimeMs: 0 },
  });
  assert.ok(onAc > onBattery);
});

test('planPipeline: at equal capacity, prefers the more stable host for the single-stage slot', () => {
  const freshTab = stageHost('fresh', {
    vramBytes: 1_000_000_000,
    stability: { keepalive: false, visible: true, uptimeMs: 40_000 },
  });
  const stableDesktop = stageHost('stable', {
    vramBytes: 1_000_000_000,
    stability: { keepalive: true, visible: true, pinned: true, uptimeMs: 3_600_000 },
  });
  const plan = planPipeline(REQ, [freshTab, stableDesktop], { wantHotSpare: false });
  assert.ok(plan);
  assert.equal(plan!.stages.length, 1);
  assert.equal(plan!.stages[0]!.peerId, 'stable');
});

// ── cache preference ──────────────────────────────────────────────────────

test('layerFragmentId: zero-padded 5-digit convention matching SLICING.md', () => {
  assert.equal(layerFragmentId(0), 'layer-00000');
  assert.equal(layerFragmentId(21), 'layer-00021');
});

test('planPipeline: prefers assigning a host the range it already has cached', () => {
  // Two equal-capacity hosts splitting 28 layers ~evenly (14/14). Host
  // "early" has layers 0-13 cached; host "late" has layers 14-27 cached.
  // The cache-aware ordering should assign "early" the [0,14) range and
  // "late" the [14,28) range (not the reverse), maximizing hit fraction.
  const earlyFrags = Array.from({ length: 14 }, (_, i) => layerFragmentId(i));
  const lateFrags = Array.from({ length: 14 }, (_, i) => layerFragmentId(i + 14));
  const early = stageHost('early', { vramBytes: 400_000_000, cachedFragments: earlyFrags });
  const late = stageHost('late', { vramBytes: 400_000_000, cachedFragments: lateFrags });
  // Feed in reversed order to make sure the planner isn't just trusting input order.
  const plan = planPipeline(REQ, [late, early], { wantHotSpare: false });
  assert.ok(plan);
  const earlyStage = plan!.stages.find((s) => s.peerId === 'early')!;
  const lateStage = plan!.stages.find((s) => s.peerId === 'late')!;
  assert.equal(earlyStage.layerStart, 0);
  assert.equal(lateStage.layerEnd, 28);
  assert.ok(earlyStage.cacheHitFraction > 0.9);
  assert.ok(lateStage.cacheHitFraction > 0.9);
});

// ── hot spare designation ─────────────────────────────────────────────────

test('planPipeline: designates a hot spare when an eligible extra host exists', () => {
  const solo = stageHost('solo', { vramBytes: 2_000_000_000 });
  const spare = stageHost('spare', { vramBytes: 2_000_000_000 });
  const plan = planPipeline(REQ, [solo, spare]);
  assert.ok(plan);
  assert.equal(plan!.stages.length, 1); // only needs 1 stage
  assert.equal(plan!.hotSparePeerId, 'spare');
});

test('planPipeline: no hot spare when wantHotSpare is false', () => {
  const solo = stageHost('solo', { vramBytes: 2_000_000_000 });
  const spare = stageHost('spare', { vramBytes: 2_000_000_000 });
  const plan = planPipeline(REQ, [solo, spare], { wantHotSpare: false });
  assert.ok(plan);
  assert.equal(plan!.hotSparePeerId, undefined);
});

test('planPipeline: no hot spare when every eligible host is already used by the plan', () => {
  const big = stageHost('big', { vramBytes: 480_000_000 });
  const small = stageHost('small', { vramBytes: 160_000_000 });
  const plan = planPipeline(REQ, [big, small]); // both needed to fit -> no spare left
  assert.ok(plan);
  assert.equal(plan!.stages.length, 2);
  assert.equal(plan!.hotSparePeerId, undefined);
});

// ── degenerate cases ───────────────────────────────────────────────────────

test('planPipeline: no hosts -> null', () => {
  assert.equal(planPipeline(REQ, []), null);
});

test('planPipeline: no host can fit even combined -> null', () => {
  const tiny1 = stageHost('t1', { vramBytes: 1000 });
  const tiny2 = stageHost('t2', { vramBytes: 1000 });
  assert.equal(planPipeline(REQ, [tiny1, tiny2]), null);
});

test('planPipeline: excludePeerIds removes a host from candidacy (replan scenario)', () => {
  const a = stageHost('a', { vramBytes: 2_000_000_000 });
  const b = stageHost('b', { vramBytes: 2_000_000_000 });
  const plan = planPipeline(REQ, [a, b], { excludePeerIds: ['a'], wantHotSpare: false });
  assert.ok(plan);
  assert.equal(plan!.stages.length, 1);
  assert.equal(plan!.stages[0]!.peerId, 'b');
});

test('planPipeline: unavailable hosts are skipped by default', () => {
  const avail = stageHost('avail', { vramBytes: 2_000_000_000 });
  const unavail = { ...stageHost('unavail', { vramBytes: 2_000_000_000 }), available: false };
  const plan = planPipeline(REQ, [avail, unavail], { wantHotSpare: false });
  assert.ok(plan);
  assert.equal(plan!.stages.length, 1);
  assert.equal(plan!.stages[0]!.peerId, 'avail');
});

test('planPipeline: totalLayers <= 0 throws', () => {
  assert.throws(() => planPipeline({ ...REQ, totalLayers: 0 }, [stageHost('x')]));
});

test('planPipeline: request without layerBytes or avgLayerBytes throws', () => {
  const badReq = { modelId: 'm', totalLayers: 4, nEmbd: 8 } as StagePipelineRequest;
  assert.throws(() => planPipeline(badReq, [stageHost('x', { vramBytes: 1e9 })]));
});

// ── filterStageHosts ───────────────────────────────────────────────────────

test('filterStageHosts: drops peers without a stageHost cap', () => {
  const withCap = stageHost('a');
  const withoutCap: MeshRosterEntry = { ...withCap, stageHost: undefined };
  const filtered = filterStageHosts([withCap, withoutCap]);
  assert.deepEqual(filtered.map((h) => h.peerId), ['a']);
});

test('filterStageHosts: excludePeerIds + includeUnavailable options', () => {
  const a = stageHost('a');
  const b = { ...stageHost('b'), available: false };
  assert.deepEqual(filterStageHosts([a, b]).map((h) => h.peerId), ['a']);
  assert.deepEqual(
    filterStageHosts([a, b], { includeUnavailable: true }).map((h) => h.peerId).sort(),
    ['a', 'b'],
  );
  assert.deepEqual(filterStageHosts([a, b], { excludePeerIds: ['a'] }).map((h) => h.peerId), []);
});
