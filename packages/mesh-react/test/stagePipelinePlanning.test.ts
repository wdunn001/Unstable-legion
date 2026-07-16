/**
 * Pure unit tests for `stagePipelinePlanning.ts` — no React, no WebGPU, no
 * mesh. Mirrors the fixture style of mesh-core's `stagePlanner.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLocalCapacityCap,
  buildStageHostCap,
  planPipelineForDriver,
  sanitizeWasmHeapBudget,
  sanitizeWeightBudget,
  chooseMaxSessions,
  WASM_HEAP_CEILING_BYTES,
  CONTRIBUTION_BUDGET_CEILING_BYTES,
} from '../src/stagePipelinePlanning.ts';
import type { MeshRosterEntry } from '@unstable-legion/core';

// ── Fixture builder (mirrors mesh-core's stagePlanner.test.ts) ──────────

function stageHostEntry(
  peerId: string,
  overrides: Partial<NonNullable<MeshRosterEntry['stageHost']>> = {},
): MeshRosterEntry {
  return {
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
    stageHost: {
      maxStorageBufferBytes: 1_000_000_000,
      wasmHeapBudget: 1_000_000_000,
      ...overrides,
    },
  };
}

const REQ = {
  modelId: 'qwen3-0.6b-q8_0',
  totalLayers: 28,
  avgLayerBytes: 22_000_000,
  nEmbd: 1024,
};

// ── sanitizeWasmHeapBudget / buildLocalCapacityCap ───────────────────────

test('sanitizeWasmHeapBudget: caps at WASM_HEAP_CEILING_BYTES, falls back on bad input', () => {
  assert.equal(sanitizeWasmHeapBudget(500_000_000), 500_000_000);
  assert.equal(sanitizeWasmHeapBudget(8_000_000_000), WASM_HEAP_CEILING_BYTES);
  assert.equal(sanitizeWasmHeapBudget(0), WASM_HEAP_CEILING_BYTES);
  assert.equal(sanitizeWasmHeapBudget(Number.NaN), WASM_HEAP_CEILING_BYTES);
  assert.equal(sanitizeWasmHeapBudget(-5), WASM_HEAP_CEILING_BYTES);
});

// ── sanitizeWeightBudget (contribute-more: weight budget decoupled from wasmHeapBudget) ──

test('sanitizeWeightBudget: no contributionBudgetBytes override -> EXACT same figure as sanitizeWasmHeapBudget (default unchanged, ~11 layers for Qwen3-8B)', () => {
  const limits = { maxStorageBufferBindingSize: 8_000_000_000 };
  const CHAT_AVG_LAYER_BYTES = 140_000_000;
  const weight = sanitizeWeightBudget(limits, { minBytes: CHAT_AVG_LAYER_BYTES });
  assert.equal(weight, sanitizeWasmHeapBudget(limits.maxStorageBufferBindingSize));
  assert.equal(weight, WASM_HEAP_CEILING_BYTES);
  assert.equal(Math.floor(weight / CHAT_AVG_LAYER_BYTES), 11);
});

test('sanitizeWeightBudget: an override raises the budget past the wasm-heap ceiling — claim capacity actually grows', () => {
  const limits = { maxStorageBufferBindingSize: 24_000_000_000, contributionBudgetBytes: 12_000_000_000 };
  const CHAT_AVG_LAYER_BYTES = 140_000_000;
  const weight = sanitizeWeightBudget(limits, { minBytes: CHAT_AVG_LAYER_BYTES });
  assert.equal(weight, 12_000_000_000);
  assert.ok(weight > WASM_HEAP_CEILING_BYTES);
  const layers = Math.floor(weight / CHAT_AVG_LAYER_BYTES);
  assert.ok(layers > 11, `expected >11 layers with a raised budget, got ${layers}`);
});

test('sanitizeWeightBudget: an override is clamped to CONTRIBUTION_BUDGET_CEILING_BYTES (~32GB), never unbounded', () => {
  const limits = { maxStorageBufferBindingSize: 100_000_000_000, contributionBudgetBytes: 999_000_000_000 };
  assert.equal(sanitizeWeightBudget(limits), CONTRIBUTION_BUDGET_CEILING_BYTES);
});

test('sanitizeWeightBudget: an override below minBytes is clamped UP to minBytes (never affords zero layers)', () => {
  const limits = { maxStorageBufferBindingSize: 8_000_000_000, contributionBudgetBytes: 1000 }; // absurdly small
  const minBytes = 140_000_000;
  assert.equal(sanitizeWeightBudget(limits, { minBytes }), minBytes);
});

test('sanitizeWeightBudget: a bad override (0, negative, NaN) falls back to the safe default, never throws', () => {
  const base = { maxStorageBufferBindingSize: 2_000_000_000 };
  const fallback = sanitizeWasmHeapBudget(base.maxStorageBufferBindingSize);
  assert.equal(sanitizeWeightBudget({ ...base, contributionBudgetBytes: 0 }), fallback);
  assert.equal(sanitizeWeightBudget({ ...base, contributionBudgetBytes: -5 }), fallback);
  assert.equal(sanitizeWeightBudget({ ...base, contributionBudgetBytes: Number.NaN }), fallback);
});

test('sanitizeWeightBudget: does NOT affect wasmHeapBudget/chooseMaxSessions — a big weight budget never inflates session sizing', () => {
  const limits = { maxStorageBufferBindingSize: 24_000_000_000, contributionBudgetBytes: 24_000_000_000 };
  // wasmHeapBudget is computed straight from maxStorageBufferBindingSize,
  // completely independent of contributionBudgetBytes.
  assert.equal(sanitizeWasmHeapBudget(limits.maxStorageBufferBindingSize), WASM_HEAP_CEILING_BYTES);
  // chooseMaxSessions has no contribution-budget parameter at all — a big
  // weight budget structurally cannot reach it.
  assert.equal(chooseMaxSessions(undefined), 4);
  assert.equal(chooseMaxSessions(4), 4);
});

test('buildStageHostCap: contributionBudgetBytes populates the cap\'s vramBytes when the real detected vramBytes is absent (WebGPU never exposes it)', () => {
  const cap = buildStageHostCap(
    { maxStorageBufferBindingSize: 1_200_000_000, contributionBudgetBytes: 12_000_000_000 },
    { keepalive: false, visible: true, uptimeMs: 0 },
  );
  assert.equal(cap.vramBytes, 12_000_000_000);
});

test('buildStageHostCap: a REAL detected vramBytes always wins over contributionBudgetBytes', () => {
  const cap = buildStageHostCap(
    { maxStorageBufferBindingSize: 1_200_000_000, vramBytes: 4_000_000_000, contributionBudgetBytes: 12_000_000_000 },
    { keepalive: false, visible: true, uptimeMs: 0 },
  );
  assert.equal(cap.vramBytes, 4_000_000_000);
});

test('buildLocalCapacityCap: min(limit, ceiling), no stability/vram fields', () => {
  const cap = buildLocalCapacityCap({ maxStorageBufferBindingSize: 900_000_000 });
  assert.equal(cap.maxStorageBufferBytes, 900_000_000);
  assert.equal(cap.wasmHeapBudget, 900_000_000);
  assert.equal(cap.vramBytes, undefined);
  assert.equal(cap.stability, undefined);
});

// ── buildStageHostCap ─────────────────────────────────────────────────────

test('buildStageHostCap: assembles a well-formed stageHost block', () => {
  const cap = buildStageHostCap(
    { maxStorageBufferBindingSize: 1_200_000_000, vramBytes: 4_000_000_000 },
    { keepalive: true, visible: true, uptimeMs: 90_000, onBattery: false },
    ['layer-00000', 'layer-00001'],
  );
  assert.equal(cap.vramBytes, 4_000_000_000);
  assert.equal(cap.maxStorageBufferBytes, 1_200_000_000);
  assert.equal(cap.wasmHeapBudget, 1_200_000_000);
  assert.deepEqual(cap.cachedFragments, ['layer-00000', 'layer-00001']);
  assert.equal(cap.stability?.keepalive, true);
  assert.equal(cap.stability?.visible, true);
  assert.equal(cap.stability?.onBattery, false);
  assert.equal(cap.stability?.uptimeMs, 90_000);
});

test('buildStageHostCap: omits cachedFragments when empty, omits optional stability fields when absent', () => {
  const cap = buildStageHostCap(
    { maxStorageBufferBindingSize: 500_000_000 },
    { keepalive: false, visible: false, uptimeMs: 0 },
  );
  assert.equal(cap.cachedFragments, undefined);
  assert.equal(cap.vramBytes, undefined);
  assert.equal(cap.stability?.pinned, undefined);
  assert.equal(cap.stability?.onBattery, undefined);
});

test('buildStageHostCap: negative uptimeMs is clamped to 0', () => {
  const cap = buildStageHostCap({ maxStorageBufferBindingSize: 500_000_000 }, { keepalive: false, visible: true, uptimeMs: -50 });
  assert.equal(cap.stability?.uptimeMs, 0);
});

// ── planPipelineForDriver ──────────────────────────────────────────────

test('planPipelineForDriver: local peer is always stage 0 / isFirst, even when a remote has more capacity', () => {
  const roster = [
    stageHostEntry('remote-strong', { vramBytes: 5_000_000_000 }), // far more capacity than local
  ];
  const localCap = { maxStorageBufferBytes: 300_000_000, wasmHeapBudget: 300_000_000 };
  const plan = planPipelineForDriver(REQ, 'self', localCap, roster, { wantHotSpare: false });
  assert.ok(plan);
  assert.equal(plan!.stages[0]!.peerId, 'self');
  assert.equal(plan!.stages[0]!.stageIndex, 0);
  assert.equal(plan!.stages[0]!.isFirst, true);
  assert.equal(plan!.stages[0]!.layerStart, 0);
  // Contiguous coverage of the whole model.
  const sorted = [...plan!.stages].sort((a, b) => a.layerStart - b.layerStart);
  assert.equal(sorted[0]!.layerStart, 0);
  assert.equal(sorted[sorted.length - 1]!.layerEnd, REQ.totalLayers);
  for (let i = 1; i < sorted.length; i++) {
    assert.equal(sorted[i - 1]!.layerEnd, sorted[i]!.layerStart);
  }
  // Exactly one isFinal, and it's not the local stage (a remote exists).
  const finals = plan!.stages.filter((s) => s.isFinal);
  assert.equal(finals.length, 1);
  assert.notEqual(finals[0]!.peerId, 'self');
});

test('planPipelineForDriver: returns null when there are no remote stage hosts in the roster', () => {
  const localCap = { maxStorageBufferBytes: 300_000_000, wasmHeapBudget: 300_000_000 };
  const plan = planPipelineForDriver(REQ, 'self', localCap, [], {});
  assert.equal(plan, null);
});

test('planPipelineForDriver: excludes self even if a same-id roster entry advertises stageHost (self upsert case)', () => {
  const roster = [
    stageHostEntry('self', { vramBytes: 9_000_000_000 }), // shouldn't be picked as "remote"
    stageHostEntry('remote-1', { vramBytes: 900_000_000 }),
  ];
  const localCap = { maxStorageBufferBytes: 300_000_000, wasmHeapBudget: 300_000_000 };
  const plan = planPipelineForDriver(REQ, 'self', localCap, roster, { wantHotSpare: false });
  assert.ok(plan);
  const remoteStage = plan!.stages.find((s) => s.stageIndex > 0)!;
  assert.equal(remoteStage.peerId, 'remote-1');
});

test('planPipelineForDriver: deterministic remote pick — tied capacity+stability breaks on peerId ascending', () => {
  const roster = [
    stageHostEntry('host-b', { vramBytes: 900_000_000 }),
    stageHostEntry('host-a', { vramBytes: 900_000_000 }),
  ];
  const localCap = { maxStorageBufferBytes: 300_000_000, wasmHeapBudget: 300_000_000 };
  const planA = planPipelineForDriver(REQ, 'self', localCap, roster, { wantHotSpare: true });
  const planB = planPipelineForDriver(REQ, 'self', localCap, [...roster].reverse(), { wantHotSpare: true });
  assert.ok(planA && planB);
  const remoteA = planA!.stages.find((s) => s.stageIndex > 0)!;
  const remoteB = planB!.stages.find((s) => s.stageIndex > 0)!;
  assert.equal(remoteA.peerId, 'host-a');
  assert.equal(remoteB.peerId, 'host-a');
  // The loser becomes the hot spare, not a second active stage.
  assert.equal(planA!.hotSparePeerId, 'host-b');
  assert.equal(planA!.stages.length, 2);
});

test('planPipelineForDriver: replan excludes the lost peer and falls onto the remaining host', () => {
  const roster = [
    stageHostEntry('host-a', { vramBytes: 900_000_000 }),
    stageHostEntry('host-b', { vramBytes: 900_000_000 }),
  ];
  const localCap = { maxStorageBufferBytes: 300_000_000, wasmHeapBudget: 300_000_000 };
  const firstPlan = planPipelineForDriver(REQ, 'self', localCap, roster, {});
  assert.ok(firstPlan);
  const originalRemote = firstPlan!.stages.find((s) => s.stageIndex > 0)!.peerId;

  const replanned = planPipelineForDriver(REQ, 'self', localCap, roster, { excludePeerIds: [originalRemote] });
  assert.ok(replanned);
  const newRemote = replanned!.stages.find((s) => s.stageIndex > 0)!.peerId;
  assert.notEqual(newRemote, originalRemote);
});

test('planPipelineForDriver: perTokenHopBytes is nonzero for a 2-stage plan (local + 1 remote)', () => {
  const roster = [stageHostEntry('host-a', { vramBytes: 900_000_000 })];
  const localCap = { maxStorageBufferBytes: 300_000_000, wasmHeapBudget: 300_000_000 };
  const plan = planPipelineForDriver(REQ, 'self', localCap, roster, { wantHotSpare: false });
  assert.ok(plan);
  assert.equal(plan!.stages.length, 2);
  assert.ok(plan!.perTokenHopBytes > 0);
});
