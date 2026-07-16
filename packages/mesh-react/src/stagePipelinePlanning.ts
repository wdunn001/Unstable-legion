/**
 * Pure helpers gluing this peer's local WebGPU capability + the mesh
 * roster into planner inputs. No React, no I/O — same "pure function"
 * discipline as `stagePlanner.ts` itself, so these are unit-testable with
 * `node --test` and cheap to call on every roster tick.
 *
 * ── Why the driver's local stage isn't a `planPipeline` candidate ───────
 *
 * `stageOrchestrator.ts`'s SCOPE NOTE hard-assumes "the local peer always
 * runs stage 0" — it never sends `stage.load`/`sf` to stage 0, it just
 * calls `localHooks` directly. But `planPipeline` has no "pin this
 * candidate to index 0" knob: index-0 (isFirst) falls out of a
 * capacity/stability ranking, and in this demo all peers share ONE
 * physical GPU (same adapter, near-identical `maxStorageBufferBytes`),
 * so capacity ties are the common case, not the exception — feeding the
 * local peer into `planPipeline` alongside remotes would make "does the
 * driver end up running stage 0" a coin flip instead of a guarantee.
 *
 * `planPipelineForDriver` sidesteps the whole problem structurally:
 * the local peer NEVER enters `planPipeline`'s candidate pool. Instead:
 *
 *   1. A capacity-weighted 2-way split (`splitLayerRangesWeighted`, the
 *      same primitive `stagePlanner.ts` itself uses) divides the model
 *      between "local" and "the strongest single remote host" — this
 *      decides how many layers stay on the driver.
 *   2. The REMAINING layer range is planned properly via `planPipeline`
 *      across ALL remote hosts (not just the strongest one) — so
 *      multi-remote splitting and hot-spare selection still go through
 *      the real planner, just re-based to start at layer 0 of the
 *      remainder and offset back afterward.
 *   3. A synthetic stage-0 entry for the local peer is prepended, and
 *      the remote sub-plan's stages are shifted +1 / offset by the local
 *      cut — producing one seamless `StagePlan` covering [0, totalLayers).
 *
 * This is a deliberate simplification (documented in the workstream brief
 * as "configure planner input so remote hosts get chosen
 * deterministically") — a true joint local+remote optimization is future
 * work; for a 2-3 peer demo, "local gets a capacity-proportional cut,
 * remote splits the rest" covers the acceptance shape (2-stage split,
 * hot spare, chaos replan) without needing `planPipeline` itself to grow
 * a "pin index 0" concept.
 */
import {
  filterStageHosts,
  hostCapacityBytes,
  hostStabilityScore,
  planPipeline,
  type MeshLoadedStage,
  type MeshPeerCap,
  type MeshRosterEntry,
  type PlanPipelineOptions,
  type PlannedStage,
  type RosterEntryWithStageHost,
  type StageHostCap,
  type StagePipelineRequest,
  type StagePlan,
} from '@unstable-legion/core';
import { activationBytes, splitLayerRangesWeighted } from '@unstable-legion/stage-runtime';

// ── Local capability → stageHost cap ────────────────────────────────────

export interface StageHostLimits {
  /** WebGPU `adapter.limits.maxStorageBufferBindingSize` (or equivalent). */
  maxStorageBufferBindingSize: number;
  /** Best-effort VRAM estimate, when available. */
  vramBytes?: number;
}

export interface StageHostStabilityInputs {
  keepalive: boolean;
  pinned?: boolean;
  visible: boolean;
  onBattery?: boolean;
  uptimeMs: number;
}

/**
 * A wasm32 linear-memory instance tops out at 4GB, and Chrome's actual
 * ceiling for a single wasm memory is lower in practice; 1.6GB is a
 * conservative "won't OOM the worker" budget that still comfortably fits
 * a full qwen3-0.6b stage. Exported so tests/UI can reference the same
 * constant instead of a magic number.
 */
export const WASM_HEAP_CEILING_BYTES = 1_600_000_000;

/** min(adapter limit, WASM_HEAP_CEILING_BYTES), with a safe fallback for a
 * missing/zero/NaN adapter limit (feature-detect failure). */
export function sanitizeWasmHeapBudget(maxStorageBufferBindingSize: number): number {
  if (!Number.isFinite(maxStorageBufferBindingSize) || maxStorageBufferBindingSize <= 0) {
    return WASM_HEAP_CEILING_BYTES;
  }
  return Math.min(maxStorageBufferBindingSize, WASM_HEAP_CEILING_BYTES);
}

