/**
 * M4 — contribution economy ("standing"). Pure, deterministic, unit-tested
 * hard — this is the trust/fairness core the admission queue (M2
 * `stageSessionAdmission.popNextByPriority`) and the communal route/replan
 * spread (M3) both sort by.
 *
 * Lineage (see the design brief, "Contribution economy" section, for the
 * full argument): AI Horde kudos (non-monetary points earned per completed
 * job, spent as queue priority, newcomer floor, never a denial) + IPFS
 * Bitswap's probabilistic-degradation strategy (service quality falls with
 * standing, asymptotically, never zero) + BitTorrent's direct pairwise
 * measurement (score what a driver OBSERVED a host do, never what the host
 * CLAIMED it could do).
 *
 * Structural grounding: a driver sits on the hot path of every forward pass
 * through a host, so it directly witnesses layersServed/framesServed/
 * wallClockServing for that host — this module assumes that witnessing
 * already happened and a caller is reporting it; it does not itself touch
 * the network, a clock, or `Math.random`.
 *
 * Non-negotiable properties (each has a unit test in `test/standing.test.ts`):
 *   1. Score = observed service, never claims. `cap.stageHost` adverts are
 *      NEVER an input to this module — routing hint only, wired elsewhere.
 *   2. A session that aborts mid-stream credits its host NOTHING (kills
 *      tiny-range frame-farming + partial-work gaming).
 *   3. Standing decays on a rolling half-life — recent utility outranks
 *      historical, and live consumption debits current standing.
 *   4. priorityScore is monotonic in standing and NEVER returns a
 *      refusal/-Infinity — zero/negative standing maps to a finite
 *      "lowest lane", served FCFS behind everyone else, never denied.
 *   5. An unseen peer (and a peer who cycled its identity to shed debt)
 *      gets a small flat newcomer floor — sized so Sybil-reset nets you
 *      back to "newcomer", never to "ahead of an honest newcomer".
 *   6. Near-threshold tie-breaking carries small bounded noise so a peer
 *      can't compute an exact minimum-to-stay-above-a-lane (BitTyrant
 *      lesson) — the noise source is injectable for deterministic tests,
 *      never `Math.random()`.
 *
 * LOCAL-ONLY: this ledger is one driver's private observation log. It is
 * never gossiped (no anti-Sybil story exists for reputation shared among
 * ephemeral keys) — a peer must re-earn standing with every driver that
 * has ever hosted or served it. `now` is always injected (never
 * `Date.now()` internally) so every function here is a pure function of
 * its inputs and the ledger's own prior writes.
 */

// ── Config ───────────────────────────────────────────────────────────────

/** Rolling half-life for both credit and debit decay. Hours-scale by
 * design — recent utility should outrank a big contribution from days
 * ago, but not evaporate between two messages in the same chat. */
export const DEFAULT_HALF_LIFE_MS = 6 * 60 * 60_000; // 6 hours

/** Flat priority floor for a peer this ledger has literally never
 * recorded an event for (host or consumer) — the newcomer grace. Also
 * what a cycled ("Sybil-reset") identity lands on, since a fresh peerId
 * has no history either — sized small on purpose (see module doc §5). */
export const DEFAULT_NEWCOMER_FLOOR = 1;

/** Priority floor for a peer this ledger HAS seen but whose current
 * decayed standing is <= 0 (a heavy consumer running a standing debt, or
 * a past contributor whose credit fully decayed away). Strictly below
 * `DEFAULT_NEWCOMER_FLOOR` — the "lowest lane", not the newcomer lane —
 * so an unseen peer always outranks a peer carrying debt, but is NEVER
 * a refusal (still a finite, servable score: AI Horde's anonymous lane). */
export const DEFAULT_LOWEST_LANE = 0;

/** Max magnitude of the anti-gaming noise added to `priorityScore`
 * (uniform in `[-noiseAmplitude, +noiseAmplitude]`). Deliberately much
 * smaller than the gap between `DEFAULT_LOWEST_LANE` and
 * `DEFAULT_NEWCOMER_FLOOR` so it can never invert a real lane boundary,
 * let alone a meaningful standing gap between two established peers —
 * it only fuzzes ties among near-identical peers. */
export const DEFAULT_NOISE_AMPLITUDE = 0.25;

