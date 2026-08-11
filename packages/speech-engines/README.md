# @unstable-legion/speech

Browser speech as a mesh capability — ASR (PoC) + TTS (Phase 2a).

**ASR**: proves **microphone → Whisper ASR in a Web Worker →
transcript**, exposed as a mesh tool-call job so a peer advertising
`asr.transcribe` (`@unstable-legion/core`'s `speech.ts`) can transcribe
audio for other peers over the existing `tc` tool-RPC bus.

**TTS**: proves **text → Kokoro TTS in a SEPARATE Web Worker → audio
clip**, exposed the same way so a peer advertising `tts.synthesize` can
synthesize speech for other peers. Independent lifecycle from ASR — a
peer may host either, both, or neither.

## Pieces

### ASR

- `types.ts` — the `SpeechEngine` interface every ASR backend implements.
  One method: decoded mono PCM in, `AsrTranscribeContent` out. Keeping
  the engine behind this interface is what lets a Parakeet.js-derived
  backend slot in later without touching the worker host or the mesh
  tool.
- `whisperEngine.ts` — the only ASR engine implemented so far:
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

### TTS

- `types.ts` — the `TtsEngine` interface every TTS backend implements.
  Symmetric twin of `SpeechEngine`: text in, raw PCM out.
- `kokoroEngine.ts` — the only TTS engine implemented so far:
  [`kokoro-js`](https://github.com/hexgrad/kokoro) (Kokoro-82M, StyleTTS2)
  running `onnx-community/Kokoro-82M-v1.0-ONNX`. Tries `device: 'webgpu'`
  first, falls back to `wasm`. See the file's doc comment for the
  API-verification trail, the per-device `dtype` split, and the
  hardcoded-to-HF voice-vector caveat.
- `wavEncode.ts` — `encodeWav`: pure 16-bit PCM mono WAV encoder (no
  engine, no browser API — unit-tested under plain `node --test`).
- `ttsWorker.ts` — a SEPARATE Web Worker entry (independent lifecycle
  from `worker.ts`) that owns one lazily-created `TtsEngine` and answers
  `{type:'synthesize', id, text, voice, speed}` messages, WAV-encoding
  the result before base64-ing it onto the response.
- `ttsWorkerClient.ts` — `TtsWorkerClient`: same reqId-keyed
  request/response wrapper idiom as `SpeechWorkerClient`, for the TTS
  worker.
- `ttsTool.ts` — `createTtsSynthesizeTool(client)`: builds the mesh
  `ToolRegistration` for the `synthesize` tool from a minimal
  `{synthesize(args)}` client — real (`TtsWorkerClient`) or fake (unit
  tests).

## Why Whisper via transformers.js, not Parakeet

`@huggingface/transformers` ^3.8.1 (bundling `onnxruntime-web` 1.22) was
already a transitive dependency in the monorepo's lockfile (via
`@codecai/web-safety`) before this PoC — reusing it means no second
onnxruntime-web copy ships in the bundle. Parakeet.js is a credible
follow-up (streaming/low-latency ASR) but it'd pull its own wasm runtime.
Out of scope for this pass; the `SpeechEngine` interface is the seam
where it would attach.

## Why Kokoro via kokoro-js, not Piper

Kokoro-82M grades materially better than Piper on sustained listening (A/
A- vs Piper's C+ per `kokoro-js`'s own voice-quality table) at a
comparable ~82M-parameter size, and — same reasoning as the ASR
engine — `kokoro-js` depends on `@huggingface/transformers ^3.5.1`,
satisfied by the `^3.8.1` already pinned for Whisper, so npm dedupes both
to ONE `@huggingface/transformers` (and therefore one onnxruntime-web)
copy rather than shipping a second ORT runtime. `kokoro-js` additionally
pulls in `phonemizer` (an eSpeak-NG-derived grapheme-to-phoneme
converter Kokoro needs as an input stage) — a self-contained ~1.3MB
minified bundle with no external asset fetches of its own. `piper-tts-web`
remains a credible fallback if `kokoro-js` turns out unusable in practice;
not needed for this pass. The `TtsEngine` interface is the seam where it
would attach.

## Wire framing: base64-over-`tc` (phase 1), Codec `LatentFrame` (phase 2)

Audio rides as a base64 string inside the ordinary JSON `tc`
tool-call/result frames, both directions — mic clip in
(`AsrTranscribeArgs.audioBase64`) and synthesized clip out
(`TtsSynthesizeContent.audioBase64`) — simple, and it reuses the exact
tool-RPC bus every other mesh tool already speaks. The cost is ~33%
base64 overhead and no streaming (a whole clip travels in one JSON
message, so long clips will bump into WebRTC's per-message MTU
eventually). The phase-2 upgrade is to carry raw PCM/opus bytes as a
binary Codec `LatentFrame` over the mesh's existing binary frame path
(`@unstable-legion/core`'s `wire.ts` / `webrtc-codec.ts`) the same way
token and activation frames already ride the wire — not implemented
here; this phase intentionally keeps the transport dumb so the ASR/TTS
engines and the tool-call plumbing get proven first.

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
takes (`@codecai/web-llm` on WebGPU, no isolation), so ASR/TTS add **no
new header requirement** and **no risk to the mesh or to existing model
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

### TTS package sizes (measured from the npm package, NOT a real `vite build`)

`apps/chat`'s production `vite build` could not be completed in the
environment this was built in — blocked by a pre-existing, unrelated
issue in a separate shared repo (`@codecai/web-llm` resolving to an
empty directory; see the top-level PR/commit notes for detail) — so
unlike the ASR numbers above, these are read directly off the installed
`kokoro-js@1.2.1`/`phonemizer@1.2.1` packages, not a real bundler output.
Treat as an estimate of what a successful build would code-split, to be
replaced with real `vite build` numbers once the environment blocker
above is cleared:

- `kokoro-js`'s actual ESM entry point (what `exports.default` resolves
  to, and therefore what Vite bundles — NOT the `dist/kokoro.web.js`
  all-in-one UMD file the package only publishes for `<script>`-tag/CDN
  consumption via its `jsdelivr`/`unpkg` fields) is `dist/kokoro.js`, a
  thin **~11 KB** wrapper around `@huggingface/transformers` (already
  paid for by the ASR path — see the dedupe note above) and `phonemizer`.
- `phonemizer@1.2.1` (`dist/phonemizer.js`) — a self-contained
  **~1.3 MB** minified bundle (eSpeak-NG-derived grapheme-to-phoneme
  conversion Kokoro needs as an input stage), no external asset fetches
  of its own. This is the main new JS weight TTS adds beyond what ASR
  already pulls in.
- Per-voice style-vector `.bin` files (`af_heart.bin` measured at
  **~510 KB**) are fetched lazily per distinct `voice` a synthesize call
  uses (default: just `af_heart`), not bundled — see the sourcing-policy
  caveat below for why they can't use the Legion CDN fallback.
- `ttsWorker-*.js` (this package's own `ttsWorker.ts`, mirroring
  `speechWorker-*.js`'s ~2 KB) — trivial; same "bulk lives in the lazily
  imported deps" shape as the ASR worker.

On top of the JS bundle, `onnx-community/Kokoro-82M-v1.0-ONNX`'s ONNX
weights (dtype depends on device — `fp32` on webgpu, `q8` on wasm; see
`kokoroEngine.ts`'s doc comment) are fetched on first use and cached by
the browser's Cache Storage, same as Whisper's.

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

### TTS sourcing: PARTIAL host override only (kokoro-js limitation)

`createKokoroEngine` sets the SAME `env.remoteHost`/`env.allowRemoteModels`
`createWhisperEngine` does — `kokoro-js`'s `KokoroTTS.from_pretrained`
loads the ONNX model + tokenizer through `@huggingface/transformers`'s
own `from_pretrained`, which obeys that global `env`, so `modelSources`/
`wasmPaths` work identically to the ASR engine for those two fetches.
**Verified by reading `kokoro-js`'s own bundled source, not assumed.**

What does NOT obey it: `kokoro-js` fetches each voice's style-vector
`.bin` file (one per distinct `voice` a synthesize call uses) via a
**hardcoded** `fetch("https://huggingface.co/onnx-community/
Kokoro-82M-v1.0-ONNX/resolve/main/voices/<voice>.bin")` baked into the
library itself, cached under a fixed `"kokoro-voices"` Cache Storage
name — it ignores `env.remoteHost` entirely, even if the model itself
loaded from the Legion CDN fallback. There is currently no supported way
to redirect this from the outside; a real fix would mean patching or
forking `kokoro-js`. Flagged here rather than silently treated as
"handled" — see `kokoroEngine.ts`'s doc comment for the same note next to
the code.

## Manual browser verification

See `MANUAL-TEST.md` — automated tests here only cover the pure
`asrTool.ts`/`ttsTool.ts` descriptor/validate logic and `wavEncode.ts`
(node `--test`); the engines, workers, mic capture, and audio playback
are browser-only surfaces this package can't exercise headlessly.
