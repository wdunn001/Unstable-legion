/**
 * M3 — communal pipeline coverage map.
 *
 * Pure function over a roster snapshot's union of `cap.stageHost.loadedStages`
 * (see `types.ts`'s M3 doc comment) — no I/O, no mesh access, same "pure
 * function over a roster snapshot" discipline as `stagePlanner.ts` and
 * `routing.ts`, so this is cheap to call on every roster change.
 *
 * ── Why this ISN'T `stagePlanner.ts` ─────────────────────────────────────
 *
 * `stagePlanner.ts`'s `planPipeline` is a CENTRAL planner: it decides who
 * SHOULD host what, from scratch, every time. The communal pipeline has no
 * coordinator — hosts decide what to claim themselves
 * (`communalAssembly.ts`'s `communalHostClaim`), advertise it, and a driver
 * merely reads the resulting roster state to see what coverage already
 * EXISTS. `buildCommunalTopology` is that read: it turns "what everyone
 * says they've loaded" into "what layer ranges are covered, what's
 * missing, and how much spare capacity exists" — a fact-finding pass, not
 * a decision. `planCommunalRoute` (below) is the only piece that makes a
 * choice, and even then only "which already-loaded host do I attach to
 * for each already-covered segment" — never "who should load what."
 *
 * ── The frontier-walk algorithm (why segments use EXACT ad ranges) ──────
 *
 * A naive interval-union would produce "coverage exists from X to Y", but
 * a driver can't ask a host to serve an ARBITRARY sub-range of what it
 * loaded — `useStageHost.ts`'s `ensureWorkerLoaded` compares the incoming
 * `stage.session.open`'s layer range against what's ALREADY loaded
 * (`sameConfig`), and reloads (or conflicts) on a mismatch. Asking a host
 * for anything other than the EXACT range it advertised would either
 * silently swap the host's loaded stage out from under its own assembly
 * loop (`useCommunalHost.ts`'s "never unload while advertised" invariant)
 * or outright fail if the host is mid-session. So every `CommunalSegment`
 * this module produces carries the WINNING candidate's own exact
 * `(layerStart, layerEnd)` — never a clipped/trimmed range.
 *
 * The walk: starting at `driverLayers`, repeatedly find every ad whose
 * range covers the current cursor position, pick the one reaching
 * FURTHEST (`layerEnd` desc), record ITS full range as a segment, advance
 * the cursor to that `layerEnd`, and repeat. Where no ad covers the
 * cursor, record a gap up to the next ad's `layerStart` (or `totalLayers`
 * if none). This is the classic greedy "minimum interval cover" walk; it
 * degrades gracefully under staggered/partial overlap (a churn transient
 * — steady-state `communalAssembly.ts` claims never overlap partially,
 * only duplicate exactly, see that module's doc comment) by simply using
 * whichever ad reaches furthest, accepting harmless double-compute over
 * the overlapped stretch rather than gapping.
 */
import { hostStabilityScore, type StageHostCap } from './stagePlanner.js';
import type { MeshLoadedStage, MeshRosterEntry } from './types.js';

// ── Deterministic hash (shared with communalAssembly.ts / stageOrchestrator.ts) ──

/**
 * Small deterministic 32-bit string hash (FNV-1a) — used everywhere this
 * milestone needs "spread N things deterministically across peers without
 * a coordinator": anti-stampede route selection (`planCommunalRoute`),
 * spare-claim jitter spread (`communalAssembly.ts`), and replan jitter
 * spread (`stageOrchestrator.ts`'s `runCommunalDriverSession`). Same input
 * always produces the same output on every peer — that determinism (not
 * cryptographic strength) is the entire point: it lets independent peers
 * agree on "who goes first" without exchanging any messages.
 */
export function deterministicHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ── Ad shape (a loadedStages entry + its owning peerId + derived rank inputs) ──