/** TOOL-NODES: flat standing credit for one SUCCESSFULLY served tool call
 * (a GPU-less peer's contribution — see `docs/TOOL-NODES.md`). Sized so a
 * handful of served tool calls buys a tool-provider node real priority in
 * the same units layer-serving hosts earn, letting a no-GPU peer that only
 * ever answers tool calls still climb above an unseen/debt-carrying peer.
 * A failed/denied tool call credits nothing (parity with `recordService`'s
 * `sessionCompleted` gate — you're paid for work that actually landed). */
export const DEFAULT_TOOL_SERVICE_CREDIT = 5;

/** TOOL-NODES: flat standing debit for CONSUMING one tool call (the driver
 * that asked). Symmetric with `recordConsumption`'s "more utilization =
 * less" half, and — like it — NOT gated on success: you occupied the
 * provider's turn whether or not the tool ultimately answered. Smaller than
 * the service credit so a peer that both serves and consumes tool calls
 * still nets positive for being a net contributor. */
export const DEFAULT_TOOL_CONSUME_DEBIT = 1;

/** The default noise source re-samples once per this many milliseconds
 * (per peer) rather than every call, so a peer can't average out the
 * noise by hammering `priorityScore` in a tight loop to back out an
 * exact threshold. */
export const DEFAULT_NOISE_BUCKET_MS = 1_000;

/** Deterministic noise source: `(peerId, now) => value in [-1, 1)`. The
 * default implementation (`defaultNoiseSource`) is a pure hash, not
 * `Math.random()` — callers that want real entropy inject their own.
 * Tests inject a fixed/controlled source to assert exact bounds. */
export type NoiseSource = (peerId: string, now: number) => number;

/** FNV-1a-ish string hash -> deterministic pseudo-random unit interval.
 * Not cryptographic; only needs to be cheap, stable, and peer-distinct so
 * one peer can't precompute another's noise. */
function hashUnit(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff; // [0, 1)
}

/** Default `NoiseSource` — buckets `now` to `DEFAULT_NOISE_BUCKET_MS` so
 * the value is stable within one scheduling round, then hashes
 * `peerId:bucket` to a value in `[-1, 1)`. */
export function defaultNoiseSource(peerId: string, now: number, bucketMs: number = DEFAULT_NOISE_BUCKET_MS): number {
  const bucket = Math.floor(now / bucketMs);
  return hashUnit(`${peerId}:${bucket}`) * 2 - 1;
}

export interface StandingConfig {
  /** @default DEFAULT_HALF_LIFE_MS */
  halfLifeMs: number;
  /** @default DEFAULT_NEWCOMER_FLOOR */
  newcomerFloor: number;
  /** @default DEFAULT_LOWEST_LANE */
  lowestLane: number;
  /** @default DEFAULT_NOISE_AMPLITUDE */
  noiseAmplitude: number;
  /** @default defaultNoiseSource */
  noiseSource: NoiseSource;
}

export const DEFAULT_STANDING_CONFIG: StandingConfig = {
  halfLifeMs: DEFAULT_HALF_LIFE_MS,
  newcomerFloor: DEFAULT_NEWCOMER_FLOOR,
  lowestLane: DEFAULT_LOWEST_LANE,
  noiseAmplitude: DEFAULT_NOISE_AMPLITUDE,
  noiseSource: defaultNoiseSource,
};

// ── Inputs ───────────────────────────────────────────────────────────────

export interface RecordServiceInput {
  hostPeerId: string;
  /** Number of layers this host served for the session. */
  layersServed: number;
  /** Frames the driver itself verified as correctly served — never a
   * count the host claimed; the caller (the driver) is the witness. */
  framesServed: number;
  /** Wall-clock milliseconds the host spent actively serving. */
  servingMs: number;
  /** Credit is applied ONLY when `true`. A session that aborted
   * mid-stream still calls `recordService` (so the host is no longer
   * "unseen" — see the newcomer-floor design note) but contributes zero
   * credit, closing the tiny-range frame-farming / partial-work gap. */
  sessionCompleted: boolean;
}

export interface RecordConsumptionInput {
  consumerPeerId: string;
  /** Layers of pipeline this peer occupied as a consumer. */
  layersConsumed: number;
  /** Frames pulled through those layers. */
  framesConsumed: number;
  /** Wall-clock milliseconds those pipeline slots were held. */
  consumingMs: number;
}

