/**
 * Phase C — pure pipeline-split planner.
 *
 * Turns a roster of stage-capable peers into a `StagePlan`: which peer
 * hosts which contiguous layer range, in which order, plus an optional
 * hot spare. No I/O, no async, no mesh access — same "pure function over
 * a roster snapshot" discipline as `routing.ts`, so it's cheap to call
 * on every roster change and trivial to unit test.
 *
 * Rules (normative source: H:\dev\legion-stage-runtime\docs\SLICING.md +
 * docs/CHAOS.md — read those before changing this file):
 *
 *   1. One contiguous layer range per host (SLICING.md §3, "coalescing
 *      rule") — this planner never splits a host's assignment.
 *   2. Capacity = min(vramBytes ?? maxStorageBufferBytes, wasmHeapBudget,
 *      maxStorageBufferBytes) — a peer's usable budget for one stage.
 *   3. Weight-proportional split via `splitLayerRangesWeighted`
 *      (@unstable-legion/stage-runtime) — capacity is the weight.
 *   4. MINIMIZE stage count (CHAOS.md Layer 4: "2 stages = 2 failure
 *      points and 1 hop; 8 stages = 8 failure points and 7 hops") — the
 *      planner tries k=1,2,3,... hosts and stops at the first k whose
 *      combined capacity actually fits the model, weighted-split
 *      respected.
 *   5. Stability-weighted host choice (CHAOS.md Layer 4) — prefer stable
 *      desktops (keepalive + visible + long uptime) over fresh tabs at
 *      equal capacity.
 *   6. Prefer hosts whose `cachedFragments` already cover the range
 *      they'd be assigned (SLICING.md §2 — cheap failover/replan).
 *   7. Designate a hot spare when an eligible extra host exists
 *      (CHAOS.md Layer 3).
 */
import { splitLayerRangesWeighted, activationBytes, type LayerRange } from '@unstable-legion/stage-runtime';
import type { MeshRosterEntry } from './types.js';

// ── Input shapes ─────────────────────────────────────────────────────────

export interface StagePipelineRequest {
  modelId: string;
  totalLayers: number;
  /**
   * Per-layer size in bytes, indexed by layer number. Preferred over
   * `avgLayerBytes` when known — real models have non-uniform layer
   * sizes (MoE experts, first/last-layer embedding ties, etc.) and this
   * lets capacity math respect that instead of assuming uniform layers.
   */
  layerBytes?: readonly number[];
  /** Uniform per-layer byte estimate, used when `layerBytes` is absent. */
  avgLayerBytes?: number;
  /** Model hidden size — needed for the per-token activation hop-cost estimate. */
  nEmbd: number;
}

export type StageHostCap = NonNullable<MeshRosterEntry['stageHost']>;

/** A roster entry known (at the type level) to carry a stage-hosting cap.
 * Use `filterStageHosts()` to narrow a raw roster snapshot to this type. */
export type RosterEntryWithStageHost = MeshRosterEntry & { stageHost: StageHostCap };

export interface PlanPipelineOptions {
  /** Hard cap on stage count to consider. Default: candidate host count
   * (i.e. no additional cap beyond "don't use more hosts than exist"). */
  maxStages?: number;
  /** Exclude these peerIds from candidacy — e.g. a peer that just died,
   * when replanning. */
  excludePeerIds?: readonly string[];
  /** Wire dtype used for the per-token hop-cost estimate. Default 'f16'. */
  wireDtype?: 'f32' | 'f16';
  /** Designate a hot spare when an eligible extra host exists. Default true. */
  wantHotSpare?: boolean;
  /** Consider `available === false` peers too. Default false (skip them). */
  includeUnavailable?: boolean;
  /** Cap on permutation search for cache-aware host ordering (see
   * `orderForCacheLocality`). Beyond this host count, ordering falls back
   * to a cheaper heuristic instead of exhaustive search. Default 6
   * (6! = 720 permutations — trivial). */
  maxPermutationSearch?: number;
}

// ── Output shapes ────────────────────────────────────────────────────────