export interface CommunalHostStageAd {
  peerId: string;
  modelId: string;
  layerStart: number;
  layerEnd: number;
  includeEmbeddings: boolean;
  includeOutput: boolean;
  ctxSize: number;
  wireDtype: 'f32' | 'f16';
  maxSessions: number;
  activeSessions: number;
  epoch: number;
  /** Headroom = maxSessions - activeSessions, floored at 0. Denormalized
   * here so ranking never has to recompute it. */
  headroom: number;
  /** `hostStabilityScore` of the peer's FULL `stageHost` cap (not just
   * this ad) — denormalized at build time so `planCommunalRoute` stays a
   * pure function of the topology alone, no second roster pass needed. */
  stabilityScore: number;
  /** Optional round-trip estimate (ms), when the caller supplies one via
   * `BuildCommunalTopologyOptions.rttByPeerId` — e.g. from a ping cache.
   * Undefined = unknown, ranked as if worst (Infinity). */
  rttMs?: number;
  /** Denormalized from the advertising peer's `cap.stageHost.
   * failureDomainId` (see `types.ts`'s doc comment) — undefined for a
   * peer that predates the field or didn't set one. Use `adFailureDomainId`
   * rather than this field directly: it applies the "absent -> own peerId"
   * fallback every caller needs. */
  failureDomainId?: string;
}

/** "This ad's failure domain" — its explicit `failureDomainId` when
 * present, else its own `peerId` (back-compat: a peer that never opted
 * into colocation coordination is, by definition, its own independent
 * failure domain — see `types.ts`'s doc comment on the field). ALWAYS use
 * this instead of reading `.failureDomainId` directly so every caller
 * applies the same fallback. */
export function adFailureDomainId(ad: Pick<CommunalHostStageAd, 'peerId' | 'failureDomainId'>): string {
  return ad.failureDomainId ?? ad.peerId;
}

/** Distinct failure-domain ids represented among `candidates` — the
 * REPLICATION-correct count for "how many independent copies of this
 * segment exist" (see `communalAssembly.ts`'s doc comment: two co-located
 * tabs covering the same segment must count as ONE, not two). */
export function distinctFailureDomainIds(candidates: readonly Pick<CommunalHostStageAd, 'peerId' | 'failureDomainId'>[]): Set<string> {
  return new Set(candidates.map(adFailureDomainId));
}

/** `distinctFailureDomainIds(candidates).size` — the common case callers
 * actually want (they only need the count, not the set itself). */
export function distinctFailureDomainCount(candidates: readonly Pick<CommunalHostStageAd, 'peerId' | 'failureDomainId'>[]): number {
  return distinctFailureDomainIds(candidates).size;
}

export interface CommunalSegment {
  /** Exact range of the WINNING (furthest-reaching) ad at this frontier
   * step — see the module doc comment for why this is never trimmed. */
  layerStart: number;
  layerEnd: number;
  /** Every ad whose range is EXACTLY [layerStart, layerEnd) — the
   * candidate pool `planCommunalRoute` picks from for this segment
   * (includes warm spares: ads that duplicate the winning range). */
  candidates: readonly CommunalHostStageAd[];
}

export interface CommunalGap {
  layerStart: number;
  layerEnd: number;
}

export interface CommunalTopology {
  modelId: string;
  totalLayers: number;
  driverLayers: number;
  /** Covered stretches, frontier order, `layerStart` ascending. */
  segments: readonly CommunalSegment[];
  /** Same ranges as `segments`, exposed under the name the workstream
   * brief asked for — diagnostics/UI convenience. */
  coveredLayers: readonly { layerStart: number; layerEnd: number }[];
  gaps: readonly CommunalGap[];
  /** True iff the mesh's coverage reaches `totalLayers` via a candidate
   * that set `includeOutput`. */
  outputCovered: boolean;
  /** min-over-segments of Σ(candidate.headroom) — the bottleneck
   * concurrent-session capacity across the WHOLE assembled pipeline.
   * 0 whenever any gap exists (nothing can be routed end-to-end). */
  seats: number;
  /** [0,1] fraction of communal layers (`totalLayers - driverLayers`)
   * currently covered. 1 when `driverLayers >= totalLayers` (nothing
   * communal needed) or when `gaps` is empty. */
  coverageFraction: number;
}

export interface BuildCommunalTopologyOptions {
  /** Optional RTT estimates (ms) keyed by peerId, for `planCommunalRoute`'s
   * ranking. Absent entries rank as worst (Infinity), never excluded. */
  rttByPeerId?: Readonly<Record<string, number>>;
  /** Exclude these peerIds from candidacy entirely (e.g. a peer that just
   * died, for a churn replan). */
  excludePeerIds?: readonly string[];
}

