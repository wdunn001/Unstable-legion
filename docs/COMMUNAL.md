# M3 — the communal pipeline: coordination-free self-assembly

Builds on M1 (legion-stage-runtime's multi-session API) and M2
(`docs/M2-MULTI-SESSION-HOST.md` — one host, N concurrent driver sessions,
`stage.session.open`/`accept`/`busy` implemented host-side but never wired
to a driver). M3 closes that gap AND adds the piece neither M1 nor M2
needed: **many volunteer hosts assembling coverage of one shared model
with no coordinator, no election, no central planner** — the thing that
makes "everyone opens the app and it just becomes part of the mesh" real
instead of aspirational.

## The three pure modules (mesh-core, unit-tested, no I/O)

### `communalTopology.ts` — "what does the mesh currently cover"

`buildCommunalTopology(roster, {modelId, totalLayers, driverLayers})`
unions every roster peer's `cap.stageHost.loadedStages[]` (the new M3 cap
field — an array of `{modelId, layerStart, layerEnd, includeEmbeddings,
includeOutput, ctxSize, wireDtype, maxSessions, activeSessions, epoch}`,
additive on `MeshPeerCap.stageHost`) into a coverage map: `segments`
(covered stretches, each carrying every candidate host advertising that
EXACT range — duplicates are warm spares), `gaps` (uncovered stretches),
`seats` (min-over-segments Σ headroom — the bottleneck concurrent-session
capacity of the whole assembled pipeline; 0 whenever any gap exists),
`coverageFraction`, `outputCovered`.

The coverage walk is a classic greedy "furthest reach wins" frontier scan
— critically, every segment it produces carries a candidate's OWN exact
`(layerStart, layerEnd)`, never a trimmed sub-range, because a driver can
only ever ask a host for what it ACTUALLY loaded (`useStageHost.ts`'s
`ensureWorkerLoaded` reloads/conflicts on a mismatch — see that file's
`sameConfig` check).

`planCommunalRoute(topology, {driverPeerId, priorityScore?, spreadWidth?,
nEmbd, wireDtype?})` picks one host per covered segment — ranked by
headroom → priority → stability → RTT, then an **anti-stampede spread**
(`hash(driverPeerId) % min(candidates, spreadWidth=3)`) so different
drivers fan out across the top few candidates instead of every driver
piling onto the single globally-best host — and returns a **normal
`StagePlan`** (the exact same shape `stagePlanner.ts#planPipeline`
produces), so every existing plan-driven UI/consumer works unmodified.
`communalAttachOrder` exposes the same ranking as a full ordered
candidate list (chosen-first, then busy-fallback spares) for the driver's
attach loop.

### `communalAssembly.ts` — "what should THIS host claim, right now"

`communalHostClaim(...)` is the host-side decision, called independently
by every peer against its own view of the roster — no message exchange,
no election:

1. **Gap-filling**: claim the lowest uncovered gap, anchored at the gap's
   own start (ranges pack upward from `driverLayers`), capped by the
   host's own capacity.
2. **Warm-spare**: fully covered but a segment is under-replicated
   (fewer than `maxSparesPerSegment + 1` candidates) → duplicate it.
3. **Essential-claim protection** (the anti-thundering-herd fix found by
   the convergence property tests — see below): a host that's already the
   SOLE winner of its own frontier-walk segment never reconsiders leaving
   just because another host's simultaneous claim looks more attractive.
   Without this, N hosts claiming at the exact same tick (before jitter
   has staggered them) each see an empty "others" view, independently
   compute the same "lowest gap", and the frontier walk only ever credits
   the single furthest-reaching one — every shorter-but-honest claim then
   looks redundant to its own owner and the whole mesh stampedes toward
   whatever's left, never converging.
4. **Adjacent-gap growth**: an essential host with unused capacity
   headroom absorbs an immediately-adjacent gap (including one that
   fully engulfs its own position, e.g. after its neighbors all yielded
   in the same tick) — lets a host with slack absorb a dead neighbor's
   range without a dedicated pre-positioned spare.
5. **Wasteful-overlap yield**: a duplicate segment while a gap exists
   ELSEWHERE is wasted capacity — a deterministic tie-break (priority →
   stability → lexically-greater-peerId-loses) picks exactly one loser
   mesh-wide per tick, so no two hosts both stay (thrash) or both leave
   (re-opens the gap).