export interface PlannedStage {
  stageIndex: number;
  peerId: string;
  layerStart: number;
  layerEnd: number;
  isFirst: boolean;
  isFinal: boolean;
  /** This host's computed capacity budget (bytes). */
  capacityBytes: number;
  /** Bytes actually assigned to this host's range. Always <= capacityBytes. */
  assignedBytes: number;
  /** Fraction [0,1] of this stage's layers already present in the host's
   * `cachedFragments` — 1.0 means a replan onto this host is a free reload. */
  cacheHitFraction: number;
}

export interface StagePlan {
  modelId: string;
  totalLayers: number;
  stages: readonly PlannedStage[];
  /** Peer designated as a warm standby (CHAOS.md Layer 3), if any. */
  hotSparePeerId?: string;
  /** Estimated per-decode-token activation bytes crossing the network,
   * summed over all inter-stage hops (0 for a single-stage plan). */
  perTokenHopBytes: number;
  /** Peers that were considered but not selected (diagnostics — lets a
   * caller/UI/tests explain "why wasn't X picked"). */
  unselectedPeerIds: readonly string[];
}

// ── Plan validity ──────────────────────────────────────────────────────────

export type PlanValidity = { valid: true } | { valid: false; reason: string };

/**
 * Structural invariants a plan MUST satisfy to be executable, checked before
 * a session commits to it. Historically nothing validated a plan — a planner
 * could (and did) emit a route the runtime silently ran wrong, e.g. layers
 * skipped between two stages producing garbage tokens. This catches the
 * malformed shapes early, with a human reason, so the caller can refuse or
 * replan instead of streaming gibberish.
 *
 * Enforced: at least one stage; stages ordered `0..n-1` with no dup/missing
 * index; exactly one `isFirst` (at stageIndex 0, starting at layer 0) and
 * exactly one `isFinal` (the last, ending at `totalLayers`); CONTIGUITY —
 * every boundary meets (`layerStart[i+1] === layerEnd[i]`) so no layer is
 * skipped or double-run; each range non-empty.
 */
export function validateStagePlan(plan: StagePlan): PlanValidity {
  const stages = plan.stages;
  if (stages.length === 0) return { valid: false, reason: 'plan has no stages' };

  const ordered = [...stages].sort((a, b) => a.stageIndex - b.stageIndex);
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i]!.stageIndex !== i) {
      return { valid: false, reason: `stage indexes are not a contiguous 0..${ordered.length - 1} run (saw ${ordered.map((s) => s.stageIndex).join(',')})` };
    }
  }

  const firsts = ordered.filter((s) => s.isFirst);
  if (firsts.length !== 1) return { valid: false, reason: `expected exactly one isFirst stage, found ${firsts.length}` };
  const finals = ordered.filter((s) => s.isFinal);
  if (finals.length !== 1) return { valid: false, reason: `expected exactly one isFinal stage, found ${finals.length}` };
  if (ordered[0]!.isFirst !== true) return { valid: false, reason: 'stage 0 must be isFirst' };
  if (ordered[ordered.length - 1]!.isFinal !== true) return { valid: false, reason: 'the last stage must be isFinal' };

  if (ordered[0]!.layerStart !== 0) return { valid: false, reason: `first stage must start at layer 0, starts at ${ordered[0]!.layerStart}` };
  if (ordered[ordered.length - 1]!.layerEnd !== plan.totalLayers) {
    return { valid: false, reason: `last stage must end at totalLayers (${plan.totalLayers}), ends at ${ordered[ordered.length - 1]!.layerEnd}` };
  }

  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i]!;
    if (s.layerEnd <= s.layerStart) {
      return { valid: false, reason: `stage ${s.stageIndex} has an empty/inverted range [${s.layerStart},${s.layerEnd})` };
    }
    if (i > 0 && s.layerStart !== ordered[i - 1]!.layerEnd) {
      return {
        valid: false,
        reason: `layer discontinuity between stage ${i - 1} [..,${ordered[i - 1]!.layerEnd}) and stage ${i} [${s.layerStart},..) — ${s.layerStart > ordered[i - 1]!.layerEnd ? 'a gap skips layers' : 'an overlap double-runs layers'}`,
      };
    }
  }

  return { valid: true };
}