function toAd(
  entry: MeshRosterEntry,
  stage: MeshLoadedStage,
  rttByPeerId: Readonly<Record<string, number>> | undefined,
): CommunalHostStageAd {
  return {
    peerId: entry.peerId,
    modelId: stage.modelId,
    layerStart: stage.layerStart,
    layerEnd: stage.layerEnd,
    includeEmbeddings: stage.includeEmbeddings,
    includeOutput: stage.includeOutput,
    ctxSize: stage.ctxSize,
    // Default a dtype-less peer (older bundle) to f16 so the ad — and every
    // downstream consumer (e.g. the activation-wire encoder) — never sees
    // undefined. Both driver and host use whatever this resolves to.
    wireDtype: stage.wireDtype ?? 'f16',
    maxSessions: stage.maxSessions,
    activeSessions: stage.activeSessions,
    epoch: stage.epoch,
    headroom: Math.max(0, stage.maxSessions - stage.activeSessions),
    stabilityScore: entry.stageHost ? hostStabilityScore(entry.stageHost as StageHostCap) : 0,
    rttMs: rttByPeerId?.[entry.peerId],
    failureDomainId: entry.stageHost?.failureDomainId,
  };
}

/** Flatten a roster snapshot's `loadedStages` for `modelId`, clipped to the
 * communal layer space `[communalStart, totalLayers)` — an ad that starts
 * before `communalStart` or extends past `totalLayers` is malformed for
 * this model/split and dropped rather than trusted partially (a peer
 * advertising garbage shouldn't corrupt the topology; it should just not
 * count).
 *
 * `communalStart` defaults to `driverLayers` (the capable-driver regime: a
 * driver hosts `[0, driverLayers)` locally, the mesh covers the rest). The
 * OPTIONAL-STAGE0 thin-driver regime passes `communalStart: 0` instead, so
 * an isFirst host advertising `[0, X)` (embeddings included) is KEPT rather
 * than dropped — see `docs/OPTIONAL-STAGE0.md`. */
export function collectCommunalAds(
  roster: readonly MeshRosterEntry[],
  modelId: string,
  totalLayers: number,
  communalStart: number,
  opts: BuildCommunalTopologyOptions = {},
): CommunalHostStageAd[] {
  const excluded = new Set(opts.excludePeerIds ?? []);
  const ads: CommunalHostStageAd[] = [];
  for (const entry of roster) {
    if (excluded.has(entry.peerId)) continue;
    const stages = entry.stageHost?.loadedStages;
    if (!stages) continue;
    for (const stage of stages) {
      if (stage.modelId !== modelId) continue;
      if (stage.layerStart < communalStart) continue;
      if (stage.layerEnd > totalLayers) continue;
      if (stage.layerEnd <= stage.layerStart) continue;
      ads.push(toAd(entry, stage, opts.rttByPeerId));
    }
  }
  return ads;
}

export interface BuildCommunalTopologyRequest {
  modelId: string;
  totalLayers: number;
  /** Layers the DRIVER always hosts locally — the communal space this
   * topology covers is `[driverLayers, totalLayers)`. See the plan doc's
   * "Stage 0 = every consumer hosts it locally" decision. */
  driverLayers: number;
  /** OPTIONAL-STAGE0 (thin drivers): the layer the coverage walk STARTS at.
   * Defaults to `driverLayers` — the capable-driver regime, unchanged. Pass
   * `0` to build the thin-driver view: coverage of `[0, totalLayers)`, where
   * a weak/no-GPU device hosts NO stage locally and instead relies on a
   * remote isFirst host covering the `[0, X)` prefix (embeddings included).
   * See `docs/OPTIONAL-STAGE0.md`. */
  communalStart?: number;
}

/** Build a `CommunalTopology` from a roster snapshot's ad union. See the
 * module doc comment for the frontier-walk algorithm. */
