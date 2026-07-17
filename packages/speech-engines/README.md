# @unstable-legion/speech

Browser speech-to-text as a mesh capability — a PoC. Proves
**microphone → Whisper ASR in a Web Worker → transcript**, exposed as a
mesh tool-call job so a peer advertising `asr.transcribe`
(`@unstable-legion/core`'s `speech.ts`) can transcribe audio for other
peers over the existing `tc` tool-RPC bus.

## Pieces

- `types.ts` — the `SpeechEngine` interface every ASR backend implements.
  One method: decoded mono PCM in, `AsrTranscribeContent` out. Keeping
  the engine behind this interface is what lets a Parakeet.js or
  Piper-derived backend slot in later without touching the worker host
  or the mesh tool.
- `whisperEngine.ts` — the only engine implemented so far:
  [transformers.js](https://github.com/huggingface/transformers.js)
  (`@huggingface/transformers` 3.8.1) running `Xenova/whisper-base`.
  Tries `device: 'webgpu'` first, falls back to `wasm`. See the file's
  doc comment for why that model id and no forced `dtype`.
- `audioDecode.ts` — `decodeToPcm`: WebAudio `decodeAudioData` +
  `OfflineAudioContext` resample to 16 kHz mono (what Whisper expects
  when fed raw PCM instead of a URL). Browser-only.
- `worker.ts` — a Web Worker entry that owns one lazily-created
  `SpeechEngine` and answers `{type:'transcribe', id, audioBase64,
  mimeType, language}` messages.
- `workerClient.ts` — `SpeechWorkerClient`: spawns/talks to that worker
  with reqId-keyed request/response correlation (same idiom as
  `@unstable-legion/react`'s `StageWorkerClient`).
- `asrTool.ts` — `createAsrTranscribeTool(client)`: builds the mesh
  `ToolRegistration` for the `transcribe` tool from a minimal
  `{transcribe(args)}` client — real (`SpeechWorkerClient`) or fake (unit
  tests).

## Why Whisper via transformers.js, not Parakeet/Piper

`@huggingface/transformers` ^3.8.1 (bundling `onnxruntime-web` 1.22) was
already a transitive dependency in the monorepo's lockfile (via
`@codecai/web-safety`) before this PoC — reusing it means no second
onnxruntime-web copy ships in the bundle. Parakeet.js and Piper are
credible follow-ups (Parakeet for streaming/low-latency ASR, Piper for
TTS — see `TTS_SKILL`/`TTS_TOOL_NAME` reserved in `speech.ts`), but they'd
each pull their own wasm runtime. Out of scope for this PoC; the
`SpeechEngine` interface is the seam where they'd attach.

## Wire framing: base64-over-`tc` (phase 1), Codec `LatentFrame` (phase 2)

This PoC ships audio as a base64 string inside the ordinary JSON `tc`
tool-call/result frames (`AsrTranscribeArgs.audioBase64`) — simple, and
it reuses the exact tool-RPC bus every other mesh tool already speaks.
The cost is ~33% base64 overhead and no streaming (a whole clip travels
in one JSON message, so long clips will bump into WebRTC's per-message
MTU eventually). The phase-2 upgrade is to carry raw PCM/opus bytes as a
binary Codec `LatentFrame` over the mesh's existing binary frame path
(`@unstable-legion/core`'s `wire.ts` / `webrtc-codec.ts`) the same way
token and activation frames already ride the wire — not implemented
here; this PoC intentionally keeps the transport dumb so the ASR engine
and the tool-call plumbing get proven first.

## Cross-origin isolation (not required)

No COOP/COEP headers are needed to run this. The primary path is WebGPU,
which needs no isolation at all. The WASM fallback (`onnxruntime-web`)
*can* use SIMD + threads for more throughput — the threaded build wants
`SharedArrayBuffer`, which needs a cross-origin-isolated page
(`Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: require-corp`) — but onnxruntime-web
detects a non-isolated page and **runs single-threaded automatically**,
just slower. It does not error.

This is deliberately the same posture the existing LLM path already
takes (`@codecai/web-llm` on WebGPU, no isolation), so ASR adds **no new
header requirement** and **no risk to the mesh or to existing model
loading**. Note the trap it avoids: enabling COEP `require-corp`
app-wide would force *every* cross-origin subresource — including the
existing LLM model-weight fetches — to be CORP/CORS-clean or be blocked,
which is a real regression surface for a feature the mesh already
depends on. (COOP/COEP do **not** affect WebRTC data channels, the
WSS/MQTT signaling, or STUN/TURN — those aren't COEP-governed
subresources, so the peer mesh is unaffected either way.)

Turning threads on is a possible future optimization, tracked as a
separate cross-origin-hosting follow-up (see `CROSS-ORIGIN-FOLLOWUP.md`
on its branch) — not something this PoC takes on.

## Model download size / bundle size (measured)

A real `vite build` of `apps/demo` with the ASR host wired in produced:

- `transformers.web-*.js` — **~869 KB** minified, code-split so it only
  loads when the ASR host toggle is switched on (not in the main bundle).
- `ort-wasm-simd-threaded.jsep-*.wasm` (onnxruntime-web's threaded SIMD
  wasm backend) — **~21.6 MB**, bundled as a static asset regardless of
  whether ASR is ever enabled. This is the number to fix before this
  leaves PoC status — either lazy-fetch it only on first ASR-host-enable
  (it's already a separate asset, so this may just need
  `build.rollupOptions` tuning) or accept it as a one-time cached cost.
- `speechWorker-*.js` — ~2 KB (this package's `worker.ts`, trivial; the
  bulk is transformers.js + onnxruntime-web pulled in lazily from inside it).

On top of the JS/wasm bundle, `Xenova/whisper-base`'s ONNX encoder+decoder
weights (fp32/q8, whichever the device default picks) are on the order of
tens of MB more, fetched on first use and cached by the browser's Cache
Storage (transformers.js's default caching).

### Sourcing policy: public mirror primary, Legion CDN fallback

Nothing above is fetched until a peer toggles ASR **hosting** on — the
worker (and thus transformers.js + onnxruntime-web) is constructed lazily
(`useSpeechHost`). Plain visitors and client-only peers download none of
it. So the only open question is *where* the on-enable fetch comes from.
`createWhisperEngine` follows the same policy as the LLM model layers —
prefer the public mirror, keep a self-hosted fallback:

- **Model weights** → `modelSources` defaults to
  `[HF_MODEL_HOST, LEGION_MODEL_FALLBACK_HOST]`: **Hugging Face Hub
  primary** (the ONNX repo already lives there — no infra of ours to
  keep warm), **`cdn.codecai.net` fallback** for offline / HF-down. There
  is no native failover in transformers.js, so the engine sets
  `env.remoteHost` per attempt and retries the next source.
- **onnxruntime-web wasm** → `wasmPaths` defaults to transformers.js' own
  public CDN; set it to the Legion CDN to self-host the runtime. (Not on
  HF — the runtime isn't a model — so its "public mirror" is the npm CDN.)

Populate the fallback with `scripts/mirror-whisper-to-cdn.sh` (mirrors the
HF repo layout + the ort wasm to the CDN host — a deploy-time step that
writes to `.198`, not automation). This removes the hard dependency on
`huggingface.co` being reachable from every mesh peer's browser while
keeping our CDN's bandwidth for the fallback path only. The ~21.6 MB local
`ort-wasm` bundle can then be dropped from `dist` in favor of the
`wasmPaths` fetch once the CDN is populated — tracked in the separate
cross-origin-hosting follow-up (`CROSS-ORIGIN-FOLLOWUP.md`), which also
covers the CORP/CORS headers those cross-origin assets need. No
cross-origin isolation is required for this (single-threaded fallback);
threads stay an optional future optimization.

## Manual browser verification

See `MANUAL-TEST.md` — automated tests here only cover the pure
`asrTool.ts` descriptor/validate logic (`test/asrTool.test.ts`, node
`--test`); the engine, worker, and mic capture are browser-only surfaces
this package can't exercise headlessly.