// ── Fragment-id convention (SLICING.md §2 "layer-00000.gguf" naming) ────

/** Canonical per-layer artifact fragment id, matching the
 * `layers/layer-00000.gguf` naming in SLICING.md (extension-less — the
 * cap advertises fragment identity, not a URL). */
export function layerFragmentId(layerIndex: number): string {
  return `layer-${String(layerIndex).padStart(5, '0')}`;
}

// ── Roster filtering ──────────────────────────────────────────────────────

/** Narrow a raw roster snapshot to peers that advertised a `stageHost`
 * cap, optionally excluding specific peerIds (e.g. a peer that just
 * died, for a replan). */
export function filterStageHosts(
  roster: readonly MeshRosterEntry[],
  opts: { excludePeerIds?: readonly string[]; includeUnavailable?: boolean } = {},
): RosterEntryWithStageHost[] {
  const excluded = new Set(opts.excludePeerIds ?? []);
  return roster.filter((p): p is RosterEntryWithStageHost => {
    if (!p.stageHost) return false;
    if (excluded.has(p.peerId)) return false;
    if (!opts.includeUnavailable && p.available === false) return false;
    return true;
  });
}

// ── Capacity + stability scoring ─────────────────────────────────────────

/** capacity = min(vramBytes ?? maxStorageBufferBytes, wasmHeapBudget, maxStorageBufferBytes). */
export function hostCapacityBytes(cap: StageHostCap): number {
  const effectiveVram = cap.vramBytes ?? cap.maxStorageBufferBytes;
  return Math.min(effectiveVram, cap.wasmHeapBudget, cap.maxStorageBufferBytes);
}

/**
 * Stability score (higher = more preferred). Not a probability or a
 * calibrated unit — just a monotonic ordering key per CHAOS.md Layer 4:
 * keepalive + visible + pinned all outrank raw uptime; onBattery
 * deprioritizes. A peer with no `stability` block scores 0 (least
 * preferred among otherwise-equal-capacity peers — matches "a phone tab
 * that joined 40s ago" being the implicit default).
 */
export function hostStabilityScore(cap: StageHostCap): number {
  const s = cap.stability;
  if (!s) return 0;
  let score = 0;
  if (s.pinned) score += 5000;
  if (s.keepalive) score += 2000;
  if (s.visible) score += 1000;
  if (s.onBattery) score -= 750;
  // Uptime contributes but is capped so it can never out-rank the
  // qualitative signals above (an hour+ of uptime maxes this term).
  score += Math.min(s.uptimeMs / 1000, 3600);
  return score;
}

function totalRequestBytes(req: StagePipelineRequest): number {
  if (req.layerBytes) return req.layerBytes.reduce((a, b) => a + b, 0);
  if (req.avgLayerBytes !== undefined) return req.avgLayerBytes * req.totalLayers;
  throw new RangeError('planPipeline: request must supply either layerBytes or avgLayerBytes');
}

function rangeBytes(req: StagePipelineRequest, range: LayerRange): number {
  if (req.layerBytes) {
    let sum = 0;
    for (let i = range.layerStart; i < range.layerEnd; i++) sum += req.layerBytes[i]!;
    return sum;
  }
  return req.avgLayerBytes! * (range.layerEnd - range.layerStart);
}

function cacheHitFraction(host: RosterEntryWithStageHost, range: LayerRange): number {
  const size = range.layerEnd - range.layerStart;
  if (size <= 0) return 0;
  const cached = new Set(host.stageHost.cachedFragments ?? []);
  if (cached.size === 0) return 0;
  let hits = 0;
  for (let i = range.layerStart; i < range.layerEnd; i++) {
    if (cached.has(layerFragmentId(i))) hits++;
  }
  return hits / size;
}

