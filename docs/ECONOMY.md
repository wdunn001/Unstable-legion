# M4: the contribution economy ("standing")

`packages/mesh-core/src/standing.ts`: pure, unit-tested (35 tests,
`packages/mesh-core/test/standing.test.ts`), zero I/O, zero hidden clock.
This is the mechanism behind the product decision in the design brief:
"Users who contribute compute (host layers) get priority; heavy consumers
get less; nobody is hard cut off."

## The model

Lineage (see the design brief, "Contribution economy" section, for the
full argument):

- **AI Horde kudos**: non-monetary points earned per completed job, spent
  as queue priority, a newcomer floor, never a denial. The closest working
  precedent. (Petals planned to clone this exactly and never shipped it.
  Their incentive-less swarm's decay is the cautionary tale for why this
  milestone exists at all.)
- **IPFS Bitswap's probabilistic-degradation strategy**: service quality
  falls with standing, asymptotically worse, never zero.
- **BitTorrent's direct pairwise measurement**: score what a peer
  *observed*, never what another peer *claimed* it could do.

Tokens/DePIN were explicitly rejected (Helium's contribution/reward
decoupling; regulatory surface; the operator's intent here is non-monetary;
see the design brief's Decided section).

## Observable-contribution rationale

A driver sits on the hot path of every forward pass through a host it's
using. It sends the prefill/decode frames and receives the served
activations back, hop by hop. That means a driver directly *witnesses*
which host served which frames for which layers, for how long, and
whether the session it was part of actually finished. This is why
`standing.ts` never takes a capability advert (`cap.stageHost`) as a
scoring input: `cap.stageHost` is what a host *claims* it can do (a
routing hint, consumed by `stagePlanner`/M3's `communalTopology`), while
`standing.ts` only accepts what a driver *measured* actually happened
(`recordService`/`recordConsumption`). A host that advertises generously
and serves nothing accrues exactly zero standing; a host that under-
advertises but reliably serves accrues real standing. This is asserted
directly in the test suite (`measured-not-claimed`).

## Mechanics

**Score = observed service, credited only on completion.** Each call to
`recordService({hostPeerId, layersServed, framesServed, servingMs,
sessionCompleted}, now)` computes `layersServed * framesServed *
(servingMs / 1000)` ("layer-frame-seconds") and applies it as credit,
but *only* when `sessionCompleted` is `true`. A session that aborts
mid-stream still marks the host as "seen" (so it can't re-farm the
newcomer floor by aborting repeatedly) but contributes zero credit. This
closes both the tiny-range frame-farming gap (serve one frame, disconnect,
repeat) and the partial-work gaming gap (claim credit for layers that
were mid-flight when the session died).

**Consumption debits standing: the "more utilization = less" half.**
`recordConsumption({consumerPeerId, layersConsumed, framesConsumed,
consumingMs}, now)` applies a symmetric debit. Unlike service credit,
consumption is *not* gated on completion. A peer that aborted mid-stream
still occupied pipeline slots for however long it lasted, and that
occupied time is what gets debited.

**Rolling half-life decay (default 6h, `DEFAULT_HALF_LIFE_MS`).** Both
credit and debit are stored as `{value, lastUpdateAt}` accumulators; every
read (`standingOf`) and every write re-derives the current value as
`stored * 2^(-elapsed/halfLife)` before combining it with anything new.
Recent utility outranks historical by construction: a credit earned an
hour ago outweighs an identical credit earned a week ago, and a consumer
that stops being heavy sees its debit fade back out over the same
half-life. `standingOf(peerId, now) = decayedCredit - decayedDebit`, and
can be negative.

**Priority conversion: weighted-fair, degrade-not-deny.**
`priorityScore(peerId, now)` is the number the admission queue
(`stageSessionAdmission.popNextByPriority`) and M3's route/replan spread
are meant to sort by. Three lanes, by construction:

- **never seen** (including a freshly cycled peerId; see Sybil section
  below): `DEFAULT_NEWCOMER_FLOOR` (default `1`).
- **seen, standing <= 0** (a peer running a standing debt, or one whose
  earned credit has fully decayed away): `DEFAULT_LOWEST_LANE` (default
  `0`), strictly below the newcomer floor. This is AI Horde's anonymous
  lane: served FCFS behind everyone with real standing, but always a
  finite, real priority value: **never a refusal, never `-Infinity`,
  never `NaN`**, no matter how deep the debt (`no-cutoff` test uses a
  debt of ~`-1e8` and still gets back exactly `DEFAULT_LOWEST_LANE`).
- **seen, standing > 0**: `DEFAULT_NEWCOMER_FLOOR + standing`, growing
  unbounded with earned standing, continuous with the floor as standing
  approaches `0` from above.

**Newcomer grace / optimistic-unchoke analog.** The flat floor above
*is* the "an unseen peer gets a small flat floor" half of this design
point. The other half is captured by `StandingLedger.pickOptimisticSlot
(candidatePeerIds)`: "the scheduler reserves one optimistic slot per
round for the least-history peer." It returns whichever candidate this
ledger has the fewest recorded events for (an unseen candidate always
wins; ties broken by earliest first-seen, then peerId for determinism),
independent of `priorityScore`. A future M2/M3 scheduler calls this once
per admission round alongside the normal priority pop to guarantee a
never-served peer eventually gets a look-in even under sustained
contention from established peers.

**Anti-gaming noise.** `priorityScore` adds a small `[-0.25, +0.25]`
(`DEFAULT_NOISE_AMPLITUDE`) term so a peer can't compute the exact
minimum contribution needed to stay in a better lane (the BitTyrant
lesson: don't expose a smooth, computable knob). The noise source is
injectable (`NoiseSource = (peerId, now) => number in [-1, 1)`); the
default (`defaultNoiseSource`) is a deterministic hash of `peerId` and a
1-second time bucket. It never calls `Math.random()`. That keeps the same
call reproducible in tests, and it also stops a peer from averaging the
noise away by polling in a tight loop within one scheduling round. The
amplitude is small enough (`0.25` against a `1.0`-wide newcomer-floor/lowest-lane gap)
that it can never flip a real lane boundary or invert a meaningful
standing gap between two established peers. Only ties among
near-identical peers are actually affected.

**Sybil residual: disclosed honestly.** This ledger is deliberately
**local-only, never gossiped**: there is no known anti-Sybil construction
for a reputation score shared among ephemeral peerIds (cheap identities
and Sybil-proof shared reputation are formally incompatible). The
consequence: a peer that abandons a debt-laden identity and rejoins with
a fresh peerId lands back at exactly `DEFAULT_NEWCOMER_FLOOR`: the
`Sybil-reset ≈ newcomer` test asserts this is *equal to* an honest
newcomer's score. That's the intended containment: resetting sheds debt,
but nets you back to the bottom of the "established
peer" ladder, never past it, and every driver a peer talks to has to be
re-earned independently (no shared reputation to bootstrap from). This is
a residual, accepted risk that's flagged here openly.

## API shape

```ts
import { StandingLedger, bindPriorityScore } from '@unstable-legion/core';

const ledger = new StandingLedger(); // or createStandingLedger(config)

// Fed by a driver's own session telemetry (see "Injection story" below).
ledger.recordService({ hostPeerId, layersServed, framesServed, servingMs, sessionCompleted }, now);
ledger.recordConsumption({ consumerPeerId, layersConsumed, framesConsumed, consumingMs }, now);

ledger.standingOf(peerId, now);      // decayed credit - decayed debit
ledger.priorityScore(peerId, now);   // the admission/route-spread hook value
ledger.pickOptimisticSlot(candidatePeerIds); // least-history candidate
ledger.topContributors(n, now);      // leaderboard, sorted by raw standing
ledger.myStanding(selfId, now);      // single-peer status panel read

// Bind to the exact `(peerId: string) => number` shape
// stageSessionAdmission.popNextByPriority's PriorityScoreFn expects:
const priorityScore = bindPriorityScore(ledger, () => Date.now());
```

## Injection story (now wired, current as of this section)

`standing.ts` exports everything from `packages/mesh-core/src/index.ts`
(and is re-exported again from `packages/mesh-react/src/index.ts` for
convenience). As of this pass, ONE `StandingLedger` instance lives per
peer, created once in the demo's `Dashboard` component
(`apps/demo/src/App.tsx`) and threaded down to every panel that has a
host or driver role:

```ts
const standingLedgerRef = useRef<StandingLedger | null>(null);
if (standingLedgerRef.current === null) standingLedgerRef.current = new StandingLedger();
const standingLedger = standingLedgerRef.current;
```

**Priority consumption points, both now live:**

- **M2 admission**: `stageSessionAdmission.ts`'s
  `popNextByPriority(queue, priorityScore?)` is fed
  `bindPriorityScore(standingLedger, () => Date.now())` via
  `useStageHost`'s new `standingLedger` option (`StagePipelinePanel`'s
  "host stages" role AND `CommunalHostPanel`'s communal-host role both go
  through `useStageHost`. Both therefore get this for free.)
- **M3 route/replan spread**: `planCommunalRoute`/`communalAttachOrder`'s
  ranking and `runCommunalDriverSession`'s `computeReplanJitterMs` both
  take the same bound `priorityScore` fn, threaded through
  `useCommunalChat`'s `priorityScore` option (`CommunalChatPanel` computes
  it once via `useMemo(() => bindPriorityScore(standingLedger, () =>
  Date.now()), [standingLedger])`).
- **M3 claim/yield tie-break**: `communalHostClaim`'s essential-claim/
  wasteful-overlap tie-break also takes the same fn, via
  `useCommunalHost`'s existing `priorityScore` option (already threaded
  pre-M4; `CommunalHostPanel` now supplies the real bound fn in place of
  the `() => 0` default).

