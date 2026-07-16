/**
 * meshViewModels — pure derivations from `CommunalTopology` +
 * `StandingLedger` into the shapes the mesh sidebar renders. Kept
 * separate from the components on purpose (per the M5 brief: "keep the
 * view-models pure and testable") — every function here takes plain data
 * in, returns plain data out, no React/DOM/mesh access, so
 * test/meshViewModels.test.ts can assert the degrade-not-deny framing
 * and the coverage-gap CTA copy without spinning up a mesh at all.
 */
import type { CommunalGap, CommunalTopology, MeshRosterEntry, StandingLedger, StandingSnapshot } from '@unstable-legion/core';

// ── Capacity meter ──────────────────────────────────────────────────────

export interface CapacityView {
  /** 0-100, rounded — `topology.coverageFraction * 100`. */
  coveragePercent: number;
  /** True iff the mesh can currently route an end-to-end chat (no gaps). */
  ready: boolean;
  /** Concurrent chat slots free across the whole assembled pipeline.
   * `undefined` when `ready` is false (nothing is routable, "seats" is
   * meaningless) or when capacity is effectively unbounded (no communal
   * layers needed at all). */
  seatsFree?: number;
  gaps: readonly CommunalGap[];
  /** "Qwen3-8B · Q4_K_M" — passed straight through from
   * `chatModelSource.ts`'s `ChatModelConfig.modelLabel`, so every string
   * this view-model produces below names the model, not a bare number. */
  modelLabel: string;
  /** Prominent, model-named one-liner for the mesh sidebar's header —
   * "Assembling Qwen3-8B · Q4_K_M — 60% ready" while incomplete,
   * "Qwen3-8B · Q4_K_M ready — N seats free" once assembled. Product
   * requirement: the mesh's model identity is never buried behind a bare
   * percentage. */
  statusLine: string;
  /** Plain-language CTA for the not-ready case — the brief's exact
   * framing, model-named ("Qwen3-8B · Q4_K_M 60% assembled — layers
   * 14–27 need a host."). Empty when `ready` is true. */
  gapMessage: string;
}

export function deriveCapacityView(topology: CommunalTopology, modelLabel: string): CapacityView {
  const coveragePercent = Math.round(topology.coverageFraction * 100);
  const ready = topology.gaps.length === 0;
  const seatsFree = ready
    ? Number.isFinite(topology.seats)
      ? topology.seats
      : undefined
    : undefined;

  const statusLine = ready
    ? `${modelLabel} ready${seatsFree === undefined ? '' : ` — ${seatsFree} seat${seatsFree === 1 ? '' : 's'} free`}`
    : `Assembling ${modelLabel} — ${coveragePercent}% ready`;

  const gapMessage = ready
    ? ''
    : `${modelLabel} ${coveragePercent}% assembled — layers ${topology.gaps
        .map((g) => `${g.layerStart}–${g.layerEnd}`)
        .join(', ')} need a host. Contribute your GPU to unlock chat.`;

  return { coveragePercent, ready, seatsFree, gaps: topology.gaps, modelLabel, statusLine, gapMessage };
}

// ── Topology map ─────────────────────────────────────────────────────────

export interface TopologySegmentView {
  layerStart: number;
  layerEnd: number;
  kind: 'local' | 'covered' | 'gap';
  /** Display label for a covered/local segment — nick if known, else a
   * shortened peerId. Undefined for gaps. */
  label?: string;
  peerId?: string;
  isSelf: boolean;
}

/** Full [0, totalLayers) picture for the layer-bar visual: the driver's
 * own local range, every covered communal segment (winning candidate),
 * and every gap — in layer order. */
