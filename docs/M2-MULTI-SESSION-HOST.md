# M2 — one stage host, N concurrent driver sessions

Builds on legion-stage-runtime's M1 (`docs/MULTI-SESSION.md` in that repo):
one loaded stage — one `StageWorkerClient`, one fetched model — now answers
several concurrent driver sessions instead of tearing itself down on a
second `stage.load`.

## sessionId routing: mesh-core envelope, not a Codec frame field

Two options were on the table for telling a multi-session host which
session an inbound `sf` (activation-frame) byte blob belongs to:

1. Add `sessionId?: string` to the Codec activation-profile frame itself
   (`packages/web/src/latent-frame.ts` in the separate Codec repo,
   `spec/PIPELINES.md` § Activation profile bumped to v0.7) — requires a
   cross-repo edit, an `@codecai/web` dist rebuild, and a robocopy into
   `unstable-legion/node_modules/@codecai/web/dist`.
2. Wrap the `sf` payload in a small length-prefixed envelope entirely
   inside mesh-core (`packages/mesh-core/src/stageFrameEnvelope.ts`).

**Chose option 2.** It keeps the whole M2 change inside this repo — no
Codec repo edit, no dist rebuild/robocopy — while being exactly as
effective: the envelope is stripped before the inner bytes ever reach the
Codec/stage-runtime wire decoder (`@unstable-legion/stage-runtime`'s
`frames.ts`, which stays untouched and doesn't need to know sessions
exist). Wire shape: `[uint16 sessionId byte-length][sessionId UTF-8
bytes][opaque payload]`. `stageOrchestrator.ts` (driver side) wraps every
outbound `sf` send; `useStageHost.ts` (host side) unwraps every inbound
`sf` receive and routes by `sessionId` to that session's own
`awaitingHeader`/decoder state, with a `peerId === driverPeerId` spoof
guard on top.

## Three new stage-control kinds (`packages/mesh-core/src/stageControl.ts`)

Additive to the existing seven (`stage.load/ready/stop/ping/pong/progress/
token`), same tool-call-shaped encoding over the `tc` action:

- **`stage.session.open`** (call): `{sessionId, modelId, layerStart,
  layerEnd, totalLayers, ctxSize, wireDtype, wireHeader}` — `wireHeader`
  is base64 of `ActivationWireEncoder.headerBytes()`, sent UP FRONT.
- **`stage.session.accept`** (result): `{sessionId, nEmbd, isFirst,
  isFinal, activeSessions, maxSessions}`.
- **`stage.session.busy`** (result): `{sessionId, queuePosition?,
  estWaitMs?}` — `queuePosition` present = queued (bounded 16, TTL 30s);
  absent = queue itself was full, rejected outright.

The `wireHeader`-in-open field kills the pre-M2 "the first `sf` frame
after open is the wire header" convention, which only worked for exactly
one session at a time — with several sessions' `sf` traffic interleaved
on one host there's no reliable way to tell "is this THE first frame for
THIS session" without an explicit signal. `stage.session.open` is
implemented in `useStageHost.ts` but not yet wired into a driver (see
"What's NOT wired up" below) — `stageControl.test.ts` proves the
kinds round-trip correctly and are guard-safe.

## useStageHost.ts: from scalar session state to a session map

Pre-M2: scalar `workerClient`/`decoder`/`sessionId`/`driverPeerId` —
a second `stage.load` unconditionally tore the first down.

Post-M2: ONE `StageWorkerClient` per loaded stage (weights fetched once)
+ `Map<sessionId, HostSessionState>`, each entry owning its own
`awaitingHeader`/`decoder`/`decodedCount`/`lastFrameAt`. Two origins feed
the same admission pipeline:

- **legacy** (`stage.load`, what `stageOrchestrator.ts`'s driver still
  sends): decoder built via the old first-frame convention, now scoped
  per-session instead of globally. Replies `stage.ready` (unchanged wire
  shape — a pre-M2 driver still works unmodified).
- **session** (`stage.session.open`, new): decoder built immediately from
  the embedded `wireHeader`. Replies `stage.session.accept` /
  `stage.session.busy`.

Admission (`stageSessionAdmission.ts`, pure + unit-tested with a mock
clock): admit immediately while `activeCount < maxSessions`; otherwise
`stage.session.open` requests queue (bounded 16, TTL 30s, popped by an
injected `priorityScore(peerId)` — default pure FIFO, `() => 0`, until a
future milestone wires real prioritization) while legacy `stage.load`
requests fail fast (`stage.stop`) since the legacy driver has no
busy/retry concept.

Cleanup, in order of how a session actually goes away: (a) explicit
`stage.stop` (now sent by `stageOrchestrator.ts` on BOTH abort AND a
clean finish — see below), (b) the driver peer leaving the mesh
(`peer.roster.subscribe`), (c) 5-minute idle sweep
(`isSessionIdle`/`DEFAULT_IDLE_EVICT_MS`), (d) the host itself detecting
EOS on a decode step. Every path funnels through one `freeSession()` that
frees the worker-side lane and tries to admit the next queued request.