**Telemetry: who calls `recordService`/`recordConsumption`, and why that
split (host debits consumers, driver credits hosts):**

- **`useStageHost.ts`'s `freeSession`** (every session end: natural
  finish, abort, idle-evict, or the new forced disconnect, see
  `docs/COMMUNAL.md`) calls `standingLedger.recordConsumption(
  {consumerPeerId: driverPeerId, layersConsumed: layerEnd-layerStart,
  framesConsumed: decodedCount, consumingMs: now-createdAt}, now)` when a
  `standingLedger` option was supplied. This is the "host directly
  witnessed a driver's resource consumption" half. It matches
  `recordConsumption`'s own contract (never gated on completion; a peer
  that aborted mid-stream still occupied the lane).
- **`useCommunalChat.ts`'s `recordSegmentTelemetry`** (on the mesh-core
  orchestrator's `'finished'`/`'aborted'`/`'replan'` events) calls
  `standingLedger.recordService({hostPeerId, layersServed, framesServed,
  servingMs, sessionCompleted}, now)` for the remote host(s) THIS run
  actually attached to, per ATTACHED SEGMENT (a replan resets the
  telemetry window: the earlier host's own outcome is recorded against
  its own serving time before the new segment's window starts, kept
  separate from it). `sessionCompleted` is `true` only on `'finished'`;
  both `'aborted'` and a superseding `'replan'` record `false`: the "driver
  directly witnessed host service" half, gated on completion per
  `recordService`'s own contract (closes the frame-farming/partial-work
  gaming gap this doc's Mechanics section already documented).

