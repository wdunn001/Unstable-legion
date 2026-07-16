/**
 * M3 — coordination-free host-side claim logic ("what should THIS peer be
 * hosting right now"). Pure + unit-tested, same discipline as
 * `communalTopology.ts` (which this module builds on): no I/O, no
 * `Date.now()`, no mesh access — `useCommunalHost.ts` wires the result to
 * an actual `StageWorkerClient` load/unload and a `setInterval`-driven
 * reassembly loop.
 *
 * ── The algorithm (plan doc §"Communal pipeline coordination") ──────────
 *
 * No coordinator, no election. Every host independently:
 *
 *   1. Looks at the roster's CURRENT coverage (everyone else's ads, via
 *      `buildCommunalTopology`).
 *   2. If a gap exists, claims the LOWEST uncovered gap, anchored at the
 *      gap's own start (so ranges pack from `driverLayers` upward) and
 *      capped by its own capacity (`selfCapacityLayers`) — never more
 *      than it can actually hold, never less than the gap needs if it
 *      fits. Reaching `totalLayers` sets `includeOutput`.
 *   3. If NO gap exists but a covered segment is under-replicated (fewer
 *      than `maxSparesPerSegment + 1` candidates — primary + spares), it
 *      claims a warm-spare DUPLICATE of that segment's exact range
 *      (CHAOS.md Layer 3: "designate standby peers that opportunistically
 *      pre-cache the ranges most at risk"). This is what makes churn
 *      recovery possible: without it, a converged single-segment mesh
 *      would have zero redundancy and a host death would leave a hole
 *      with nothing to replan onto.
 *   4. If already hosting something and neither of the above changes it,
 *      the existing claim is kept as-is (no thrash for its own sake).
 *
 * ── Wasteful-overlap yield (the anti-thrash safety valve) ────────────────
 *
 * Overlap is only a PROBLEM when it coexists with a gap — capacity is
 * being spent duplicating a segment while something elsewhere goes
 * unserved. `communalHostClaim` checks whether ITS OWN current claim sits
 * in an over-replicated segment (`>1` candidate at the exact same range)
 * while the REST of the mesh (excluding self) still has a gap; if so, and
 * a deterministic tie-break says THIS peer is the loser among that
 * segment's candidates, it reports `yield: true` — the caller
 * (`useCommunalHost.ts`) should unload and re-claim (which will then
 * naturally target the gap on its next tick). Overlap alongside FULL
 * coverage is never flagged — that's the intended warm-spare state.
 *
 * The tie-break (lower priorityScore, then lower stability, then GREATER
 * peerId loses) is deliberately asymmetric-but-total: every candidate in
 * a segment computes the exact same ordering from the exact same inputs,
 * so exactly one loser is ever identified mesh-wide per tick — no two
 * peers can both decide "the other one should yield" and neither moves,
 * and no two peers can both decide "I'm the loser" and both yield at
 * once leaving the segment briefly uncovered (the WINNER never yields,
 * so the segment stays covered by at least one host throughout).
 *
 * ── Jitter (stable claims first, no thundering herd) ─────────────────────
 *
 * `jitterMs` is a SUGGESTION, not enforced here — `useCommunalHost.ts`
 * delays acting on a claim by this much. Stability shrinks it
 * (`hostStabilityScore`-ranked stable desktops claim almost immediately);
 * a `deterministicHash(selfPeerId)`-derived spread term keeps
 * equally-stable peers from claiming in perfect lockstep.
 */
import { deterministicHash, buildCommunalTopology, distinctFailureDomainCount, adFailureDomainId, type CommunalSegment } from './communalTopology.js';
import type { MeshRosterEntry } from './types.js';

export const DEFAULT_MAX_SPARES_PER_SEGMENT = 2;
export const DEFAULT_JITTER_BASE_MS = 4000;

export type CommunalPriorityScoreFn = (peerId: string) => number;

export interface CommunalClaimRange {
  layerStart: number;
  layerEnd: number;
  includeOutput: boolean;
}