A same-config `ensureWorkerLoaded` call while a load is already in flight
(the exact shape two near-simultaneous driver opens produce) awaits the
SAME in-flight promise instead of racing a second `.load()` — caught
during e2e development, not by unit tests (this is exactly the kind of
bug pure state-machine tests can't see; only the concurrent 2-driver e2e
exercises it).

## maxSessions: chosen once, at load time

`chooseMaxSessions(desired)` (`stagePipelinePlanning.ts`) clamps to
`[1, 8]`, default 4 — this is `driverMaxSessions`, the number of
CONCURRENT DRIVER sessions the host commits to. The native
`StageDescriptor.maxSessions` (skippy's `lane_count`) passed to
`legion_stage_open` is `driverMaxSessions + 1`: `legion_stage_open`
always creates one additional FUSED session internally (used here only
for `useStageHost.ts`'s one-time warm-up dispatch) that permanently
occupies a lane — getting this off-by-one wrong silently steals one
driver's worth of concurrency. Deliberately NOT derived from
`perSessionKvBytes`/KV-budget math — M1 measured the WebGPU KV buffer as
IDENTICAL at `max_sessions=1` vs `4` in the reference build, so that
formula is a conservative planning upper bound, not a real per-session
cost.

## e2e proof (`apps/demo/e2e/multi-session-host.spec.ts`)

Reuses the real production path end to end: one host tab (real WebGPU,
real wasm), two driver tabs each running their own local stage-0 worker
and the existing `stageOrchestrator.ts`/`useStagePipeline` driver flow
(the LEGACY `stage.load` origin — see "What's NOT wired up"). Method
mirrors legion-stage-runtime's M1 gate: run prompt A and prompt B alone
(sequential, solo baselines) against the host, then run them again
CONCURRENTLY against the SAME loaded host, sampling the host's session
occupancy while both are in flight. Result (last run): 2 concurrent
sessions observed on the host, both concurrent runs 63/63 tokens
token-exact vs their solo baselines, zero replans on either driver.

## What's NOT wired up (honest scope note)

`stage.session.open`/`accept`/`busy` are implemented on the HOST side
(`useStageHost.ts`) and unit-tested (`stageControl.test.ts`), but no
driver in this repo sends `stage.session.open` yet — `stageOrchestrator.ts`
still only ever sends the legacy `stage.load`. The e2e concurrency proof
above therefore exercises the LEGACY origin path (still genuinely
concurrent, still sessionId-enveloped over `sf`, still isolated) rather
than the new kind. Wiring a driver onto `stage.session.open` (to get
`stage.session.busy`/queueing exercised live, not just in the pure
admission unit tests) is follow-up work, not done in this pass.

## Concurrent-dispatch wasm race found under real load (stageWorker.ts)

The first isolated run of `multi-session-host.spec.ts` passed cleanly, but
running it as part of the FULL `apps/demo` e2e suite (heavier back-to-back
GPU/browser load) surfaced an intermittent wasm-level `RuntimeError:
unreachable` deep in skippy's native code, late in the concurrent phase
(around token 61/63). Root cause: `apps/demo/src/workers/stageWorker.ts`'s
`self.onmessage` fired `handle(req)` per inbound postMessage with no
serialization — two sessions' `prefill`/`decode` requests arriving close
together could each have a `handle()` call in flight with overlapping
`await`s (WebGPU dispatch + readback are real async yield points, not
synchronous stubs) into the SAME wasm instance / GPU device. This is a
DIFFERENT concurrency shape than legion-stage-runtime's M1 harness gate,
which alternates "session A one full step, THEN session B one full
step" — never two steps' async work genuinely overlapping.

Fixed by serializing every native/wasm dispatch through one promise chain
in the worker (`serialize()` wrapping `handle()`), so only one call is
ever in flight against the wasm module at a time regardless of how many
sessions are logically concurrent. Each session still gets its own
independent KV state (M1's proven guarantee, unaffected) — the queue only
orders WHEN each session's native call executes. Re-ran the full e2e
suite after the fix with no recurrence.

## Idle-eviction / notify-on-finish gotcha found during e2e

`stageOrchestrator.ts`'s driver only sent `stage.stop` on ABORT
pre-M2 — a session that finished cleanly (hit `maxDecodeTokens` without
an explicit EOS, or got one the host free'd on) was simply abandoned by
the driver. Pre-M2 this didn't matter (the next `stage.load` tore the
whole worker down anyway); post-M2 it left a lane pinned for up to 5
minutes (the idle-eviction window) after a successful run — caught by
the concurrent e2e test polling `host.sessions.length` back to 0 between
phases and timing out. Fixed by having `runDriverStageSession` send
`stage.stop` on every natural finish too (`notifyRemotesDone`), not just
on abort — a small, additive fix to `stageOrchestrator.ts` alongside the
M2 work.