export function buildCommunalTopology(
  roster: readonly MeshRosterEntry[],
  req: BuildCommunalTopologyRequest,
  opts: BuildCommunalTopologyOptions = {},
): CommunalTopology {
  const { modelId, totalLayers, driverLayers } = req;
  const communalStart = req.communalStart ?? driverLayers;
  if (!Number.isInteger(totalLayers) || totalLayers <= 0) {
    throw new RangeError(`buildCommunalTopology: totalLayers must be a positive integer, got ${totalLayers}`);
  }
  if (!Number.isInteger(driverLayers) || driverLayers < 0) {
    throw new RangeError(`buildCommunalTopology: driverLayers must be a non-negative integer, got ${driverLayers}`);
  }
  if (!Number.isInteger(communalStart) || communalStart < 0 || communalStart > totalLayers) {
    throw new RangeError(`buildCommunalTopology: communalStart must be an integer in [0, totalLayers], got ${communalStart}`);
  }

  const communalLayerCount = Math.max(0, totalLayers - communalStart);
  if (communalLayerCount === 0) {
    // The driver alone covers the whole model — nothing communal needed.
    return {
      modelId,
      totalLayers,
      driverLayers,
      segments: [],
      coveredLayers: [],
      gaps: [],
      outputCovered: true,
      seats: Number.POSITIVE_INFINITY,
      coverageFraction: 1,
    };
  }

  const ads = collectCommunalAds(roster, modelId, totalLayers, communalStart, opts);

  const segments: CommunalSegment[] = [];
  const gaps: CommunalGap[] = [];
  let cursor = communalStart;

  while (cursor < totalLayers) {
    const reaching = ads.filter((a) => a.layerStart <= cursor && a.layerEnd > cursor);
    if (reaching.length === 0) {
      const nextStart = ads
        .filter((a) => a.layerStart > cursor)
        .reduce((min, a) => Math.min(min, a.layerStart), totalLayers);
      gaps.push({ layerStart: cursor, layerEnd: nextStart });
      cursor = nextStart;
      continue;
    }
    let winner = reaching[0]!;
    for (const a of reaching) {
      if (a.layerEnd > winner.layerEnd) winner = a;
    }
    const candidates = ads.filter((a) => a.layerStart === winner.layerStart && a.layerEnd === winner.layerEnd);
    segments.push({ layerStart: winner.layerStart, layerEnd: winner.layerEnd, candidates });
    cursor = winner.layerEnd;
  }

  const coveredLayerCount = segments.reduce((sum, s) => sum + (s.layerEnd - s.layerStart), 0);
  // Segments can overlap during churn transients (see module doc comment) —
  // clamp the fraction so a transient double-count never reports >100%.
  const coverageFraction = gaps.length === 0 ? 1 : Math.min(1, coveredLayerCount / communalLayerCount);

  const lastSegment = segments[segments.length - 1];
  const outputCovered =
    gaps.length === 0 &&
    !!lastSegment &&
    lastSegment.layerEnd === totalLayers &&
    lastSegment.candidates.some((c) => c.includeOutput);

  const seats =
    gaps.length === 0 && segments.length > 0
      ? segments.reduce((min, s) => Math.min(min, s.candidates.reduce((sum, c) => sum + c.headroom, 0)), Number.POSITIVE_INFINITY)
      : 0;

  return {
    modelId,
    totalLayers,
    driverLayers,
    segments,
    coveredLayers: segments.map((s) => ({ layerStart: s.layerStart, layerEnd: s.layerEnd })),
    gaps,
    outputCovered,
    seats,
    coverageFraction,
  };
}

// ── Route planning: pick one host per covered segment ───────────────────

export interface PlanCommunalRouteOptions {
  /** The requesting driver's own peerId — feeds the anti-stampede spread
   * hash so different drivers deterministically fan out across the top
   * candidates instead of piling onto a single "best" host. */
  driverPeerId: string;
  /** Scores a candidate peer for queue/route priority (highest first).
   * Defaults to `() => 0` (no preference) until M4 wires the real
   * standing-based implementation — same injected-hook idiom as
   * `stageSessionAdmission.ts`'s `PriorityScoreFn`. */
  priorityScore?: (peerId: string) => number;
  /** Consider at most this many top-ranked candidates per segment for the
   * anti-stampede spread. Default 3 (per the plan doc's
   * `spreadWidth=3`). */
  spreadWidth?: number;
  /** Model hidden size — needed for the per-token hop-cost estimate.
   * Required whenever `topology.segments` is non-empty. */
  nEmbd?: number;
  /** Wire dtype for the hop-cost estimate. Default 'f16'. */
  wireDtype?: 'f32' | 'f16';
}

/** Rank candidates for a segment: headroom desc, priorityScore desc,
 * stability desc, RTT asc (undefined = worst), peerId asc (determinism). */
