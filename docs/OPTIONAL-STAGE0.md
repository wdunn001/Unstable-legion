# OPTIONAL-STAGE0 — thin drivers (weak / no-GPU devices in the mesh)

The communal pipeline (`docs/COMMUNAL.md`) assumes every driver can host
**stage 0** locally: layers `[0, driverLayers)` + embeddings in a WebGPU
worker, tokenize/detokenize on the CPU. A phone, a locked-down work laptop,
or any browser without usable WebGPU can't do that — but it can still
**tokenize and detokenize** (wasm, no GPU) and it can still drive a chat.

A **thin driver** hosts *no* stage. It ships its token-ids to a **remote
isFirst host** — a communal host that owns `[0, X)` *including embeddings* —
and streams tokens back, detokenizing locally. This is feasible because the
activation wire already carries a `tokens` sideband (`stageFrameEnvelope.ts`
+ stage-runtime `frames.ts`), and an isFirst host prefills from token-ids
with no meaningful input activation — exactly what a capable driver's own
local stage 0 already does. The thin driver simply moves that first step
onto the mesh.

> **Privacy cost — stated, not hidden.** A capable driver computes the
> embedding + first layers locally, so what leaves the device is already an
> activation tensor. A thin driver ships **raw token-ids** (trivially the
> prompt text) to the first host. That's strictly weaker privacy. It is
> surfaced verbatim in `docs/TRUST.md` and in the apps/chat trust
> interstitial (`THIN_DRIVER_TRUST_ADDENDUM`), shown to thin devices before
> their first message.

## What landed (this PR)

### 1. Capability gate — `webgpuLimits.ts` (mesh-react)

`isThinDriver(result, minBytes?)` classifies a `detectWebGpuLimits()` result:
thin iff WebGPU is absent/unusable OR `maxStorageBufferBindingSize` is below
`USABLE_STAGE_HOST_MIN_BYTES` (128 MiB — the empirical floor for hosting even
stage 0 of the smallest deployed model). Pure, unit-tested
(`test/webgpuLimits.test.ts`).

### 2. Topology + assembly (pure, mesh-core) — coexisting regimes

- **`buildCommunalTopology(..., { communalStart })`** — the coverage walk's
  start layer. Defaults to `driverLayers` (the capable regime, **unchanged**);
  pass `communalStart: 0` to build the thin view: coverage of `[0,
  totalLayers)` that keeps isFirst `[0, X)` ads the default view drops.
- **`thinDriverFirstStageCovered(topology)`** — a gap-free thin topology is
  only *thin-routable* if its lowest segment starts at layer 0 with a
  candidate that includes embeddings (a real isFirst host).
- **`planThinDriverRoute(topology, opts)`** — the thin analog of
  `planCommunalRoute`: a `StagePlan` with **no synthetic local stage 0** —
  stage 1 is the remote isFirst host, the last is isFinal.
- **`communalHostClaim(..., { firstLayer })`** — a host that opts in to
  supporting thin drivers passes `firstLayer: 0`; it then gap-fills from
  layer 0, so its lowest claim owns the embeddings (`includeEmbeddings`) — an
  isFirst communal host. Default `firstLayer: driverLayers` is unchanged.

**Both regimes coexist in one room, with no coordinator.** A capable host
(`firstLayer: driverLayers`) covers `[driverLayers, totalLayers)` and never
sees thin ads (its topology drops `layerStart < driverLayers`), so capable
coverage is self-sufficient. A thin-support host (`firstLayer: 0`) sees
*everything* and either claims the whole model (single-hop thin route) or
just the `[0, driverLayers)` prefix, reusing capable body coverage. The
property tests in `test/communalThinDriver.test.ts` prove BOTH the capable
topology and the thin topology (with an isFirst host at layer 0) converge to
full coverage under random populations and mid-run churn (kill the isFirst
host → the mesh re-covers the prefix).

### 3. Thin-driver session path — `runCommunalDriverSession({ thinDriver })`

