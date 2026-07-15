# Casefile: second stage worker dies silently in the pipeline-split e2e

Status: OPEN. Mainline `pipeline-split.spec.ts` red; every other suite green.
14 instrumented runs, 2026-07-15. Full logs: `%TEMP%\c3-mainline-run*.log`.

## The failure (stable signature)

3 pages (driver + hostA + hostB), driver runs stage 0 locally then sends
`stage.load` to the chosen remote host. The remote's stage worker:
1. spawns, imports the wasm glue fine;
2. `createLegionStageModule` resolves (WebGPU adapter+device acquired —
   "wasm module: ready" logs);
3. begins streaming `full.gguf` (610 MB) into MEMFS;
4. **dies at ~320 MB streamed** — no ErrorEvent, no wasm abort
   (`onAbort` wired, silent), no stderr, no pageerror. Playwright sees
   `worker close`.
Same 320 MB mark across runs 10/11. Whichever host is chosen as remote dies;
the spare idles normally. Driver's identical load on the same server/browser
succeeds first every time.

## Ruled OUT (each with evidence)

- Vite dev-server mid-run reload (real bug, fixed: optimizeDeps.include +
  watch ignores + build+preview via globalSetup — reload gone from logs).
- Stale bundle via leaked preview server (real bug, fixed:
  reuseExistingServer:false + single-process webServer command; port-kill).
- Trystero silent unicast drop (control messages flow; stage.load arrives).
- Host-side error swallowed (load deadline added — fires correctly, converts
  to stage.stop with reason; drivers abort fast now).
- Chat llmWorker memory pressure (`?nochat=1` removes them — still dies).
- Shared renderer memory budget (per-peer browser CONTEXTS — still dies).
- System memory (32 GB free, commit 57/104 GB mid-run).
- Loader regression from streaming/unlink changes (**control**: harness
  `p2p.spec` in legion-stage-runtime passes TODAY with the same
  stage-runtime dist — and its parity page runs THREE wasm stage instances
  in ONE renderer, green).
- Browser channel (both configs: bundled `chromium`, headed, same flags).

## Strongest remaining hypotheses (in test order)

1. **Demo bundle defect** (production vite build of the worker chunk —
   minification/interop breaking something timing-dependent in the stream
   loop or FS layer). DECISIVE TEST: spawn TWO stage workers in ONE demo
   page (mirror the harness parity page inside the demo build). Dies → it's
   the bundle; bisect (disable minify, es2022→esnext, manualChunks for
   stage-runtime). Survives → environment, go to 2.