export interface RecordToolServiceInput {
  /** The GPU-less (or any) peer that EXECUTED the tool call. */
  providerPeerId: string;
  /** Tool name — diagnostic only; not part of the credit math (all tools
   * credit the same flat unit today — see `docs/TOOL-NODES.md` follow-ups
   * for per-tool weighting). */
  toolName?: string;
  /** Credit is applied ONLY when `true` (an `ok` MeshToolResult). A
   * failed/denied/timed-out call marks the provider "seen" (no longer a
   * newcomer) but credits nothing, exactly like `recordService`'s
   * `sessionCompleted` gate. */
  succeeded: boolean;
  /** Optional override for the flat credit unit (default
   * `DEFAULT_TOOL_SERVICE_CREDIT`). */
  credit?: number;
}

export interface RecordToolConsumptionInput {
  /** The peer that ASKED for (consumed) the tool call. */
  consumerPeerId: string;
  toolName?: string;
  /** Optional override for the flat debit unit (default
   * `DEFAULT_TOOL_CONSUME_DEBIT`). */
  debit?: number;
}

export interface StandingSnapshot {
  peerId: string;
  /** Decayed credit minus decayed debit at the queried `now`. Can be
   * negative (a peer running a standing debt). */
  standing: number;
  /** `priorityScore(peerId, now)` at the same `now` — included so a UI
   * can show both the "honest" number and the lane it actually buys. */
  priorityScore: number;
}

// ── Decay primitives ─────────────────────────────────────────────────────

/** Exponential half-life decay. `elapsed` is clamped to >= 0 so a `now`
 * that's (erroneously, or from clock skew) earlier than `at` never
 * *amplifies* the stored value — it's treated as zero elapsed time. */
function decay(value: number, at: number, now: number, halfLifeMs: number): number {
  if (value === 0) return 0;
  const elapsed = Math.max(0, now - at);
  if (elapsed === 0) return value;
  return value * 2 ** (-elapsed / halfLifeMs);
}

interface Accumulator {
  value: number;
  at: number;
}

/** Decay `acc` up to `now`, then add `delta`. Never moves the anchor
 * (`at`) backwards, even if `now` is out of order relative to the last
 * write — that would make a future decay computation think less time
 * had passed than actually did. */
function applyDelta(acc: Accumulator, delta: number, now: number, halfLifeMs: number): Accumulator {
  const decayed = decay(acc.value, acc.at, now, halfLifeMs);
  return { value: decayed + delta, at: Math.max(acc.at, now) };
}

interface PeerRecord {
  credit: Accumulator;
  debit: Accumulator;
  /** Earliest `now` this peer was ever recorded at (seen as a host OR a
   * consumer) — an aborted session still sets this (see
   * `RecordServiceInput.sessionCompleted` doc), only the credit is
   * withheld. Used for the newcomer/least-history distinction. */
  firstSeenAt: number;
  /** Count of `recordService`/`recordConsumption` calls ever received
   * for this peer, credited or not — the "least-history" signal for the
   * optimistic-slot pick, deliberately independent of standing. */
  eventCount: number;
}

function zeroAcc(now: number): Accumulator {
  return { value: 0, at: now };
}

// ── Ledger ───────────────────────────────────────────────────────────────

/**
 * One driver's private, local observation ledger. Every method that needs
 * "now" takes it explicitly — nothing in this class calls `Date.now()` or
 * sets a timer, so it is exactly as testable as a free function despite
 * being a stateful class (mutable internal `Map`, same "small ergonomic
 * class wrapping pure math" shape as `Roster`, minus the real-clock/IO
 * bits `Roster` needs and this module deliberately avoids).
 */
export class StandingLedger {
  private readonly peers = new Map<string, PeerRecord>();
  private readonly config: StandingConfig;

  constructor(config: Partial<StandingConfig> = {}) {
    this.config = { ...DEFAULT_STANDING_CONFIG, ...config };
  }

  private getOrInit(peerId: string, now: number): PeerRecord {
    let rec = this.peers.get(peerId);
    if (!rec) {
      rec = { credit: zeroAcc(now), debit: zeroAcc(now), firstSeenAt: now, eventCount: 0 };
      this.peers.set(peerId, rec);
    }
    return rec;
  }