**Property tests** (`test/communalAssembly.test.ts`) simulate random host
populations (2-7 hosts, randomized capacity/stability, staggered
per-round action order matching real jitter-staggered reality) across 40+
seeds each and assert: (a) convergence to full coverage whenever total
capacity is sufficient, (b) re-convergence after killing a random host
mid-run, (c) bounded redundancy (no segment ever exceeds the spare cap;
idle hosts genuinely go idle, not perpetually duplicating). **Two real
bugs were found and fixed by these tests, not by inspection**: the
thundering-herd stampede (essential-claim protection, above) and a
"tight tiling has no self-heal path" gap (adjacent-gap growth, above) —
both invisible to single-decision unit tests, both only surfaced once the
simulation ran enough random multi-agent rounds to hit the adversarial
timing.

### `stageOrchestrator.ts` — `runCommunalDriverSession`

The driver side of the handshake M2 built host-side and never wired up.
Shares this module's own private helpers (`makeEmitter`, `meanOf`,
`sendAndAwaitControl`) with `runDriverStageSession` — no fork, same file.

Per remote segment (downstream-first, matching the legacy ordering
convention): preflight `stage.ping` → `stage.session.open` with the wire
header embedded as base64 (no separate header `sf` frame — that's the
whole point of M2's `wireHeader`-in-open design) → on
`stage.session.busy`:
- `queuePosition` present → wait on the SAME `callId` for a LATER
  `stage.session.accept` (the host's `admitNextQueued` sends it there,
  see M2's doc) before giving up and trying the next candidate;
- absent (queue full) → fall through to the next candidate in
  `communalAttachOrder`'s list immediately.

Every candidate exhausted, a host death mid-decode, or a graceful
`stage.stop` all funnel into `replanRoute(lostPeerId, graceful)` — a
churn-jittered retry (`computeReplanJitterMs`: shrinks with priority,
spread by `hash(sessionId:restartCount)` so several chats that lost the
SAME host don't retry in lockstep) that re-attaches on a fresh route and
re-prefills history in ≤256-token chunks. **A deliberate improvement over
the legacy path**: even the VERY FIRST attach attempt now retries via
`replanRoute` on failure (the legacy `runDriverStageSession` just aborts)
— a communal route's built-in redundancy (warm spares) makes a second
attempt cheap and often successful even when planning was already
slightly stale.

**Scope limit, same as the legacy path's documented one**: only the
2-total-stage topology (local driver stage-0 + ONE remote communal
segment) is wired end to end for actual `sf` traffic — multi-hop relay
across >1 remote communal segment has no host-side forwarding loop
anywhere in this repo yet (`runDriverStageSession`'s own SCOPE NOTE flags
the identical gap). In practice this rarely bites: `communalHostClaim`'s
capacity-capped claim lets one sufficiently spacious host claim an entire
gap, and additional hosts become warm spares of that SAME segment (which
the attach-order fallback already handles) rather than partial-range
co-owners.

Unit-tested with a mock transport (`test/communalDriverSession.test.ts`):
immediate accept, busy+queued→later-accept, busy-rejected→next-candidate,
silent/dead candidate→timeout→next-candidate, every-candidate-exhausted→
replanRoute, host death mid-decode→replan with token history intact,
graceful stop→instant replan, no-route→clean abort, natural finish→
`stage.stop` sent so the host frees its lane, external `abort()`.

## `useStageHost.ts` changes (mesh-react)

- Publishes `cap.stageHost.loadedStages` (one entry — this hook still
  only ever serves one stage per mount) once a worker is loaded, derived
  from `loadedConfig`/`workerClient.isFirst`/`isFinal`, with an `epoch`
  counter bumped every successful (re)load.
- **Immediate republish**: every `syncPublicState()` call (session
  open/free/queue change) now also calls a same-tick republish instead of
  waiting for the 15s heartbeat — a driver deciding "does this host have
  a free lane right now" needs current occupancy, not stale data.
- New `preloadStage` option: proactively load a stage BEFORE any driver
  ever sends `stage.load`/`stage.session.open` — reuses the existing
  `ensureWorkerLoaded` reuse/reload/conflict rules verbatim, which is
  what gives `useCommunalHost.ts` "never reconfigure out from under an
  active session" for free (a conflicting preload while sessions are
  live throws, caught, retried next tick once idle).
- New `suppressAdvertise` option: publish `stageHost` WITHOUT
  `loadedStages` while true, even though a stage may still be actively
  serving — the "stop advertising" half of graceful teardown.
- New `useMemoryShardStore` plumbing (`StageWorkerClient.load`,
  `stageWorkerProtocol.ts`'s `StageWorkerRequest`, `apps/demo`'s
  `stageWorker.ts`): forces the in-memory `ShardStore` instead of OPFS
  for a load, additive and off by default.

## `useCommunalHost.ts` (mesh-react) — the assembly loop

Every `reassemblyIntervalMs` (default 5s): call `communalHostClaim`
against the live roster, act on the decision:

- **`yieldCurrent`**: `suppressAdvertise=true` immediately (real,
  structural — stops the wire advertisement THIS tick), then wait for
  active sessions to drain naturally (or a 30s grace timeout), then clear
  the claim so the next tick decides where to go.
- **New claim**: wait `jitterMs` (stability-scaled, hash-spread), then
  RE-CHECK against the current roster (something may have changed during
  the wait), resolve the layer range's artifact fragments
  (`resolveCommunalShardPlan` — manifest-based `fragmentsForRange` when a
  `manifestUrl` is supplied, respecting the OPFS-quota ceiling by forcing
  `useMemoryShardStore` when the claimed range's fragment bytes would
  exceed it; falls back to the flat `full.gguf` convention otherwise),
  and hand it to `useStageHost` via `preloadStage`.
- `useStageHost` only ever populates/publishes `loadedStages` AFTER
  `ensureWorkerLoaded` resolves (which is after `warmUpStageWorker`) — so
  "never advertise a not-warm stage" (the C3 cold-shader lesson) is
  structural here, not a manual check this hook has to remember to do.

**Honest scope note on teardown**: "stop advertising" is real and
immediate; "drain" waits for natural session completion or the existing
5-minute idle-eviction sweep; the 30s grace window in THIS hook gates
"give up and let a NEW claim be attempted" (which safely no-ops against
still-active sessions via `useStageHost`'s existing conflict check) — it
is NOT a forced kill of lingering sessions. `useStageHost` exposes no
"terminate all active sessions now" imperative today; a genuinely forced
disconnect after grace is follow-up work, not implemented in this pass.

## What's wired into the demo (`apps/demo`)

`CommunalHostPanel.tsx` — a "contribute to communal pipeline" toggle
driving `useCommunalHost` with `fallbackShardUrls` pointed at the existing
`full.gguf` convention (this deployment has no Phase C layer-package
manifest for `qwen3-0.6b-q8_0` yet — `manifestUrl` is left unset, and
`resolveCommunalShardPlan` falls back cleanly, exactly as designed).
Shows phase/claim/session occupancy and a self-reported mesh-coverage
list from the roster's `loadedStages`. `window.__legionCommunal` is
populated for Playwright/manual debugging, mirroring
`StagePipelinePanel`'s `window.__legionStage` convention. The whole demo
(`vite build`) builds clean with this wired in.

`CommunalChatPanel.tsx` (this pass) — the driver-side companion, wired
alongside it in `Dashboard`. `window.__legionCommunalChat` mirrors the
same debug-surface convention. Both panels (plus `StagePipelinePanel`)
now share ONE `StandingLedger` instance per `Dashboard` mount (see
`docs/ECONOMY.md`).

## Closing the loop (this pass)

The gaps below (all from the original M3 pass) are now closed:

- **`useCommunalChat.ts` (mesh-react) — the driver-side caller.** Builds
  the `CommunalRoute`/`CommunalRouteFn` `runCommunalDriverSession` was
  missing (roster → `buildCommunalTopology` → `planCommunalRoute` +
  `communalAttachOrder` → `runCommunalDriverSession`), hosts stage 0
  locally over the fixed `[0, STAGE_DRIVER_LAYERS)` range every communal
  host anchors its own claims against, and reuses `useStagePipeline`'s
  exact `acquireLeaderLock` "one driver per tab" idiom. Exposes `{
  start(prompt, opts?), status, tokens, text, restartCount,
  readyStageIndexes, abort }`. Wired into the demo as
  `CommunalChatPanel.tsx`, with `window.__legionCommunalChat` for
  Playwright/manual debugging.
- **The M3 e2e acceptance test now exists and is green**
  (`apps/demo/e2e/communal.spec.ts`, 2/2 confirming runs, ~1.1-1.5m
  each): 3 host tabs self-assemble `[2,28)` coverage from empty (1
  segment, 3 candidates — real WebGPU capacity per host comfortably
  covers the whole communal range solo, so the OTHER two hosts become
  warm spares of the exact same segment rather than partial co-owners —
  see `stageOrchestrator.ts`'s SCOPE NOTE on why this is the common,
  well-supported case), 2 concurrent communal chats stream real tokens,
  killing the host both drivers share (forced via a `?spreadWidth=1`
  e2e-only URL param — see `CommunalChatPanel.tsx`) triggers a replan on
  both (~1.6-2.1s detection latency, non-lockstep — observed 0-510ms
  stagger across runs) and BOTH finish with `restartCount:1`,
  token-history continuous (63/63 tokens each run). The test asserts the
  HONEST branch adaptively (recover-via-spare vs clean-abort-on-lost-
  coverage) based on the pre-kill candidate count it actually observes,
  not a hardcoded expectation.
- **`priorityScore` is now wired end to end** — see `docs/ECONOMY.md`'s
  updated "Injection story". `bindPriorityScore(ledger, clock)` feeds
  `useStageHost`'s admission queue, `useCommunalHost`'s claim/yield
  tie-break, and `useCommunalChat`'s route ranking + replan jitter, all
  from ONE `StandingLedger` per peer (created once in the demo's
  `Dashboard`).
- **Forced session termination after the 30s teardown grace** is now
  implemented: `useStageHost.ts`'s new `forceDisconnect` option (bridged
  via the same ref-watcher pattern as `preloadStage`, never added to the
  "answer" effect's own dependency array) frees every still-attached
  session and notifies its driver via `stage.stop`. `useCommunalHost.ts`
  fires it once the drain grace expires with sessions still attached
  (previously a documented no-op).

## What's still NOT done

- **No manifest exists yet for `qwen3-0.6b-q8_0`** (or any model) at this
  deployment — the manifest-based `fragmentsForRange`/OPFS-quota path in
  `resolveCommunalShardPlan` is implemented and unit-tested with a
  synthetic manifest, but has never been exercised against a real
  deployed layer-package manifest end to end. `communal.spec.ts` (like
  `CommunalHostPanel`) uses the fallback `full.gguf` convention, same as
  every other e2e suite in this repo — deploying a real per-layer
  manifest for this model is separate follow-up work, not required for
  the communal pipeline to function correctly (the fallback path is
  exercised, proven, and this is what's actually deployed today).
- **Multi-hop relay across >1 remote communal segment** still has no
  implementation (documented limitation shared with the legacy
  `runDriverStageSession`, not new to M3/M4). Not exercised by
  `communal.spec.ts` either — the real assembled topology in this pass's
  runs always converged to exactly one segment (see above), which is the
  scope both driver session functions actually support end to end.

## Test matrix

`packages/mesh-core`: 164/164 (`npm test`) — 119 + 20
`communalTopology.test.ts` + 15 `communalAssembly.test.ts` (including 3
convergence property-test suites across 80+ random seeds total) + 10
`communalDriverSession.test.ts`. Unchanged this pass (no mesh-core source
edited — `useCommunalChat`/economy wiring lives entirely in mesh-react
and the demo; mesh-core's `priorityScore`/`standingLedger`-shaped hooks
were already exposed and unit-tested by the M3/M4 passes).

`packages/mesh-react`: 38/38 (`npm test`) — 34 pre-existing + 4 new
`economyWiring.test.ts` (telemetry -> `StandingLedger` -> priority,
exercised through the EXACT math `useStageHost.ts`'s `freeSession` and
`useCommunalChat.ts`'s `recordSegmentTelemetry` compute, fed into
`popNextByPriority` and `planCommunalRoute`'s ranking — this repo has no
jsdom/testing-library harness to render the hooks themselves, so the pure
logic is pulled out and tested directly, same precedent as
`resolveCommunalShardPlan`'s existing tests).

`apps/demo`: `vite build` succeeds with `CommunalChatPanel` wired in
alongside `CommunalHostPanel`/`StagePipelinePanel`. Full e2e matrix
(`communal.spec.ts` NEW + `pipeline-split`/`chaos`/`compat`/`discovery`/
`debug-two-workers`/`pipeline-split-context-variants`/
`multi-session-host`, all pre-existing) re-run and green this pass — see
this file's "Closing the loop" section above for `communal.spec.ts`'s own
results. Two real, pre-existing selector collisions were found and fixed
while doing this (not new bugs introduced by this pass, but only surfaced
once a SECOND panel with an overlapping class name — `CommunalChatPanel`'s
`.sp-prompt` — was added to the same page): `StagePipelinePanel`'s host
toggle and prompt input gained disambiguating classes
(`stage-host-toggle`, `stage-pipeline-prompt`) since `.sp-host-toggle`/
`.sp-prompt` alone now match more than one element once `CommunalHostPanel`
(added by the ORIGINAL M3 pass) and `CommunalChatPanel` (this pass) are
both always rendered in `Dashboard`; every e2e call site
(`helpers.ts`/`chaos.spec.ts`/`pipeline-split.spec.ts`/
`pipeline-split-context-variants.spec.ts`) was updated to match.