/** M2: session-capacity fields to layer onto `buildStageHostCap`'s
 * output — separate from `StageHostStabilityInputs` because they're only
 * known once a stage is actually loaded (a host that hasn't loaded
 * anything yet has no `maxSessions` committed and no `activeSessions`). */
export interface StageHostSessionCapacity {
  maxSessions: number;
  activeSessions: number;
}

/** Build the `MeshPeerCap.stageHost` block this peer should advertise.
 * `loadedStages` (M3) is passed straight through when non-empty — this
 * function doesn't compute it (`useStageHost.ts` derives it from its own
 * `workerClient`/`hostSessions` state, `useCommunalHost.ts` from its own
 * assembly-loop state), it just carries it onto the wire shape. */
export function buildStageHostCap(
  limits: StageHostLimits,
  stability: StageHostStabilityInputs,
  cachedFragments?: readonly string[],
  sessionCapacity?: StageHostSessionCapacity,
  loadedStages?: readonly MeshLoadedStage[],
): NonNullable<MeshPeerCap['stageHost']> {
  return {
    ...(limits.vramBytes !== undefined ? { vramBytes: limits.vramBytes } : {}),
    maxStorageBufferBytes: limits.maxStorageBufferBindingSize,
    wasmHeapBudget: sanitizeWasmHeapBudget(limits.maxStorageBufferBindingSize),
    ...(cachedFragments && cachedFragments.length > 0 ? { cachedFragments } : {}),
    ...(sessionCapacity ? { maxSessions: sessionCapacity.maxSessions, activeSessions: sessionCapacity.activeSessions } : {}),
    ...(loadedStages && loadedStages.length > 0 ? { loadedStages } : {}),
    stability: {
      keepalive: stability.keepalive,
      visible: stability.visible,
      uptimeMs: Math.max(0, Math.round(stability.uptimeMs)),
      ...(stability.pinned !== undefined ? { pinned: stability.pinned } : {}),
      ...(stability.onBattery !== undefined ? { onBattery: stability.onBattery } : {}),
    },
  };
}

// ── M2: max concurrent sessions, chosen once at load time ──────────────
//
// A host commits its session capacity when it LOADS the stage, not
// elastically per-request — legion-stage-runtime's docs/MULTI-SESSION.md:
// skippy sessions are lanes (llama seq_ids) into ONE shared per-model
// llama_context, and `lane_count` is fixed at `legion_stage_open` time.
// `chooseMaxSessions` is the one place that decides the number passed to
// `StageDescriptor.maxSessions` — deliberately NOT derived from
// `perSessionKvBytes`/KV-budget math: M1 measured the WebGPU KV buffer as
// IDENTICAL at max_sessions=1 vs 4 in the reference build, so that
// formula is a conservative planning upper bound for VRAM headroom, not a
// real per-session cost, and using it to size the lane ceiling would
// under-provision concurrency for no real memory savings.

/** Default session capacity a host commits to when it hasn't been told
 * otherwise — generous enough for a small multi-tab demo, well under the
 * hard cap. */
export const DEFAULT_MAX_SESSIONS = 4;

/** Hard ceiling on session capacity regardless of `desired` — a sanity
 * bound (skippy's lane bitmap + KV cache are real resources even though
 * M1 showed their cost doesn't scale linearly with observed usage; this
 * isn't a measured limit, just "don't let a host promise the world"). */
export const MAX_SESSIONS_HARD_CAP = 8;

/** Clamp a desired session ceiling into `[1, MAX_SESSIONS_HARD_CAP]`,
 * defaulting to `DEFAULT_MAX_SESSIONS` when `desired` is absent/non-finite. */
export function chooseMaxSessions(desired?: number): number {
  if (desired === undefined || !Number.isFinite(desired)) return DEFAULT_MAX_SESSIONS;
  return Math.min(MAX_SESSIONS_HARD_CAP, Math.max(1, Math.round(desired)));
}

/** Minimal `StageHostCap` for capacity math only (no stability block —
 * used by `useStagePipeline` to weigh its OWN local stage-0 budget
 * against remote candidates; it never advertises this over the wire). */
export function buildLocalCapacityCap(limits: StageHostLimits): StageHostCap {
  return {
    ...(limits.vramBytes !== undefined ? { vramBytes: limits.vramBytes } : {}),
    maxStorageBufferBytes: limits.maxStorageBufferBindingSize,
    wasmHeapBudget: sanitizeWasmHeapBudget(limits.maxStorageBufferBindingSize),
  };
}