  /**
   * Record observed host service. Credit = `layersServed * framesServed *
   * (servingMs / 1000)` ("layer-frame-seconds") applied ONLY when
   * `sessionCompleted` — an aborted session still marks the host as seen
   * (so it's no longer a "newcomer" for lane purposes) but contributes
   * zero credit toward standing.
   */
  recordService(input: RecordServiceInput, now: number): void {
    const rec = this.getOrInit(input.hostPeerId, now);
    rec.eventCount += 1;
    if (!input.sessionCompleted) return; // aborted mid-stream: seen, credits nothing
    const delta = input.layersServed * input.framesServed * (input.servingMs / 1000);
    rec.credit = applyDelta(rec.credit, Math.max(0, delta), now, this.config.halfLifeMs);
  }

  /**
   * Record observed consumption — the "more utilization = less access"
   * debit half. Unlike `recordService`, this is NOT gated on session
   * completion: a peer that aborted mid-stream still occupied pipeline
   * slots while it lasted, and that resource use is what's being debited,
   * not rewarded.
   */
  recordConsumption(input: RecordConsumptionInput, now: number): void {
    const rec = this.getOrInit(input.consumerPeerId, now);
    rec.eventCount += 1;
    const delta = input.layersConsumed * input.framesConsumed * (input.consumingMs / 1000);
    rec.debit = applyDelta(rec.debit, Math.max(0, delta), now, this.config.halfLifeMs);
  }

  /**
   * TOOL-NODES: record a tool call this driver observed a provider SERVE.
   * Credits the provider a flat `DEFAULT_TOOL_SERVICE_CREDIT` (overridable)
   * on success — the GPU-less contribution path — into the SAME decayed
   * credit accumulator as `recordService`, so a tool-provider node's
   * standing and a layer-serving host's standing are directly comparable and
   * feed one `priorityScore`. A failed call still marks the provider seen
   * (no newcomer re-farming) but credits nothing.
   */
  recordToolService(input: RecordToolServiceInput, now: number): void {
    const rec = this.getOrInit(input.providerPeerId, now);
    rec.eventCount += 1;
    if (!input.succeeded) return;
    const credit = input.credit ?? DEFAULT_TOOL_SERVICE_CREDIT;
    rec.credit = applyDelta(rec.credit, Math.max(0, credit), now, this.config.halfLifeMs);
  }

  /**
   * TOOL-NODES: record that this peer CONSUMED a tool call (debit half).
   * Not gated on success — asking for a tool occupied the provider's turn
   * regardless of outcome, mirroring `recordConsumption`.
   */
  recordToolConsumption(input: RecordToolConsumptionInput, now: number): void {
    const rec = this.getOrInit(input.consumerPeerId, now);
    rec.eventCount += 1;
    const debit = input.debit ?? DEFAULT_TOOL_CONSUME_DEBIT;
    rec.debit = applyDelta(rec.debit, Math.max(0, debit), now, this.config.halfLifeMs);
  }

  /** Current decayed standing: decayed credit minus decayed debit. `0`
   * for a peer this ledger has never recorded (the "unseen" case —
   * distinct from a seen peer who happens to currently net `0`; use
   * `hasHistory` to tell them apart). Can be negative. */
  standingOf(peerId: string, now: number): number {
    const rec = this.peers.get(peerId);
    if (!rec) return 0;
    const credit = decay(rec.credit.value, rec.credit.at, now, this.config.halfLifeMs);
    const debit = decay(rec.debit.value, rec.debit.at, now, this.config.halfLifeMs);
    return credit - debit;
  }

  /** `true` once `recordService` or `recordConsumption` has ever been
   * called for `peerId` (credited or not) — an unseen peerId (including a
   * freshly cycled Sybil identity) returns `false`. */
  hasHistory(peerId: string): boolean {
    return this.peers.has(peerId);
  }