This split is deliberate: a HOST is the one positioned to
witness how long/how much a DRIVER occupied its lane (so it debits the
driver in its own local ledger, informing its own future admission
ordering); a DRIVER is the one positioned to witness whether a HOST
actually delivered a complete session (so it credits the host in its own
local ledger, informing its own future route/replan ranking). Neither
peer needs the other's ledger: this is exactly the "local-only, never
gossiped" design this doc's Sybil-residual section already commits to.

Unit-tested end to end (telemetry -> ledger -> priority, exercising the
EXACT math both call sites above compute) in
`packages/mesh-react/test/economyWiring.test.ts` (4 tests): a heavy
consumer is deprioritized behind a light one in the host admission queue;
an unseen driver still outranks a debt-carrying one; a driver-credited
host outranks an unseen candidate for the same route segment; a host
whose only recorded session aborted gets no credit. See `docs/COMMUNAL.md`
for the real-browser `communal.spec.ts` proof that the whole wire/worker
path this feeds off of (session completion/abort detection) actually
fires in a live mesh.

### Historical note (pre-this-pass state, kept for context)

Before this pass, both injection points above defaulted to `() => 0`
(pure FCFS) and `stageOrchestrator.ts` called neither `recordService` nor
`recordConsumption`: `standing.ts` was a fully-built, 35-test-covered
ledger with nothing feeding it. That gap is what this pass closes.

## Test matrix (`packages/mesh-core/test/standing.test.ts`, 35 tests)

| Property | Tests |
|---|---|
| Measured, not claimed | never-recorded peer stays at 0 regardless of any "advert"; a peer that actually serves accrues real, computed standing |
| Completed-sessions-only | aborted session credits 0; repeated aborts never accumulate; a completed session after aborted attempts credits only the completed one |
| Decay half-life | credit halves exactly at the configured half-life (default and custom); recent > historical for equal magnitude; out-of-order `now` never un-decays (anchor never moves backward) |
| Consumption debits | heavy consumer's standing sits below a light consumer's at equal credit; enough consumption drives standing negative; consumption debits independent of session completion |
| No-cutoff monotonicity | `priorityScore` stays finite under an extreme (~-1e8) debt; zero/unseen standing is finite and positive; `priorityScore` is monotonic non-decreasing in standing |
| Newcomer floor / Sybil-reset ≈ newcomer | unseen peer strictly outranks a debt-carrying peer; a cycled identity lands exactly at the newcomer floor (not above, not at the old debt); a small positive contributor sits strictly above the floor, continuous with it |
| Noise bounded | default-config noise stays within `±DEFAULT_NOISE_AMPLITUDE` across many time buckets; an extreme injected noise source is still clamped to the configured amplitude; adversarially-directed noise still cannot invert a large standing gap between two established peers; `defaultNoiseSource` is bounded to `[-1, 1)` and deterministic per `(peerId, bucket)` |
| Optimistic slot | empty candidate list; unseen beats seen regardless of standing; fewest-events wins among seen candidates; ties broken by earliest first-seen then peerId |
| Leaderboard / status read API | `topContributors` sorted descending by standing (not the noisy `priorityScore`), `n`-limited, ties broken by peerId; `myStanding` for both an unseen peer and a decayed one |
| Factory / binding | `createStandingLedger` factory parity with `new StandingLedger`; `bindPriorityScore` produces the exact 1-arg `(peerId) => number` shape and reflects clock advancement |
| Config | `DEFAULT_STANDING_CONFIG` matches its named constants; `lowestLane < newcomerFloor` invariant holds |

Run: `cd packages/mesh-core && npm test` (or `npx node --test --import tsx
test/standing.test.ts` for just this suite).