/**
 * Choose the assignment of `hosts` (already selected as the winning
 * k-host set, in arbitrary input order) to `sizes` (the k contiguous
 * range sizes computed by `splitLayerRangesWeighted`, order-independent
 * per host — see the module-level derivation note in `planPipeline`)
 * that maximizes total cache-hit overlap. Exhaustive for small k
 * (`maxPermutationSearch`), otherwise falls back to a cheap heuristic:
 * sort hosts by their best-matching cached fragment's layer index.
 */
function orderForCacheLocality(
  hosts: readonly RosterEntryWithStageHost[],
  sizes: readonly number[],
  maxPermutationSearch: number,
): RosterEntryWithStageHost[] {
  const k = hosts.length;
  if (k <= 1) return [...hosts];

  const boundsFor = (order: number[]): LayerRange[] => {
    const ranges: LayerRange[] = [];
    let start = 0;
    for (const idx of order) {
      const size = sizes[idx]!;
      ranges.push({ layerStart: start, layerEnd: start + size });
      start += size;
    }
    return ranges;
  };
  const scoreOrder = (order: number[]): number => {
    const ranges = boundsFor(order);
    let total = 0;
    for (let i = 0; i < order.length; i++) {
      total += cacheHitFraction(hosts[order[i]!]!, ranges[i]!);
    }
    return total;
  };

  if (k <= maxPermutationSearch) {
    let bestOrder = hosts.map((_, i) => i);
    let bestScore = scoreOrder(bestOrder);
    const permute = (arr: number[], from: number): void => {
      if (from === arr.length - 1) {
        const s = scoreOrder(arr);
        if (s > bestScore) {
          bestScore = s;
          bestOrder = [...arr];
        }
        return;
      }
      for (let i = from; i < arr.length; i++) {
        [arr[from], arr[i]] = [arr[i]!, arr[from]!];
        permute(arr, from + 1);
        [arr[from], arr[i]] = [arr[i]!, arr[from]!];
      }
    };
    permute(hosts.map((_, i) => i), 0);
    return bestOrder.map((i) => hosts[i]!);
  }

  // Heuristic fallback for large k: sort by the lowest cached-fragment
  // layer index (peers holding early layers go early), unmatched peers last.
  const withHint = hosts.map((h, i) => {
    const cached = h.stageHost.cachedFragments ?? [];
    let minIdx = Number.POSITIVE_INFINITY;
    for (const frag of cached) {
      const m = /^layer-(\d+)$/.exec(frag);
      if (m) minIdx = Math.min(minIdx, Number.parseInt(m[1]!, 10));
    }
    return { i, minIdx };
  });
  withHint.sort((a, b) => a.minIdx - b.minIdx);
  return withHint.map(({ i }) => hosts[i]!);
}

// ── Planner ────────────────────────────────────────────────────────────────

/**
 * Plan a pipeline split across `hosts` for `req`. Returns `null` when no
 * feasible plan exists (not enough combined capacity even using every
 * eligible host, or zero eligible hosts).
 */