export function deriveTopologySegments(
  topology: CommunalTopology,
  opts: { selfId: string; nickOf: (peerId: string) => string | undefined },
): TopologySegmentView[] {
  const segments: TopologySegmentView[] = [];
  if (topology.driverLayers > 0) {
    segments.push({
      layerStart: 0,
      layerEnd: topology.driverLayers,
      kind: 'local',
      label: 'you',
      peerId: opts.selfId,
      isSelf: true,
    });
  }

  type Ordered = { layerStart: number; layerEnd: number; kind: 'covered' | 'gap'; peerId?: string };
  const ordered: Ordered[] = [
    ...topology.segments.map((s) => ({
      layerStart: s.layerStart,
      layerEnd: s.layerEnd,
      kind: 'covered' as const,
      peerId: s.candidates[0]?.peerId,
    })),
    ...topology.gaps.map((g) => ({ layerStart: g.layerStart, layerEnd: g.layerEnd, kind: 'gap' as const })),
  ].sort((a, b) => a.layerStart - b.layerStart);

  for (const seg of ordered) {
    const isSelf = seg.peerId === opts.selfId;
    segments.push({
      layerStart: seg.layerStart,
      layerEnd: seg.layerEnd,
      kind: seg.kind,
      peerId: seg.peerId,
      isSelf,
      label:
        seg.kind === 'gap'
          ? undefined
          : isSelf
            ? 'you'
            : (seg.peerId && opts.nickOf(seg.peerId)) || (seg.peerId ? shortPeerId(seg.peerId) : undefined),
    });
  }

  return segments;
}

export function shortPeerId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

export function nickLookup(roster: readonly MeshRosterEntry[]): (peerId: string) => string | undefined {
  const byId = new Map(roster.map((r) => [r.peerId, r.nick] as const));
  return (peerId) => byId.get(peerId);
}

// ── Standing / "your contribution" panel ─────────────────────────────────

export type StandingTier = 'top' | 'contributing' | 'newcomer' | 'debt';

export interface StandingView {
  standing: number;
  priorityScore: number;
  tier: StandingTier;
  /** Plain-language, degrade-not-deny framing — NEVER "blocked"/"denied". */
  message: string;
  /** This peer's own hosted layer range, when it's contributing compute
   * right now (from `useCommunalHost`'s `claim`). Undefined = not hosting. */
  hostedRange?: { layerStart: number; layerEnd: number };
}

/** `topStandings` should be `ledger.topContributors(n, now)` for a
 * reasonably large `n` (large enough to cover the whole visible mesh) —
 * passed in rather than recomputed here so the leaderboard and the
 * standing panel always agree on the same ranking snapshot. */
export function deriveStandingView(
  ledger: StandingLedger,
  selfId: string,
  now: number,
  topStandings: readonly StandingSnapshot[],
  hostedRange?: { layerStart: number; layerEnd: number },
): StandingView {
  const mine = ledger.myStanding(selfId, now);
  const hasHistory = ledger.hasHistory(selfId);

  let tier: StandingTier;
  let message: string;
  if (!hasHistory) {
    tier = 'newcomer';
    message = "You're new here — everyone gets fair access from the start. Contribute your GPU to build priority.";
  } else if (mine.standing <= 0) {
    tier = 'debt';
    message = 'Contribute your GPU to move up the queue.';
  } else {
    const rank = topStandings.findIndex((s) => s.peerId === selfId);
    const topBand = Math.max(1, Math.ceil(topStandings.length * 0.2));
    if (rank !== -1 && rank < topBand) {
      tier = 'top';
      message = "You're a top contributor — priority access.";
    } else {
      tier = 'contributing';
      message = "You're contributing — priority access is building.";
    }
  }

  return { standing: mine.standing, priorityScore: mine.priorityScore, tier, message, hostedRange };
}

// ── Leaderboard ────────────────────────────────────────────────────────

export interface LeaderboardEntry {
  rank: number;
  peerId: string;
  label: string;
  standing: number;
  isSelf: boolean;
}

export function deriveLeaderboard(
  topStandings: readonly StandingSnapshot[],
  opts: { selfId: string; nickOf: (peerId: string) => string | undefined },
): LeaderboardEntry[] {
  return topStandings.map((s, i) => ({
    rank: i + 1,
    peerId: s.peerId,
    label: opts.nickOf(s.peerId) ?? shortPeerId(s.peerId),
    standing: s.standing,
    isSelf: s.peerId === opts.selfId,
  }));
}