A **mode flag on the same session state machine**, not a forked function.
In thin mode the orchestrator never asks `localHooks` for a boundary
activation — it ships a zero-filled placeholder of the right wire shape (the
isFirst host ignores it and embeds from the `tokens` sideband) and skips the
local KV `reset`. `tokenize`/`detokenize`/`nEmbd` still flow through (all
CPU). Attach-order, busy-queue fallback, churn, and replan all behave
identically. Unit-tested with a mock transport
(`test/communalThinDriver.test.ts`) asserting a session completes **without
ever calling local prefill/decode**.

### 4. Hook wiring (mesh-react)

- `useCommunalChat({ thinDriver, thinTokenizer })` — thin mode skips the
  WebGPU gate and the local stage-0 worker, builds the route via
  `planThinDriverRoute` (communalStart 0), passes `thinDriver: true` to the
  orchestrator, and uses the injected CPU tokenizer for
  tokenize/detokenize + on-screen text.
- `useCommunalHost({ supportThinDrivers })` — threads `firstLayer: 0` into
  its claim loop so the host contributes an isFirst `[0, X)` stage; the
  loaded stage's `layerStart === 0` makes `useStageHost` report
  `isFirst`/`includeEmbeddings` automatically (no host-side wire change).

## Scope limit / follow-up (honest)

- **Single-hop is the wired case.** Like the capable path
  (`stageOrchestrator.ts`'s SCOPE NOTE), only a **2-total-stage** shape is
  wired end to end for `sf` traffic — for a thin driver that's *one* remote
  isFirst+isFinal host covering `[0, totalLayers)` (the "one spacious host
  claims the whole gap" common case). The topology/assembly can *express* a
  multi-hop thin route (a `[0, driverLayers)` prefix host + separate body
  hosts), but multi-hop relay has no host-side forwarding loop anywhere in
  this repo yet — the identical documented limitation the capable path
  carries, not new to this feature.
- **CPU-only tokenizer worker.** `useCommunalChat` takes an injected
  `thinTokenizer` (nEmbd + tokenize/detokenize). Wiring the demo/apps a
  genuinely GPU-free tokenizer-only stage worker (the wasm tokenizer without
  a loaded GPU stage) is the remaining app-layer step; the hook contract and
  the whole mesh-core path are landed and tested. On a capable device you can
  exercise thin mode today by injecting the existing stage worker as the
  tokenizer.

## Three roles, and why a capable peer's stage 0 loads LAZILY

A capable peer can play up to three independent roles; they load different
things at different times, which is easy to conflate:

| Role | Loads | Why |
| --- | --- | --- |
| **Host** (contribute to the mesh) | the **body stage** `[driverLayers, totalLayers)` | Runs *other drivers'* activations through its layers — it serves *their* requests. It **never touches its own stage 0** to do this: the driver's stage 0 (wherever that driver is) produced the activation; the host just runs the body on it. |
| **Driver** (chat yourself) | your **stage 0** `[0, driverLayers)` + a route through body hosts | Tokenize → embed → first layers → produce the first activation, then hand off. This is the *only* role that needs stage 0. |
| **Serve stage 0** (the "Serve the first stage" toggle) | your stage 0 `[0, driverLayers)`, reused | Lets **thin drivers** (phones) borrow your already-loaded stage 0 as their isFirst host (the RESIDENT stage-0 path — `useCommunalChat.residentStageZeroRef` → `useLocalStageServe`). |

**Consequence:** a peer that is *purely a host* — contributing its body layers
to serve everyone else, never chatting — does **not** need stage 0 at all.
Eager-loading stage 0 for that peer would waste ~350MB VRAM + load time it
never uses. That is why stage 0 is loaded **lazily** on this peer's first
chat (via `ensureResidentStageZero`), not at hosting-enable time.

**Current wiring (2026-07-18):** the "Serve the first stage" toggle both
(a) eager-loads the resident stage 0 (so a thin client that routes here isn't
stuck waiting out a cold `[0, driverLayers)` download) **and** (b) advertises
this peer as an isFirst host for thin clients. Splitting those two — always
eager-load stage 0 regardless of the toggle, and have the toggle *only*
advertise willingness to serve — was considered and **deferred**: it re-opens
the "who actually needs stage 0" question above (a pure host would then pay
for stage 0 it never uses) and the eager path can race the body-host WebGPU
load on a stressed GPU (see the KNOWN FRAGILITY note in `useCommunalChat.ts`).
Revisit alongside serializing the eager load behind the host load.