export interface CommunalHostClaimInput {
  /** Roster snapshot EXCLUDING self (or including it — self's own entry,
   * if present, is ignored; `selfCurrentClaim` is the source of truth for
   * what self currently holds). */
  roster: readonly MeshRosterEntry[];
  selfPeerId: string;
  modelId: string;
  totalLayers: number;
  driverLayers: number;
  /** How many communal layers self's capacity budget can hold — the
   * caller derives this from its own wasmHeapBudget/avgLayerBytes (or an
   * OPFS-quota-aware figure — `useCommunalHost.ts`'s concern, not this
   * pure module's). */
  selfCapacityLayers: number;
  /** What self is CURRENTLY hosting for this model, or `null`/absent if
   * nothing. */
  selfCurrentClaim?: CommunalClaimRange | null;
  /** Self's own `hostStabilityScore(cap.stageHost)` — used for the yield
   * tie-break and the jitter formula. Default 0 (least preferred/fastest
   * jitter-independent stability contribution). */
  selfStabilityScore?: number;
  /**
   * Self's own `cap.stageHost.failureDomainId` (see `types.ts`'s doc
   * comment) — "this peer, on this browser profile, on this machine".
   * Every replication/redundancy count in this module (sole-coverer
   * check, spare-cap check, becoming-a-spare check) counts DISTINCT
   * failure domains among a segment's candidates, NOT distinct peerIds —
   * two co-located tabs covering the identical segment are ONE real
   * failure domain, not two, and must never be treated as making that
   * segment "replicated". Defaults to `selfPeerId` (back-compat: a peer
   * that never opted into colocation coordination is its own domain).
   */
  selfFailureDomainId?: string;
  /** Same injected-hook idiom as `stageSessionAdmission.ts`. Default pure
   * FIFO / no preference (`() => 0`) until M4. */
  priorityScore?: CommunalPriorityScoreFn;
  /** See `DEFAULT_MAX_SPARES_PER_SEGMENT`. */
  maxSparesPerSegment?: number;
  /** See `DEFAULT_JITTER_BASE_MS`. */
  jitterBaseMs?: number;
}

export interface CommunalHostClaimResult {
  /** The range self should be hosting after this tick, or `null` meaning
   * "host nothing" (fully covered + already spare-saturated everywhere
   * self can reach, or self has zero capacity). */
  claim: CommunalClaimRange | null;
  /** Suggested delay (ms) before the CALLER acts on `claim` — smaller for
   * more stable hosts. Not enforced by this pure function. */
  jitterMs: number;
  /** True iff self's CURRENT claim (not the new `claim` above) is a
   * wasteful duplicate that should be torn down — the caller should
   * unload/stop-advertising the CURRENT range regardless of what `claim`
   * says (on the very next tick, after unloading, `claim` will point
   * at the gap this freed capacity should fill). */
  yieldCurrent: boolean;
  /** Diagnostic string — why this decision was made (test/log aid, not a
   * stable contract). */
  reason: string;
}

function sameRange(a: CommunalClaimRange | null | undefined, b: { layerStart: number; layerEnd: number }): boolean {
  return !!a && a.layerStart === b.layerStart && a.layerEnd === b.layerEnd;
}

/** Minimal `MeshRosterEntry` wrapping self's own current claim, so
 * `buildCommunalTopology` can be asked "does self's own ad win a
 * frontier-walk segment" via the SAME pure function everything else
 * uses, rather than duplicating that walk's logic here. The synthetic
 * entry's `stability` block is a placeholder — callers that need self's
 * real stability score for RANKING (not just topology membership) pass
 * it separately and splice it in (see the yield check above), so this
 * placeholder never leaks into a scoring decision. */
function syntheticRosterEntry(
  peerId: string,
  modelId: string,
  claim: CommunalClaimRange,
  maxSessions = 1,
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
      maxStorageBufferBytes: 1,
      wasmHeapBudget: 1,
      ...(failureDomainId !== undefined ? { failureDomainId } : {}),
      loadedStages: [
        {
          modelId,
          layerStart: claim.layerStart,
          layerEnd: claim.layerEnd,
          includeEmbeddings: false,
          includeOutput: claim.includeOutput,
          ctxSize: 1,
          wireDtype: 'f32',
          maxSessions,
          activeSessions: 0,
          epoch: 0,
        },
      ],
    },
  };
}

/** Deterministic total order over a segment's candidates for the yield
 * tie-break: priorityScore desc, stabilityScore desc, peerId asc (i.e.
 * the LEXICALLY GREATER peerId loses on a full tie). Index 0 = winner
 * (never yields). */