// ── Driver-side plan assembly ───────────────────────────────────────────

function rangeBytes(req: StagePipelineRequest, layerStart: number, layerEnd: number): number {
  if (req.layerBytes) {
    let sum = 0;
    for (let i = layerStart; i < layerEnd; i++) sum += req.layerBytes[i]!;
    return sum;
  }
  return req.avgLayerBytes! * (layerEnd - layerStart);
}

export interface PlanPipelineForDriverOptions extends PlanPipelineOptions {
  wireDtype?: 'f32' | 'f16';
}

/**
 * Plan a full-model pipeline with the LOCAL peer (`selfId`) always
 * occupying stage 0, and the remainder planned across `roster`'s
 * stage-hosting peers (self excluded automatically). Returns `null` when
 * no remote host can cover the remainder (mirrors `planPipeline`'s
 * `null` contract for "no feasible plan").
 */
export function planPipelineForDriver(
  req: StagePipelineRequest,
  selfId: string,
  localCap: StageHostCap,
  roster: readonly MeshRosterEntry[],
  opts: PlanPipelineForDriverOptions = {},
): StagePlan | null {
  // Deterministic ordering — capacity desc, stability desc, peerId asc as
  // a final tiebreak so two GPU-identical peers (common in a single-
  // adapter test rig) still resolve the same way every time regardless of
  // roster iteration order. `planPipeline`'s OWN internal ranking is a
  // STABLE sort with no peerId tiebreak, so pre-sorting here (rather than
  // just picking `strongestRemote` locally) is what actually makes ITS
  // eventual host selection deterministic too — not just this function's
  // local/remote weight split.
  const remoteHosts: RosterEntryWithStageHost[] = filterStageHosts(roster, {
    excludePeerIds: [...(opts.excludePeerIds ?? []), selfId],
    includeUnavailable: opts.includeUnavailable,
  }).sort((a, b) => {
    const capDiff = hostCapacityBytes(b.stageHost) - hostCapacityBytes(a.stageHost);
    if (capDiff !== 0) return capDiff;
    const stabDiff = hostStabilityScore(b.stageHost) - hostStabilityScore(a.stageHost);
    if (stabDiff !== 0) return stabDiff;
    return a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0;
  });
  if (remoteHosts.length === 0) return null;

  const localBytes = hostCapacityBytes(localCap);
  const strongestRemote = remoteHosts[0]!;

  const [localRange, remoteRange] = splitLayerRangesWeighted(req.totalLayers, [
    localBytes,
    hostCapacityBytes(strongestRemote.stageHost),
  ]);

  const remoteLayerCount = remoteRange!.layerEnd - remoteRange!.layerStart;
  const subReq: StagePipelineRequest = {
    modelId: req.modelId,
    totalLayers: remoteLayerCount,
    nEmbd: req.nEmbd,
    ...(req.layerBytes
      ? { layerBytes: req.layerBytes.slice(remoteRange!.layerStart, remoteRange!.layerEnd) }
      : { avgLayerBytes: req.avgLayerBytes }),
  };
  const subPlan = planPipeline(subReq, remoteHosts, opts);
  if (!subPlan) return null;

  const localStage: PlannedStage = {
    stageIndex: 0,
    peerId: selfId,
    layerStart: 0,
    layerEnd: localRange!.layerEnd,
    isFirst: true,
    isFinal: subPlan.stages.length === 0,
    capacityBytes: localBytes,
    assignedBytes: rangeBytes(req, 0, localRange!.layerEnd),
    cacheHitFraction: 0,
  };

  const remoteStages: PlannedStage[] = subPlan.stages.map((s, i) => ({
    ...s,
    stageIndex: i + 1,
    layerStart: s.layerStart + localRange!.layerEnd,
    layerEnd: s.layerEnd + localRange!.layerEnd,
    isFirst: false,
    isFinal: i === subPlan.stages.length - 1,
  }));

  const stages = [localStage, ...remoteStages];
  const wireDtype = opts.wireDtype ?? 'f16';
  const perTokenHopBytes = stages.length > 1 ? activationBytes(1, req.nEmbd, wireDtype) * (stages.length - 1) : 0;

  return {
    modelId: req.modelId,
    totalLayers: req.totalLayers,
    stages,
    hotSparePeerId: subPlan.hotSparePeerId,
    perTokenHopBytes,
    unselectedPeerIds: subPlan.unselectedPeerIds,
  };
}