function rankCandidates(
  candidates: readonly CommunalHostStageAd[],
  priorityScore: (peerId: string) => number,
): CommunalHostStageAd[] {
  return [...candidates].sort((a, b) => {
    if (a.headroom !== b.headroom) return b.headroom - a.headroom;
    const pa = priorityScore(a.peerId);
    const pb = priorityScore(b.peerId);
    if (pa !== pb) return pb - pa;
    if (a.stabilityScore !== b.stabilityScore) return b.stabilityScore - a.stabilityScore;
    const rttA = a.rttMs ?? Number.POSITIVE_INFINITY;
    const rttB = b.rttMs ?? Number.POSITIVE_INFINITY;
    if (rttA !== rttB) return rttA - rttB;
    return a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0;
  });
}

/** Anti-stampede pick: among the top `spreadWidth` ranked candidates,
 * deterministically choose one keyed by `hash(driverPeerId)` — different
 * drivers spread across the top few hosts instead of every driver piling
 * onto the single globally-best one. */
function spreadPick<T>(ranked: readonly T[], driverPeerId: string, spreadWidth: number): T {
  const width = Math.max(1, Math.min(spreadWidth, ranked.length));
  const idx = deterministicHash(driverPeerId) % width;
  return ranked[idx]!;
}

/**
 * Turn a fully-covered `CommunalTopology` into a `StagePlan` (the SAME
 * shape `stagePlanner.ts#planPipeline` produces, so every plan-driven
 * consumer — `StagePipelinePanel`, `stageOrchestrator.ts`'s decode loop —
 * works unmodified). Returns `null` when `topology.gaps` is non-empty
 * (can't route end-to-end — a gap computes nothing) or when the topology
 * has segments but `nEmbd` wasn't supplied.
 *
 * Prepends a synthetic local stage 0 for `opts.driverPeerId` covering
 * `[0, driverLayers)` — matching `stagePipelinePlanning.ts#planPipelineForDriver`'s
 * existing convention (`stageOrchestrator.ts` never sends anything to
 * stage 0's peerId; it's bookkeeping for UI/topology display only, the
 * orchestrator calls `localHooks` directly for it).
 *
 * SCOPE NOTE (matches `stageOrchestrator.ts`'s existing one): this
 * function can express an N-remote-segment plan, but
 * `runCommunalDriverSession` (the only current consumer) only wires the
 * 2-total-stage shape (local stage 0 + ONE remote final stage) end to
 * end — multi-hop relay across >1 remote communal stage is not
 * implemented anywhere in this repo yet (same follow-up noted in
 * `runDriverStageSession`'s SCOPE NOTE). In practice this rarely bites:
 * `communalAssembly.ts`'s capacity-capped claim lets one sufficiently
 * spacious host claim an entire gap in one range, and CHAOS.md's
 * "minimize stage count" bias means additional hosts become warm SPARES
 * (duplicate candidates on the SAME segment) rather than partial-range
 * co-owners — the common case is exactly one covered segment.
 */
