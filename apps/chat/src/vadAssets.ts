/**
 * Shared `@ricky0123/vad-web` asset locations for every `useVadListen`
 * instance in this app — split by what each loader needs (see
 * `useVadListen.ts`'s module doc for the full worklet/model/wasm
 * asset-hosting story):
 *
 *   - baseAssetPath (worklet + Silero model): SAME-ORIGIN `/vad/`, staged
 *     by the `copyVadAssets` plugin in `vite.config.ts`. The worklet loads
 *     via `AudioWorklet.addModule()` which demands a JS MIME type — HF
 *     serves .js as text/plain (rejected by Chrome for worklets) — so it
 *     must be local; vad-web couples the model to the same dir, so the
 *     ~1.8MB model rides along.
 *   - onnxWASMBasePath (the ~40MB onnxruntime-web wasm, the real deploy
 *     bloat): served from Hugging Face (wdunn001/legion-vad). wasm loads
 *     via fetch()+instantiate (MIME-tolerant) and HF is CORS-clean, so
 *     cross-origin is fine here.
 *
 * ONE constant, shared by Composer.tsx's manual "🎙 Listen" toggle (3a) and
 * ChatPane.tsx's conversation-mode VAD instance (3c) — both are separate
 * `useVadListen` calls (separate mic ownership, see Composer's
 * `conversationMode` coordination doc), but they resolve the SAME asset
 * locations, so this constant is the one place that changes if the hosting
 * story ever does.
 */
const VAD_HF_BASE = 'https://huggingface.co/wdunn001/legion-vad/resolve/main/';

export const VAD_ASSETS = { baseAssetPath: '/vad/', onnxWASMBasePath: VAD_HF_BASE };
