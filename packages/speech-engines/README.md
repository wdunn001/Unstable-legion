# @unstable-legion/speech

Browser speech-to-text AND text-to-speech as mesh capabilities: a PoC.
Proves **microphone → Whisper ASR in a Web Worker → transcript**, exposed
as a mesh tool-call job so a peer advertising `asr.transcribe`
(`@unstable-legion/core`'s `speech.ts`) can transcribe audio for other
peers over the existing `tc` tool-RPC bus. Its reverse-direction
twin, **text → Kokoro TTS in a Web Worker → audio clip**, is exposed the
same way as `tts.synthesize`.

## Pieces

ASR:

- `types.ts`: the `SpeechEngine` interface every ASR backend implements.
  One method: decoded mono PCM in, `AsrTranscribeContent` out. Keeping
  the engine behind this interface is what lets a Parakeet.js-derived
  backend slot in later without touching the worker host or the mesh
  tool.
- `whisperEngine.ts`: the only ASR engine implemented so far:
  [transformers.js](https://github.com/huggingface/transformers.js)
  (`@huggingface/transformers` 3.8.1) running `Xenova/whisper-base`.
  Tries `device: 'webgpu'` first, falls back to `wasm`. See the file's
  doc comment for why that model id and no forced `dtype`.
- `audioDecode.ts`: `decodeToPcm`: WebAudio `decodeAudioData` +
  `OfflineAudioContext` resample to 16 kHz mono (what Whisper expects
  when fed raw PCM). Browser-only.
- `worker.ts`: a Web Worker entry that owns one lazily-created
  `SpeechEngine` and answers `{type:'transcribe', id, audioBase64,
  mimeType, language}` messages.
- `workerClient.ts`: `SpeechWorkerClient`: spawns/talks to that worker
  with reqId-keyed request/response correlation (same idiom as
  `@unstable-legion/react`'s `StageWorkerClient`).
- `asrTool.ts`: `createAsrTranscribeTool(client)`: builds the mesh
  `ToolRegistration` for the `transcribe` tool from a minimal
  `{transcribe(args)}` client: real (`SpeechWorkerClient`) or fake (unit
  tests).

TTS is the reverse-direction twin, same shapes, same idioms:

- `types.ts`: the `TtsEngine` interface every TTS backend implements.
  One method: text in, raw Float32 PCM + sample rate + voice out. Same
  seam-not-lock-in reasoning as `SpeechEngine`.
- `kokoroEngine.ts`: the only TTS engine implemented so far:
  [kokoro-js](https://github.com/hexgrad/kokoro) (which itself runs on
  `@huggingface/transformers`) running `onnx-community/Kokoro-82M-v1.0-ONNX`.
  Tries `device: 'webgpu'` (`dtype: 'fp32'`) first, falls back to `wasm`
  (`dtype: 'q8'`). That is kokoro-js's own recommended pairing per device.
- `wavEncode.ts`: `encodeWavBase64`: minimal 16-bit PCM WAV container
  builder, main-thread (no WebAudio API needed for this one, but it's
  the main-thread counterpart to `audioDecode.ts` in the pipeline).
- `ttsWorker.ts`: a Web Worker entry that owns one lazily-created
  `TtsEngine` and answers `{type:'synthesize', id, text, voice,
  language}` / `{type:'listVoices', id}` messages.
- `ttsWorkerClient.ts`: `TtsWorkerClient`: spawns/talks to that worker
  (same reqId-keyed idiom as `SpeechWorkerClient`), then WAV-encodes the
  raw PCM it gets back on the main thread.
- `ttsTool.ts`: `createTtsSynthesizeTool(client)`: builds the mesh
  `ToolRegistration` for the `synthesize` tool from a minimal
  `{synthesize(args)}` client: real (`TtsWorkerClient`) or fake (unit
  tests).

## Why Whisper/Kokoro via transformers.js over Parakeet/Piper

`@huggingface/transformers` ^3.8.1 (bundling `onnxruntime-web` 1.22) was
already a transitive dependency in the monorepo's lockfile (via
`@codecai/web-safety`) before the ASR PoC. Reusing it means no second
onnxruntime-web copy ships in the bundle for ASR. kokoro-js depends on
`@huggingface/transformers` ^3.5.1, satisfied by the same ^3.8.1 already
in the lockfile. TTS reuses it too. Only one onnxruntime-web
copy ships across both capabilities. Parakeet.js (streaming/low-latency ASR)
and Piper (a smaller, non-transformers.js TTS engine) are credible
follow-ups, but they'd each pull their own wasm runtime. Out of scope for
this PoC; the `SpeechEngine`/`TtsEngine` interfaces are the seam where
they'd attach.

## Wire framing: base64-over-`tc` (phase 1), Codec `LatentFrame` (phase 2)

This PoC ships audio as a base64 string inside the ordinary JSON `tc`
tool-call/result frames: `AsrTranscribeArgs.audioBase64` for ASR's input
clip, `TtsSynthesizeContent.audioBase64` (a WAV container) for TTS's
output clip. That's simple, and it reuses the exact tool-RPC bus every other
mesh tool already speaks. The cost is ~33% base64 overhead and no
streaming (a whole clip travels in one JSON message. Long clips will
bump into WebRTC's per-message MTU eventually). The phase-2 upgrade is to
carry raw PCM/opus bytes as a binary Codec `LatentFrame` over the mesh's
existing binary frame path (`@unstable-legion/core`'s `wire.ts` /
`webrtc-codec.ts`) the same way token and activation frames already ride
the wire. That is not implemented here; this PoC intentionally keeps the
transport dumb so the ASR/TTS engines and the tool-call plumbing get
proven first.

## Cross-origin isolation (not required)

No COOP/COEP headers are needed to run this. The primary path is WebGPU.
That needs no isolation at all. The WASM fallback (`onnxruntime-web`)
*can* use SIMD + threads for more throughput. The threaded build wants
`SharedArrayBuffer`. That needs a cross-origin-isolated page
(`Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: require-corp`). onnxruntime-web
detects a non-isolated page and **runs single-threaded automatically**,
just slower. It does not error.

This is deliberately the same posture the existing LLM path already
takes (`@codecai/web-llm` on WebGPU, no isolation). ASR therefore adds **no new
header requirement** and **no risk to the mesh or to existing model
loading**. Note the trap it avoids: enabling COEP `require-corp`
app-wide would force *every* cross-origin subresource, including the
existing LLM model-weight fetches, to be CORP/CORS-clean or be blocked.
That is a real regression surface for a feature the mesh already
depends on. (COOP/COEP do **not** affect WebRTC data channels, the
WSS/MQTT signaling, or STUN/TURN. Those aren't COEP-governed
subresources. The peer mesh is unaffected either way.)

Turning threads on is a possible future optimization, tracked as a
separate cross-origin-hosting follow-up (see `CROSS-ORIGIN-FOLLOWUP.md`
on its branch). This PoC does not take that on.

## Model download size / bundle size (measured)

A real `vite build` of `apps/demo` with the ASR host wired in produced:

- `transformers.web-*.js`: **~869 KB** minified, code-split so it only
  loads when the ASR host toggle is switched on (not in the main bundle).
- `ort-wasm-simd-threaded.jsep-*.wasm` (onnxruntime-web's threaded SIMD
  wasm backend): **~21.6 MB**, bundled as a static asset regardless of
  whether ASR is ever enabled. This is the number to fix before this
  leaves PoC status: either lazy-fetch it only on first ASR-host-enable
  (it's already a separate asset. This may just need
  `build.rollupOptions` tuning) or accept it as a one-time cached cost.
- `speechWorker-*.js`: ~2 KB (this package's `worker.ts`, trivial; the
  bulk is transformers.js + onnxruntime-web pulled in lazily from inside it).

On top of the JS/wasm bundle, `Xenova/whisper-base`'s ONNX encoder+decoder
weights (fp32/q8, whichever the device default picks) are on the order of
tens of MB more, fetched on first use and cached by the browser's Cache
Storage (transformers.js's default caching).

The same `apps/chat` production build with the TTS host wired in
additionally produced:

- `kokoro-*.js`: **~1.33 MB** minified (kokoro-js + its `phonemizer`
  dependency), code-split so it only loads when the TTS host toggle is
  switched on. That's a separate chunk from ASR's `transformers.web-*.js`.
  Enabling only one capability never downloads the other's JS.
- A second `transformers.web-*.js` chunk (**~869 KB**, same size as
  ASR's): Vite splits kokoro-js's own `@huggingface/transformers` import
  into its own chunk, kept separate from Whisper's; the underlying
  `onnxruntime-web` wasm binary is still the same single
  `ort-wasm-simd-threaded.jsep-*.wasm` asset either capability loads (no
  second 21.6 MB copy).
- `ttsWorker-*.js`: ~3 KB (this package's `ttsWorker.ts`, trivial; same
  shape as `speechWorker-*.js`).

Kokoro's ONNX weights are a separate download from Whisper's, same
lazy-on-enable / Cache-Storage-cached policy. Enabling both ASR and TTS
hosting in the same tab downloads both models, but neither downloads
until its own toggle is switched on.

### Sourcing policy: public mirror primary, Legion CDN fallback

Nothing above is fetched until a peer toggles ASR **hosting** on. The
worker (and thus transformers.js + onnxruntime-web) is constructed lazily
(`useSpeechHost`). Plain visitors and client-only peers download none of
it. So the only open question is *where* the on-enable fetch comes from.
`createWhisperEngine` follows the same policy as the LLM model layers:
prefer the public mirror, keep a self-hosted fallback:

- **Model weights** → `modelSources` defaults to
  `[HF_MODEL_HOST, LEGION_MODEL_FALLBACK_HOST]`: **Hugging Face Hub
  primary** (the ONNX repo already lives there; no infra of ours to
  keep warm), **`cdn.codecai.net` fallback** for offline / HF-down. There
  is no native failover in transformers.js. The engine therefore sets
  `env.remoteHost` per attempt and retries the next source.
- **onnxruntime-web wasm** → `wasmPaths` defaults to transformers.js' own
  public CDN; set it to the Legion CDN to self-host the runtime. (The
  runtime isn't on HF: it isn't a model. Its "public mirror" is
  therefore the npm CDN.)

Populate the fallback with `scripts/mirror-whisper-to-cdn.sh` (mirrors the
HF repo layout + the ort wasm to the CDN host: a deploy-time step that
writes to `.198`, done by hand). This removes the hard dependency on
`huggingface.co` being reachable from every mesh peer's browser while
keeping our CDN's bandwidth for the fallback path only. The ~21.6 MB local
`ort-wasm` bundle can then be dropped from `dist` in favor of the
`wasmPaths` fetch once the CDN is populated. That is tracked in the
separate cross-origin-hosting follow-up (`CROSS-ORIGIN-FOLLOWUP.md`). That
follow-up also covers the CORP/CORS headers those cross-origin assets need. No
cross-origin isolation is required for this (single-threaded fallback);
threads stay an optional future optimization.

`kokoroEngine.ts` follows the identical policy (`modelSources` defaults
to the same `[HF_MODEL_HOST, LEGION_MODEL_FALLBACK_HOST]` pair, re-
exported as `TTS_HF_MODEL_HOST`/`TTS_LEGION_MODEL_FALLBACK_HOST` from this
package's `index.ts` to avoid a name collision with ASR's own constants).
A future `scripts/mirror-kokoro-to-cdn.sh` would populate the fallback
mirror the same way `mirror-whisper-to-cdn.sh` does. It is not written yet.

## Manual browser verification

See `MANUAL-TEST.md`: automated tests here only cover the pure
`asrTool.ts`/`ttsTool.ts` descriptor/validate logic (`test/asrTool.test.ts`,
`test/ttsTool.test.ts`, node `--test`); the engines, workers, mic
capture, and audio playback are browser-only surfaces this package can't
exercise headlessly.