export function planCommunalRoute(
  topology: CommunalTopology,
  opts: PlanCommunalRouteOptions,
): {
  modelId: string;
  totalLayers: number;
  stages: {
    stageIndex: number;
    peerId: string;
    layerStart: number;
    layerEnd: number;
    isFirst: boolean;
    isFinal: boolean;
    capacityBytes: number;
    assignedBytes: number;
    cacheHitFraction: number;
  }[];
  hotSparePeerId?: string;
  perTokenHopBytes: number;
  unselectedPeerIds: readonly string[];
} | null {
  if (topology.gaps.length > 0) return null;
  if (topology.segments.length === 0) {
    // driverLayers >= totalLayers — the whole model is local; a trivial
    // single-stage plan with no remote hops.
    return {
      modelId: topology.modelId,
      totalLayers: topology.totalLayers,
      stages: [
        {
          stageIndex: 0,
          peerId: opts.driverPeerId,
          layerStart: 0,
          layerEnd: topology.totalLayers,
          isFirst: true,
          isFinal: true,
          capacityBytes: 0,
          assignedBytes: 0,
          cacheHitFraction: 0,
        },
      ],
      perTokenHopBytes: 0,
      unselectedPeerIds: [],
    };
  }
  if (opts.nEmbd === undefined) return null;

  const priorityScore = opts.priorityScore ?? (() => 0);
  const spreadWidth = opts.spreadWidth ?? 3;
  const wireDtype = opts.wireDtype ?? 'f16';

  const localStage = {
    stageIndex: 0,
    peerId: opts.driverPeerId,
    layerStart: 0,
    layerEnd: topology.driverLayers,
    isFirst: true,
    isFinal: false,
    capacityBytes: 0,
    assignedBytes: 0,
    cacheHitFraction: 0,
  };

  const remoteStages: (typeof localStage)[] = [];
  let hotSparePeerId: string | undefined;
  const selectedPeerIds = new Set<string>();

  topology.segments.forEach((segment, i) => {
    const ranked = rankCandidates(segment.candidates, priorityScore);
    const chosen = spreadPick(ranked, opts.driverPeerId, spreadWidth);
    selectedPeerIds.add(chosen.peerId);
    const runnerUp = ranked.find((c) => c.peerId !== chosen.peerId);
    if (!hotSparePeerId && runnerUp) hotSparePeerId = runnerUp.peerId;
    remoteStages.push({
      stageIndex: i + 1,
      peerId: chosen.peerId,
      layerStart: segment.layerStart,
      layerEnd: segment.layerEnd,
      isFirst: false,
      isFinal: i === topology.segments.length - 1,
      capacityBytes: 0,
      assignedBytes: 0,
      cacheHitFraction: 0,
    });
  });

  const stages = [localStage, ...remoteStages];
  const perTokenHopBytes =
    stages.length > 1
      ? // one hop per stage boundary — activationBytes lives in
        // @unstable-legion/stage-runtime; inlined here (4 bytes/elem f32,
        // 2 bytes/elem f16) to avoid a circular import back into
        // stagePlanner.ts's dependency, matching that module's own
        // constant rather than re-deriving it differently.
        (wireDtype === 'f16' ? 2 : 4) * opts.nEmbd * (stages.length - 1)
      : 0;

  const allAdPeerIds = new Set(topology.segments.flatMap((s) => s.candidates.map((c) => c.peerId)));
  const unselectedPeerIds = [...allAdPeerIds].filter((id) => !selectedPeerIds.has(id));

  return {
    modelId: topology.modelId,
    totalLayers: topology.totalLayers,
    stages,
    ...(hotSparePeerId ? { hotSparePeerId } : {}),
    perTokenHopBytes,
    unselectedPeerIds,
  };
}

/**
 * Companion to `planCommunalRoute`: for each covered segment, the FULL
 * ranked candidate list with the chosen peer (same `spreadPick` result
 * `planCommunalRoute` would pick) moved to the front, followed by the
 * rest as busy-fallback targets. `runCommunalDriverSession`
 * (`stageOrchestrator.ts`) uses this to try the next candidate when
 * `stage.session.open` comes back `stage.session.busy` with a full queue,
 * without re-planning from scratch.
 *
 * Deliberately a SEPARATE pure recomputation rather than a shared mutable
 * pass with `planCommunalRoute` — both are pure functions of the same
 * `(topology, driverPeerId, priorityScore, spreadWidth)` inputs, so
 * calling both is always consistent (same `chosen` head) at the cost of
 * a little redundant ranking work, which is cheap (segment counts are
 * small — single digits in practice, see this module's SCOPE NOTE).
 *
 * Map key = stage index the way `planCommunalRoute` numbers it (1-based,
 * local driver stage is always index 0).
 */
export function communalAttachOrder(
  topology: CommunalTopology,
  opts: Pick<PlanCommunalRouteOptions, 'driverPeerId' | 'priorityScore' | 'spreadWidth'>,
): ReadonlyMap<number, readonly CommunalHostStageAd[]> {
  const priorityScore = opts.priorityScore ?? (() => 0);
  const spreadWidth = opts.spreadWidth ?? 3;
  const out = new Map<number, readonly CommunalHostStageAd[]>();
  topology.segments.forEach((segment, i) => {
    const ranked = rankCandidates(segment.candidates, priorityScore);
    const chosen = spreadPick(ranked, opts.driverPeerId, spreadWidth);
    const rest = ranked.filter((c) => c.peerId !== chosen.peerId);
    out.set(i + 1, [chosen, ...rest]);
  });
  return out;
}