2. **Multi-page/context dimension** (3 pages + mesh running vs harness's 2).
   Test: revert per-peer contexts to ONE shared context (harness shape);
   also try 2 pages only (driver + one host, no spare page).
3. **Timing**: demo host loads ~60 s after page start (mesh join, caps,
   plan) vs harness host loading promptly. Test: idle the harness host page
   60 s before stage.load — if it then dies, something ages badly
   (device/GC state) in that window.

## Test 1 in progress (2026-07-15)

Built `apps/demo/debug-two-workers.html` + `src/debugTwoWorkersMain.ts`:
two `workers/stageWorker.ts` DedicatedWorkers, ONE page, constructed via
the exact same `new Worker(new URL(...), { type: 'module' })` call site
as `StagePipelinePanel.tsx`, run under the demo's own `vite build` +
`vite preview` (production bundle) — the variable NEVER exercised by any
legion-stage-runtime harness spec (harness/playwright.config.ts runs
`npx vite --port 4173`, the DEV server, for every single spec including
the "proven green" `p2p.spec` control and the 3-instance parity page).
This asymmetry (control = dev server, mainline = prod build) was not
previously called out as ruled out and is a real gap in the control.

Run 1 (`Promise.all` — both workers load CONCURRENTLY): worker1 threw an
explicit `TypeError: network error` almost immediately (right at the "0
MB" stream checkpoint, never reached 64 MB); worker2 streamed the full
610 MB and reached `ready` cleanly. **This is a different failure mode
than the mainline defect** — mainline dies silently at ~320 MB with NO
ErrorEvent; this died near-instantly WITH an explicit ErrorEvent. Real
bug (`vite preview`'s static file server can't reliably serve two
simultaneous 610 MB same-origin fetches) but not (by itself) proof of
the casefile's silent-death mechanism. Ruling out "just re-run the
mainline spec's exact shape concurrently" as the decisive test —
switched to SEQUENTIAL loads (worker1 fully completes, `await`s, THEN
worker2 starts) to match the real driver-then-remote order
(`useStagePipeline.start()` awaits the local stage-0 `.load()` to
completion before `runDriverStageSession` ever sends `stage.load` to a
remote — the two full.gguf fetches never overlap in the real app).

Run 2 + 3 (sequential, `?mode=sequential` default, 2 confirming runs):
BOTH workers reach `ready` cleanly every time — worker1 (610 MB) fully
loads, warms up, THEN worker2 (610 MB) fully loads, same page, same
renderer, same production bundle. No death, no error, no stall.

**Test 1 verdict: bundle/minification RULED OUT** as the cause (2/2
confirming runs). Two full 610 MB monolith loads through the exact
production-built `stageWorker.ts` chunk, sequential, one page, succeed
every time. The `Promise.all` concurrent-mode side-finding (worker
dying near-instantly with an explicit `network error`, see above) is a
REAL but SEPARATE bug in `vite preview`'s handling of simultaneous
same-origin large-file fetches — parked, not the mainline defect (mainline
dies silently ~320 MB in, with no ErrorEvent at all, and the real driver
+ remote loads are sequential, not concurrent, per
`useStagePipeline.start()`).

Moving to casefile test 2 (multi-page/context dimension) per the ranked
order — the multi-CONTEXT (3 separate renderer processes) shape is now
the prime remaining difference between the red mainline spec and every
green control (harness's p2p.spec: 2 pages, ONE shared context/renderer;
this test 1: 2 workers, ONE page).

## Test 2 (2026-07-15)

Added `setupPeerMesh` (helpers.ts, parameterized over `hostCount` and
`contextMode`) + `pipeline-split-context-variants.spec.ts` to flip one
variable at a time against the REAL demo pipeline (not a synthetic
stand-in).

**Test 2a — revert to ONE SHARED context, 3 peers (driver + hostA +
hostB), harness shape**: run 1 reproduces the IDENTICAL failure
signature — hostB (the chosen remote) streams cleanly to exactly 320 MB
(`[stage-runtime] stream .../full.gguf: 320 MB` is the last progress
line), then `worker CLOSED` with no ErrorEvent, no pageerror, no wasm
abort. Driver's load deadline (240s) fires afterward with "worker died
silently or stalled". **Context-sharing alone does NOT fix it** —
reverting to the harness's literal shape (one BrowserContext) still
dies at the same byte offset. Note: Playwright/Chromium doesn't
guarantee same-renderer-process for multiple `Page`s in one
`BrowserContext` (unlike test 1's single-page, two-worker shape, which
IS provably one renderer) — so this doesn't cleanly isolate "renderer
process count" the way test 1 did, but it does rule out
"BrowserContext-per-peer" as the fix people assumed it was.

Next: test 2b (2 pages, no spare, separate contexts) to isolate whether
the mere PRESENCE of a 3rd page/worker (hostB's idle spare sibling, or
here hostA as the non-selected host) contributes contention, independent
of context-sharing.

**Test 2b — 2 pages only (driver + host, NO spare), separate contexts
(mainline's context shape minus the 3rd page)**: run 1 reproduces the
IDENTICAL failure signature AGAIN — host streams cleanly to exactly
320 MB, then `worker CLOSED`, no ErrorEvent. Same byte offset as every
other run (test 2a, and all 14 prior mainline runs).

**Test 2 verdict: multi-page/context dimension RULED OUT.** Neither
context-sharing (2a) nor the 3rd spare page (2b) is necessary for the
death — the minimal-as-possible real-pipeline shape (2 pages, driver +
one host, separate contexts) still dies at the exact same 320 MB mark.
Combined with test 1 (2 workers, 1 page, succeeds every time), the
distinguishing factor is NOT page/context topology at all — it's
something about the REAL page (mesh join, WebRTC/Trystero connections to
3 public MQTT relay brokers, React app overhead, `useStageHost`'s
capability-detection/publish cycle) that debug-two-workers.html doesn't
have. The host in the real pipeline sits alive for tens of seconds
(mesh discovery, WebGPU limit detection, cap publish/heartbeat) BEFORE
`stage.load` ever arrives — debug-two-workers.html starts the load
immediately on page load. That points straight at casefile hypothesis 3
(timing/aging).

Moving to hypothesis 3, tested in the CLEANEST available environment:
legion-stage-runtime's own harness (p2p.spec's proven-green host/driver
pages, dev server, always-immediate load in every prior run) — age the
host page 60s (idle, no load) before the driver ever starts, isolating
whether elapsed wall-clock idle time alone (independent of the demo's
mesh/React overhead) reproduces the death.

## Test 3 (2026-07-15)

Added `legion-stage-runtime/harness/e2e/p2p-aged-host.spec.ts`: navigate
the harness's proven-green `p2p-host.html`, wait for `__hostReady`, THEN
idle 60s doing NOTHING (no adapter probe, no extra activity — the
harness host doesn't touch WebGPU at all before its own worker's
`stage.load`), THEN start the driver exactly as `p2p.spec` does.

Run 1: **PASSED.** Host streamed the full 610 MB clean past the 320 MB
mark with zero incident, `stage.ready`, full 32-token decode,
`passed=true`. Ran in 1.4 minutes total.

**Pure wall-clock idle time is RULED OUT** as sufficient on its own —
a genuinely idle host (nothing touching the GPU, no mesh capability
publishing, no React) survives being aged 60s with no problem at all.

This narrows things further: the demo's real host does exactly ONE
thing during its idle window that this harness host doesn't —
`useStageHost` calls `detectWebGpuLimits()`
(`packages/mesh-react/src/webgpuLimits.ts`) on mount, which does
`navigator.gpu.requestAdapter()` on the PAGE's main thread, well before
the worker ever requests its OWN adapter+device. (Chat/llmWorker was
already ruled out earlier via `?nochat=1`, which every helper here
already passes, so it's controlled for.) Next: hypothesis 4 (not one of
the original 3, but the natural next candidate from combining test
1+2+3 evidence) — does merely requesting a `GPUAdapter` from the main
thread, before a worker in the SAME renderer requests its own
adapter+device, corrupt or destabilize the worker's later WebGPU state?
Testing directly in the harness (add the exact `requestAdapter()` call
demo's host makes, nothing else, to the otherwise-untouched harness
host) to isolate this one variable cleanly.

## Environment notes

- Windows 11, RTX 2080 Ti, bundled Playwright chromium, headed, WebGPU via
  Vulkan flags (see playwright.config.ts).
- `enterprise.data_protection: URL to scan` lines appear in stderr —
  believed inert (no enterprise policy actually blocks; both browsers show
  chromium bundle) but unconfirmed.
- Worker consoles pipe through page logging (helpers.ts); stage-runtime
  logs `[stage-runtime]` phases incl. 64 MB stream ticks; wasm print/printErr
  and onAbort are wired in wasm-loader.ts.
