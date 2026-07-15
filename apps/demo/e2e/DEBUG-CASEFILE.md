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

## Environment notes

- Windows 11, RTX 2080 Ti, bundled Playwright chromium, headed, WebGPU via
  Vulkan flags (see playwright.config.ts).
- `enterprise.data_protection: URL to scan` lines appear in stderr —
  believed inert (no enterprise policy actually blocks; both browsers show
  chromium bundle) but unconfirmed.
- Worker consoles pipe through page logging (helpers.ts); stage-runtime
  logs `[stage-runtime]` phases incl. 64 MB stream ticks; wasm print/printErr
  and onAbort are wired in wasm-loader.ts.