// ── OPTIONAL-STAGE0: thin-driver route planning ─────────────────────────
//
// A thin driver (weak/no WebGPU) hosts NO stage locally. It needs the mesh
// to provide the FIRST stage too — an isFirst host covering `[0, X)` with
// embeddings, which prefills from the token-ids the driver ships in the
// activation-frame `tokens` sideband (see `docs/OPTIONAL-STAGE0.md` and
// `stageFrameEnvelope.ts`). Build the topology with `communalStart: 0`, then
// plan a route whose stages are ALL remote (no synthetic local stage 0) and
// whose first stage is isFirst.

/** True iff `topology` (built with `communalStart: 0`) is routable for a
 * thin driver: fully covered AND its lowest segment starts at layer 0 with
 * at least one candidate that includes embeddings (a real isFirst host). A
 * capable-driver topology that merely happens to be gap-free is NOT thin-
 * routable — the `[0, driverLayers)` prefix + embeddings must exist on the
 * mesh, not be assumed local. */
export function thinDriverFirstStageCovered(topology: CommunalTopology): boolean {
  if (topology.gaps.length > 0) return false;
  const first = topology.segments[0];
  return !!first && first.layerStart === 0 && first.candidates.some((c) => c.includeEmbeddings);
}

/**
 * Thin-driver analog of `planCommunalRoute`: turn a `communalStart: 0`
 * topology into a `StagePlan` with NO local driver stage — stage 1 is the
 * remote isFirst host `[0, X)`, subsequent stages chain downstream, and the
 * last is isFinal. Returns `null` when the topology isn't thin-routable
 * (`thinDriverFirstStageCovered` false) or `nEmbd` wasn't supplied.
 *
 * SCOPE NOTE (shared with `planCommunalRoute`/`runCommunalDriverSession`):
 * this can express a multi-remote-segment thin route, but only the single-
 * remote-stage shape (ONE host covering `[0, totalLayers)`, isFirst+isFinal
 * — the "one spacious host claims the whole gap" common case) is wired end
 * to end for `sf` traffic. Multi-hop relay across >1 remote segment has no
 * host-side forwarding loop anywhere in this repo yet — the identical
 * documented limitation the capable-driver path carries.
 */
export function planThinDriverRoute(
  topology: CommunalTopology,
  opts: PlanCommunalRouteOptions,
): ReturnType<typeof planCommunalRoute> {
  if (!thinDriverFirstStageCovered(topology)) return null;
  if (opts.nEmbd === undefined) return null;

  const priorityScore = opts.priorityScore ?? (() => 0);
  const spreadWidth = opts.spreadWidth ?? 3;
  const wireDtype = opts.wireDtype ?? 'f16';

  const remoteStages: {
    stageIndex: number;
    peerId: string;
    layerStart: number;
    layerEnd: number;
    isFirst: boolean;
    isFinal: boolean;
    capacityBytes: number;
    assignedBytes: number;
    cacheHitFraction: number;
  }[] = [];
  let hotSparePeerId: string | undefined;
  const selectedPeerIds = new Set<string>();

  topology.segments.forEach((segment, i) => {
    const ranked = rankCandidates(segment.candidates, priorityScore);
    const chosen = spreadPick(ranked, opts.driverPeerId, spreadWidth);
    selectedPeerIds.add(chosen.peerId);
    const runnerUp = ranked.find((c) => c.peerId !== chosen.peerId);
    if (!hotSparePeerId && runnerUp) hotSparePeerId = runnerUp.peerId;
    remoteStages.push({
      stageIndex: i + 1,
      peerId: chosen.peerId,
      layerStart: segment.layerStart,
      layerEnd: segment.layerEnd,
      isFirst: i === 0,
      isFinal: i === topology.segments.length - 1,
      capacityBytes: 0,
      assignedBytes: 0,
      cacheHitFraction: 0,
    });
  });

  const perTokenHopBytes = (wireDtype === 'f16' ? 2 : 4) * opts.nEmbd * remoteStages.length;
  const allAdPeerIds = new Set(topology.segments.flatMap((s) => s.candidates.map((c) => c.peerId)));
  const unselectedPeerIds = [...allAdPeerIds].filter((id) => !selectedPeerIds.has(id));

  return {
    modelId: topology.modelId,
    totalLayers: topology.totalLayers,
    stages: remoteStages,
    ...(hotSparePeerId ? { hotSparePeerId } : {}),
    perTokenHopBytes,
    unselectedPeerIds,
  };
}