  /**
   * Priority conversion consumed by the admission queue
   * (`stageSessionAdmission.popNextByPriority`'s injected
   * `priorityScore(peerId)`) and M3's route/replan spread. Monotonic in
   * standing, always finite, never a refusal:
   *
   *   - never seen (incl. a cycled/Sybil-reset identity): `newcomerFloor`.
   *   - seen, standing <= 0 (debt, or fully decayed history): `lowestLane`
   *     — strictly below `newcomerFloor`, so an honest newcomer always
   *     outranks a peer running a standing debt, but this is still a
   *     finite, servable lane (AI Horde's anonymous/FCFS lane), never a
   *     denial.
   *   - seen, standing > 0: `newcomerFloor + standing` — grows unbounded
   *     with earned standing, continuous with the newcomer floor at
   *     standing -> 0+.
   *
   * A small bounded `[-noiseAmplitude, +noiseAmplitude]` noise term rides
   * on top (see `NoiseSource` doc) so a peer can't compute an exact
   * minimum contribution needed to stay in a better lane.
   */
  priorityScore(peerId: string, now: number): number {
    const rec = this.peers.get(peerId);
    const { newcomerFloor, lowestLane, noiseAmplitude, noiseSource } = this.config;
    const noise = noiseAmplitude * noiseSource(peerId, now);

    if (!rec) return newcomerFloor + noise;
    const standing = this.standingOf(peerId, now);
    const base = standing > 0 ? newcomerFloor + standing : lowestLane;
    return base + noise;
  }

  /**
   * Pick the least-history candidate from `candidatePeerIds` — the
   * optimistic-unchoke analog: a scheduler reserves one slot per round for
   * whichever candidate this ledger knows the least about, regardless of
   * its (possibly negative) standing. Ties broken by earliest
   * `firstSeenAt`, then by `peerId` for full determinism. An unseen
   * candidate (`eventCount` 0, effectively "infinitely new") always wins
   * over any seen candidate. Returns `undefined` for an empty list.
   */
  pickOptimisticSlot(candidatePeerIds: readonly string[]): string | undefined {
    if (candidatePeerIds.length === 0) return undefined;
    let best: string | undefined;
    let bestEventCount = Number.POSITIVE_INFINITY;
    let bestFirstSeenAt = Number.POSITIVE_INFINITY;
    for (const peerId of candidatePeerIds) {
      const rec = this.peers.get(peerId);
      const eventCount = rec?.eventCount ?? 0;
      const firstSeenAt = rec?.firstSeenAt ?? Number.NEGATIVE_INFINITY; // unseen: always "earliest"/newest-grace
      const better =
        best === undefined ||
        eventCount < bestEventCount ||
        (eventCount === bestEventCount &&
          (firstSeenAt < bestFirstSeenAt || (firstSeenAt === bestFirstSeenAt && peerId < best)));
      if (better) {
        best = peerId;
        bestEventCount = eventCount;
        bestFirstSeenAt = firstSeenAt;
      }
    }
    return best;
  }

  /** Top `n` peers by raw `standing` (descending; ties broken by peerId
   * ascending for determinism) — the leaderboard read API. Ranked by
   * `standing`, not `priorityScore`, so the noise term never jitters a
   * status display. `priorityScore` is still included per-entry for UIs
   * that want to show both. */
  topContributors(n: number, now: number): StandingSnapshot[] {
    const snapshots: StandingSnapshot[] = [...this.peers.keys()].map((peerId) => ({
      peerId,
      standing: this.standingOf(peerId, now),
      priorityScore: this.priorityScore(peerId, now),
    }));
    snapshots.sort((a, b) => b.standing - a.standing || (a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0));
    return snapshots.slice(0, Math.max(0, n));
  }

  /** Convenience single-peer read for a "your standing" UI panel — same
   * shape as a `topContributors` entry, works for an unseen peer too
   * (`standing: 0`, `priorityScore: newcomerFloor`). */
  myStanding(selfId: string, now: number): StandingSnapshot {
    return {
      peerId: selfId,
      standing: this.standingOf(selfId, now),
      priorityScore: this.priorityScore(selfId, now),
    };
  }
}

/** Factory form, matching the module's own naming convention elsewhere
 * (`joinMesh`, `planPipeline`) for call sites that prefer a function to a
 * `new`. Equivalent to `new StandingLedger(config)`. */
export function createStandingLedger(config: Partial<StandingConfig> = {}): StandingLedger {
  return new StandingLedger(config);
}

/**
 * Bind a live ledger + clock into the exact `(peerId: string) => number`
 * shape `stageSessionAdmission.popNextByPriority`'s `PriorityScoreFn` (and
 * M3's route/replan spread) expect. This is the injection point: a
 * consumer wires `popNextByPriority(queue, bindPriorityScore(ledger, () =>
 * Date.now()))` — `standing.ts` itself never touches a real clock.
 */
export function bindPriorityScore(ledger: StandingLedger, clock: () => number): (peerId: string) => number {
  return (peerId: string) => ledger.priorityScore(peerId, clock());
}
