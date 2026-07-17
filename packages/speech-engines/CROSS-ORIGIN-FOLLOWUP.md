# Cross-origin hosting & threading — follow-up

Tracks the hosting/threading work deliberately deferred out of the ASR PoC
(PR #7). Nothing here blocks the PoC: it ships working ASR (WebGPU +
single-threaded wasm fallback), HF-primary / `cdn.codecai.net`-fallback
weight sourcing, and **no cross-origin isolation**.

## Decision locked (do NOT regress)

**Default stays WebGPU + single-threaded wasm fallback, with no app-wide
COOP/COEP.** Enabling `Cross-Origin-Embedder-Policy: require-corp`
site-wide forces *every* cross-origin subresource — including the existing
`@codecai/web-llm` model-weight fetches — to be CORP/CORS-clean or be
**blocked**, which would regress a feature the mesh already depends on. The
throughput win (multi-threaded wasm) isn't worth that blast radius for a
capability most ASR-hosting peers will run on WebGPU anyway.

For the record: COOP/COEP do **not** affect WebRTC data channels, the
MQTT-over-WSS signaling, or STUN/TURN — those aren't COEP-governed
subresources, so the peer mesh is unaffected regardless of this decision.

## Tasks

1. **Populate the CDN fallback.** Run
   `packages/speech-engines/scripts/mirror-whisper-to-cdn.sh` to mirror the
   Whisper repo (HF layout) + the onnxruntime-web wasm to
   `cdn.codecai.net`. Deploy-ops step against `.198`; not automation.
   *Acceptance:* ASR hosting still works with `huggingface.co` blocked in
   the browser (fallback source exercised).

2. **CORP/CORS headers on the CDN.** Ensure the mirrored whisper + ort
   assets are served with `Cross-Origin-Resource-Policy: cross-origin`
   (and/or permissive CORS `Access-Control-Allow-Origin`). Harmless to set
   now; strictly required only if isolation is ever turned on. Confirm HF
   Hub model files stay CORS-clean (they are today).

3. **Drop the ~21.6 MB same-origin `ort-wasm` from `dist`.** Point
   `createWhisperEngine({ wasmPaths })` at the public npm CDN (primary) or
   the self-hosted mirror, and configure `apps/demo`'s Vite build to stop
   emitting the bundled copy. *Acceptance:* the wasm no longer ships in the
   app's main deploy and still loads at runtime on first ASR-host-enable.

4. **(Optional) Multi-threaded wasm.** Only if CPU-fallback throughput
   becomes a real bottleneck. Requires enabling COOP/COEP — SCOPE it:
   audit *every* cross-origin fetch the page makes (all web-llm model
   hosts, fonts, images, any analytics) for CORP/CORS first, or COEP will
   break them; consider `COEP: credentialless` to soften breakage.
   *Acceptance (hard gate):* existing LLM model loading verified working
   end-to-end **and** a 2-tab mesh connect still succeeds, before/after.

## Non-goals

- App-wide cross-origin isolation by default.
- Any change to the mesh transport, signaling, or TURN config.

## Verification checklist

- [ ] ASR hosting works with HF unreachable (CDN fallback path).
- [ ] No 21.6 MB wasm in `apps/demo`'s production build output.
- [ ] Existing `@codecai/web-llm` model loading unaffected.
- [ ] 2-tab mesh connect + a remote `asr.transcribe` call still succeed.