export function planPipeline(
  req: StagePipelineRequest,
  hosts: readonly RosterEntryWithStageHost[],
  opts: PlanPipelineOptions = {},
): StagePlan | null {
  if (!Number.isInteger(req.totalLayers) || req.totalLayers <= 0) {
    throw new RangeError(`planPipeline: totalLayers must be a positive integer, got ${req.totalLayers}`);
  }
  const wireDtype = opts.wireDtype ?? 'f16';
  const wantHotSpare = opts.wantHotSpare ?? true;
  const maxPermutationSearch = opts.maxPermutationSearch ?? 6;
  const excluded = new Set(opts.excludePeerIds ?? []);

  const eligible = hosts.filter((h) => {
    if (excluded.has(h.peerId)) return false;
    if (!opts.includeUnavailable && h.available === false) return false;
    return true;
  });
  if (eligible.length === 0) return null;

  const needed = totalRequestBytes(req);

  // Sort candidates by capacity desc, then stability desc — the base
  // ordering used to pick WHICH hosts join the plan (host count k grows
  // by picking the next-best candidate off this list).
  const ranked = [...eligible].sort((a, b) => {
    const capDiff = hostCapacityBytes(b.stageHost) - hostCapacityBytes(a.stageHost);
    if (capDiff !== 0) return capDiff;
    return hostStabilityScore(b.stageHost) - hostStabilityScore(a.stageHost);
  });

  const maxK = Math.min(opts.maxStages ?? ranked.length, ranked.length, req.totalLayers);

  for (let k = 1; k <= maxK; k++) {
    const candidateSet = ranked.slice(0, k);
    const weights = candidateSet.map((h) => hostCapacityBytes(h.stageHost));
    if (weights.some((w) => w <= 0)) continue; // a zero/negative-capacity host can't host anything

    let ranges: LayerRange[];
    try {
      ranges = splitLayerRangesWeighted(req.totalLayers, weights);
    } catch {
      continue; // e.g. more stages than layers at this k — try smaller/larger k elsewhere
    }
    const sizes = ranges.map((r) => r.layerEnd - r.layerStart);

    // Feasibility: every host's assigned byte-range must fit under ITS
    // OWN capacity (weighted split apportions layer COUNTS, which can
    // still overflow a host's byte budget when layer sizes are uneven).
    let fits = true;
    for (let i = 0; i < candidateSet.length; i++) {
      const assigned = rangeBytes(req, ranges[i]!);
      if (assigned > hostCapacityBytes(candidateSet[i]!.stageHost)) {
        fits = false;
        break;
      }
    }
    if (!fits) continue;
    if (weights.reduce((a, b) => a + b, 0) < needed) continue; // combined capacity insufficient

    // Order the k winning hosts to maximize cache-hit overlap with the
    // (order-independent) size list, then lay out contiguous ranges.
    const ordered = orderForCacheLocality(candidateSet, sizes, maxPermutationSearch);
    // sizes[] was computed against candidateSet's original order; re-map
    // each ordered host back to ITS OWN size (order-independent per the
    // module note — a host's size is a function of its own weight value,
    // not its array position, so this lookup by weight is safe as long
    // as capacities are treated as matched-by-identity, not by value —
    // we look up by candidateSet index, not weight value, to avoid
    // collisions between equal-capacity hosts).
    const sizeByPeerId = new Map(candidateSet.map((h, i) => [h.peerId, sizes[i]!]));

    const stages: PlannedStage[] = [];
    let cursor = 0;
    for (let i = 0; i < ordered.length; i++) {
      const host = ordered[i]!;
      const size = sizeByPeerId.get(host.peerId)!;
      const layerStart = cursor;
      const layerEnd = cursor + size;
      cursor = layerEnd;
      const range = { layerStart, layerEnd };
      stages.push({
        stageIndex: i,
        peerId: host.peerId,
        layerStart,
        layerEnd,
        isFirst: i === 0,
        isFinal: i === ordered.length - 1,
        capacityBytes: hostCapacityBytes(host.stageHost),
        assignedBytes: rangeBytes(req, range),
        cacheHitFraction: cacheHitFraction(host, range),
      });
    }

    let hotSparePeerId: string | undefined;
    if (wantHotSpare) {
      const usedIds = new Set(stages.map((s) => s.peerId));
      const spareCandidate = ranked.find((h) => !usedIds.has(h.peerId));
      if (spareCandidate) hotSparePeerId = spareCandidate.peerId;
    }

    const perTokenHopBytes =
      stages.length > 1 ? activationBytes(1, req.nEmbd, wireDtype) * (stages.length - 1) : 0;

    const selectedIds = new Set(stages.map((s) => s.peerId));
    const unselectedPeerIds = eligible.filter((h) => !selectedIds.has(h.peerId)).map((h) => h.peerId);

    return {
      modelId: req.modelId,
      totalLayers: req.totalLayers,
      stages,
      hotSparePeerId,
      perTokenHopBytes,
      unselectedPeerIds,
    };
  }

  return null; // no k in [1, maxK] produced a feasible plan
}