function rankForYield<T extends { peerId: string; stabilityScore: number }>(
  candidates: readonly T[],
  priorityScore: CommunalPriorityScoreFn,
): T[] {
  return [...candidates].sort((a, b) => {
    const pa = priorityScore(a.peerId);
    const pb = priorityScore(b.peerId);
    if (pa !== pb) return pb - pa;
    if (a.stabilityScore !== b.stabilityScore) return b.stabilityScore - a.stabilityScore;
    return a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0;
  });
}

/** The single decision function: what should `input.selfPeerId` be
 * hosting right now, and should it tear down what it currently hosts. */
export function communalHostClaim(input: CommunalHostClaimInput): CommunalHostClaimResult {
  const {
    roster,
    selfPeerId,
    modelId,
    totalLayers,
    driverLayers,
    selfCapacityLayers,
    selfCurrentClaim = null,
    selfStabilityScore = 0,
    selfFailureDomainId = selfPeerId,
    priorityScore = () => 0,
    maxSparesPerSegment = DEFAULT_MAX_SPARES_PER_SEGMENT,
    jitterBaseMs = DEFAULT_JITTER_BASE_MS,
  } = input;

  const othersRoster = roster.filter((r) => r.peerId !== selfPeerId);
  const jitterMs = Math.round(jitterBaseMs / (1 + Math.max(0, selfStabilityScore) / 1000)) + (deterministicHash(selfPeerId) % 500);

  if (selfCapacityLayers <= 0) {
    return {
      claim: null,
      jitterMs,
      yieldCurrent: selfCurrentClaim !== null, // holding anything with zero capacity is nonsensical — shed it
      reason: 'selfCapacityLayers <= 0',
    };
  }

  const othersTopology = buildCommunalTopology(othersRoster, { modelId, totalLayers, driverLayers });

  // ── "Am I essential where I already am?" — the anti-thundering-herd
  // check. Computed against the FULL topology (self's own ad included via
  // a synthetic roster entry): if self is the SOLE candidate winning the
  // frontier-walk segment at its own exact range, abandoning it would
  // immediately reopen a gap — self must stay, full stop, regardless of
  // what `othersTopology` alone might make look more urgent. Without
  // this, N hosts claiming simultaneously (before any jitter stagger has
  // had a chance to space them out) each see an EMPTY "others" roster and
  // independently compute the SAME "lowest gap", producing several
  // different-length claims sharing one start point; the frontier walk
  // then only ever credits the SINGLE furthest-reaching one as "the"
  // segment, making every shorter (but individually honest, individually
  // load-bearing) claim look redundant to its own owner and triggering a
  // synchronized stampede toward whatever residual gap is left — the
  // opposite of convergence. Checking essentiality first breaks that: a
  // host that ALREADY represents real, uniquely-necessary coverage never
  // reconsiders just because someone else's claim looks more impressive.
  if (selfCurrentClaim) {
    const selfAd = {
      peerId: selfPeerId,
      layerStart: selfCurrentClaim.layerStart,
      layerEnd: selfCurrentClaim.layerEnd,
      stabilityScore: selfStabilityScore,
    };
    const fullRoster = [...othersRoster, syntheticRosterEntry(selfPeerId, modelId, selfCurrentClaim, 1, selfFailureDomainId)];
    const fullTopology = buildCommunalTopology(fullRoster, { modelId, totalLayers, driverLayers });
    const wonSegment: CommunalSegment | undefined = fullTopology.segments.find(
      (s) => sameRange(selfCurrentClaim, s) && s.candidates.some((c) => c.peerId === selfPeerId),
    );
    if (wonSegment) {
      // NOTE: this dispatch (sole coverer vs genuine duplicate) is
      // deliberately PEER-count based, not domain-count based — it
      // answers "would removing me reopen a gap RIGHT NOW", which is a
      // peer-existence fact independent of failure-domain identity: if
      // ANOTHER peer (same domain or not) already covers this exact
      // range, self isn't structurally essential, and — critically — the
      // "genuine duplicate" branch below is what lets a WASTEFUL overlap
      // (including a same-domain colocated duplicate) yield to go refill
      // a real gap elsewhere, which is valuable regardless of domain.
      // Domain-counting is applied instead where it belongs: the
      // "already-legitimate spare" and "become a fresh spare" checks
      // further below, which decide whether a segment counts as
      // adequately REPLICATED for maxSparesPerSegment purposes (see this
      // module's/types.ts's doc comments — that's the actual fix for the
      // catastrophic colocated-tab redundancy-accounting gap).
      if (wonSegment.candidates.length === 1) {
        // Sole coverer of a real, frontier-walk-winning segment —
        // essential, stays put. BUT: if self has unused capacity
        // headroom (its claim is smaller than what it could hold — e.g.
        // it originally claimed a small leftover gap) AND a gap sits
        // immediately adjacent on either side (most commonly: a
        // neighboring host just died), grow into it. Without this, a
        // "tight" tiling where every host's claim happens to use less
        // than its full capacity has no self-heal path for a dead
        // neighbor UNLESS a dedicated redundant spare happens to exist —
        // CHAOS.md's hot-spare model is the PRIMARY recovery mechanism,
        // but real capacity is often lumpy (a host that joined late only
        // got a small leftover slice, not its full budget), so this
        // lightweight secondary path — "absorb your dead neighbor's
        // range if you have room" — meaningfully improves recovery odds
        // without requiring an idle spare to have been pre-positioned.
        const spareCapacity = selfCapacityLayers - (selfCurrentClaim.layerEnd - selfCurrentClaim.layerStart);
        if (spareCapacity > 0) {
          // NOT an exact-boundary match: `othersTopology` excludes self
          // entirely, so a gap "next to" self can either touch self's
          // edge exactly OR fully engulf self's own position (e.g. self
          // is the only host left after its spare-siblings all yielded
          // in this same round — `othersTopology` then shows ONE big gap
          // spanning past BOTH of self's edges, not a neat adjacent
          // sliver). Either shape is "room to grow into."
          const rightGap = othersTopology.gaps.find(
            (g) => g.layerStart <= selfCurrentClaim!.layerEnd && g.layerEnd > selfCurrentClaim!.layerEnd,
          );
          const leftGap = othersTopology.gaps.find(
            (g) => g.layerEnd >= selfCurrentClaim!.layerStart && g.layerStart < selfCurrentClaim!.layerStart,
          );
          if (rightGap) {
            const newEnd = Math.min(selfCurrentClaim.layerEnd + spareCapacity, rightGap.layerEnd);
            const claim: CommunalClaimRange = { layerStart: selfCurrentClaim.layerStart, layerEnd: newEnd, includeOutput: newEnd === totalLayers };
            return { claim, jitterMs, yieldCurrent: false, reason: `sole coverer with spare capacity — extending right into the adjacent gap up to ${newEnd}` };
          }
          if (leftGap) {
            const newStart = Math.max(selfCurrentClaim.layerStart - spareCapacity, leftGap.layerStart);
            const claim: CommunalClaimRange = { layerStart: newStart, layerEnd: selfCurrentClaim.layerEnd, includeOutput: selfCurrentClaim.includeOutput };
            return { claim, jitterMs, yieldCurrent: false, reason: `sole coverer with spare capacity — extending left into the adjacent gap down to ${newStart}` };
          }
        }
        return { claim: selfCurrentClaim, jitterMs, yieldCurrent: false, reason: 'sole coverer of this segment — essential, keeping as-is' };
      }
      // A genuine duplicate (>1 DISTINCT FAILURE DOMAIN at the SAME exact
      // range) — only a problem when a gap exists elsewhere in the mesh
      // (wasted capacity while something else goes unserved); otherwise
      // it's a legitimate warm spare and self should keep it regardless
      // of the tie-break (moving would just relocate the SAME redundancy,
      // not reduce it). The yield tie-break itself stays PEER-level (it
      // decides which specific tab backs off, not which domain) —
      // domain-counting only governs whether this is "genuinely
      // redundant" in the first place.
      if (othersTopology.gaps.length > 0) {
        const ranked = rankForYield([...wonSegment.candidates.filter((c) => c.peerId !== selfPeerId), selfAd], priorityScore);
        if (ranked[0]!.peerId !== selfPeerId) {
          return { claim: null, jitterMs, yieldCurrent: true, reason: 'current claim is a wasteful duplicate while a gap exists elsewhere; deterministic loser yields' };
        }
      }
      return { claim: selfCurrentClaim, jitterMs, yieldCurrent: false, reason: 'legitimate duplicate/spare (winner of the tie-break, or no gap elsewhere) — keeping' };
    }
    // selfCurrentClaim doesn't win any frontier-walk segment even WITH
    // self included — it's fully shadowed by a longer overlapping ad (or
    // stale/orphaned). Self isn't contributing anything unique here; fall
    // through to gap-seeking below exactly as if it had no claim at all.
  }

  // ── Claim logic ──────────────────────────────────────────────────────
  const gap = othersTopology.gaps[0];
  if (gap) {
    const layerStart = gap.layerStart;
    const layerEnd = Math.min(gap.layerStart + selfCapacityLayers, gap.layerEnd);
    if (layerEnd <= layerStart) {
      return { claim: null, jitterMs, yieldCurrent: false, reason: 'capacity too small to make progress on the lowest gap' };
    }
    const claim: CommunalClaimRange = { layerStart, layerEnd, includeOutput: layerEnd === totalLayers };
    if (sameRange(selfCurrentClaim, claim) && selfCurrentClaim!.includeOutput === claim.includeOutput) {
      return { claim: selfCurrentClaim, jitterMs, yieldCurrent: false, reason: 'already claiming this exact gap-filling range' };
    }
    return { claim, jitterMs, yieldCurrent: false, reason: `claiming lowest gap [${layerStart},${layerEnd})` };
  }

  // `othersTopology` (built from `othersRoster`, self excluded) never
  // contains self's own ad — a segment's candidate list there can only
  // gain SELF's domain by self joining it. `domainCountIncludingSelf`
  // computes "how many distinct failure domains would this segment have
  // if self joined/stayed", crediting self's domain only once even if a
  // co-located sibling already covers the exact same range (that's the
  // whole point: self joining a segment its OWN domain already covers
  // adds ZERO real redundancy, so it must not read as "made progress
  // toward maxSparesPerSegment").
  const domainCountIncludingSelf = (candidates: CommunalSegment['candidates']): number =>
    candidates.some((c) => adFailureDomainId(c) === selfFailureDomainId)
      ? distinctFailureDomainCount(candidates)
      : distinctFailureDomainCount(candidates) + 1;

  // No gap. Already an exact-range holder of a covered segment that isn't
  // over-replicated (by DISTINCT DOMAIN count)? Keep as-is (no thrash).
  if (selfCurrentClaim) {
    const matchingSegment = othersTopology.segments.find((s) => sameRange(selfCurrentClaim, s));
    if (matchingSegment && domainCountIncludingSelf(matchingSegment.candidates) <= maxSparesPerSegment + 1) {
      return { claim: selfCurrentClaim, jitterMs, yieldCurrent: false, reason: 'no gap; keeping current claim as an already-legitimate primary/spare' };
    }
  }

  // Consider becoming a fresh spare of the neediest under-replicated
  // segment self can actually fit — "under-replicated" and "neediest"
  // both measured by DISTINCT FAILURE DOMAIN count, not candidate count,
  // so a segment already covered by two co-located (same-domain) tabs
  // still reads as needing a real second domain, not skipped as
  // "already has 2 candidates".
  const spareCandidates = othersTopology.segments
    .filter((s) => domainCountIncludingSelf(s.candidates) <= maxSparesPerSegment + 1)
    .filter((s) => s.layerEnd - s.layerStart <= selfCapacityLayers)
    .filter((s) => !sameRange(selfCurrentClaim, s)); // already handled above, but stay defensive
  if (spareCandidates.length > 0) {
    spareCandidates.sort((a, b) => {
      const da = distinctFailureDomainCount(a.candidates);
      const db = distinctFailureDomainCount(b.candidates);
      if (da !== db) return da - db;
      return a.layerStart - b.layerStart;
    });
    const target = spareCandidates[0]!;
    const claim: CommunalClaimRange = { layerStart: target.layerStart, layerEnd: target.layerEnd, includeOutput: target.layerEnd === totalLayers };
    return { claim, jitterMs, yieldCurrent: false, reason: `becoming a warm spare for [${target.layerStart},${target.layerEnd})` };
  }

  return {
    claim: null,
    jitterMs,
    yieldCurrent: false,
    reason: othersTopology.segments.length === 0 ? 'no coverage anywhere yet and self has no gap to claim (should not happen unless capacity is 0)' : 'fully covered and every segment already at spare capacity — nothing useful to host',
  };
}
