import { existsSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * copyVadAssets — self-hosts `@ricky0123/vad-web`'s worklet bundle,
 * Silero ONNX model, and onnxruntime-web wasm binaries into
 * `public/vad/`, the same "don't depend on a CDN we don't control"
 * policy as the Whisper/Kokoro model-source lists (`whisperEngine.ts`'s
 * `wasmPaths`, `kokoroEngine.ts`'s HF-vs-Legion-CDN fallback).
 *
 * Why a copy instead of `?url` imports (the first thing tried): vad-web's
 * `MicVAD.new({ baseAssetPath, onnxWASMBasePath })` does NOT take a
 * per-file URL — it concatenates a shared directory prefix with FIXED
 * filenames internally (`baseAssetPath + 'vad.worklet.bundle.min.js'`,
 * `baseAssetPath + 'silero_vad_legacy.onnx'`; `onnxWASMBasePath +
 * '<detected-ort-wasm-variant>.wasm'`). A bundler-hashed `?url` import
 * gives each asset its own unique filename, which this concatenation
 * scheme can't consume. So the files are copied VERBATIM (unhashed,
 * original names) into a fixed `public/vad/` directory instead — plain
 * static files Vite serves as-is in both `vite` (dev) and `vite build`,
 * no bundler resolution involved.
 *
 * Runs synchronously at config-eval time (once per `vite`/`vite build`/
 * `vite preview` invocation) rather than as a `buildStart` hook, so the
 * dev server's initial page load already has `/vad/*` available — no
 * separate "fetch assets first" step for a human dev to forget (unlike
 * `apps/chat/public/wasm/`'s `scripts/fetch-stage-assets.sh`, which
 * pulls multi-hundred-MB weights from a SIBLING REPO and can't
 * reasonably run implicitly; these are a few tens of MB already sitting
 * in `node_modules` right after `npm install`, so an implicit copy here
 * is safe and removes a manual step instead of adding one).
 *
 * `onnxruntime-web` wasm binaries come from vad-web's own NESTED
 * `node_modules/@ricky0123/vad-web/node_modules/onnxruntime-web` copy
 * (pinned to 1.14.0), not the newer top-level onnxruntime-web
 * `@huggingface/transformers`/Whisper uses — vad-web's bundle resolves
 * `require("onnxruntime-web")` to its own nested copy (version conflict
 * with the newer one keeps it un-hoisted), so ONLY that copy's wasm
 * filenames match what vad-web's `ort` instance will actually request.
 */
function copyVadAssets(): Plugin {
  return {
    name: 'legion-copy-vad-assets',
    config() {
      try {
        const vadPkgPath = require.resolve('@ricky0123/vad-web/package.json');
        const vadDist = join(dirname(vadPkgPath), 'dist');

        const destDir = join(__dirname, 'public', 'vad');
        mkdirSync(destDir, { recursive: true });

        // ONLY the worklet + the default ("legacy") Silero model are staged
        // locally. Two reasons they can't come from HF like the wasm does:
        //   1. `vad.worklet.bundle.min.js` is loaded via `AudioWorklet.
        //      addModule()`, which requires a JavaScript MIME type — HF serves
        //      .js as `text/plain`, which Chrome rejects for worklets. So the
        //      worklet MUST be same-origin (Vite serves it as text/javascript).
        //   2. vad-web couples worklet + model under one `baseAssetPath`, so
        //      the model rides along locally too (it's only ~1.8MB).
        // The ~40MB onnxruntime-web wasm binaries — the actual deploy bloat —
        // are NOT copied here; they're served from HF via `onnxWASMBasePath`
        // (see Composer.tsx's VAD_ASSETS). wasm loads via fetch()+instantiate,
        // which is MIME-tolerant and CORS-clean from HF.
        const filesToCopy = [
          join(vadDist, 'vad.worklet.bundle.min.js'),
          join(vadDist, 'silero_vad_legacy.onnx'),
        ];

        let copied = 0;
        for (const src of filesToCopy) {
          if (!existsSync(src)) {
            console.warn(`[legion-copy-vad-assets] missing expected asset, skipping: ${src}`);
            continue;
          }
          const dest = join(destDir, src.slice(Math.max(src.lastIndexOf('/'), src.lastIndexOf('\\')) + 1));
          // Skip re-copying an already-up-to-date file (same size) — cheap
          // idempotence check so repeated `vite`/`vite build` runs in the
          // same checkout don't re-copy ~38MB every time.
          if (existsSync(dest) && statSync(dest).size === statSync(src).size) continue;
          copyFileSync(src, dest);
          copied++;
        }
        console.log(`[legion-copy-vad-assets] public/vad/ ready (${filesToCopy.length} assets, ${copied} copied this run)`);
      } catch (err) {
        // Non-fatal: surfaces as a broken Listen toggle at runtime (`vad.error`
        // in Composer.tsx), not a build/dev-server crash — same posture as
        // the model-source fallbacks elsewhere in this app.
        console.warn(
          '[legion-copy-vad-assets] failed to stage vad-web assets into public/vad/ — the Listen (VAD) toggle will fail at runtime:',
          err instanceof Error ? err.message : err,
        );
      }
    },
  };
}

// Vite config for the Unstable Legion chat app — the flagship product
// (apps/demo is the workstream showcase/debug surface; this is the thing
// users actually open). Carries forward apps/demo/vite.config.ts's
// hard-won gotcha fixes verbatim (see that file's comments for the full
// story of each):
//
//   - `commonjsOptions` isn't overridden here either — same symlinked
//     workspace-package situation applies.
//   - `server.watch.ignored` excludes e2e/** and Playwright's own output
//     dirs from the dev-server watcher, or editing a spec file mid-run
//     triggers a full-page reload that wipes in-memory WASM/WebGPU state.
//   - `optimizeDeps.include` lists every package only reachable through a
//     worker's own module graph (stage-runtime, codec, trystero, msgpack)
//     — Vite's crawler doesn't see into `new Worker(new URL(...))` entry
//     points, so without this a stage worker's first real construction
//     re-triggers dep optimization and full-reloads every connected page.
export default defineConfig({
  plugins: [
    react(),
    // Stages `@ricky0123/vad-web`'s worklet/model/wasm assets into
    // public/vad/ before either dev or build serves anything — see
    // `copyVadAssets`'s doc comment above for why a copy, not `?url`.
    copyVadAssets(),
    // PWA app-shell caching ONLY. This app's real payload is the WebGPU
    // stage runtime's model shard bytes — multi-hundred-MB `.gguf`
    // fragments fetched via HTTP range requests from HF/the webllm-mirror,
    // plus WebRTC/TURN + MQTT-over-WSS mesh signaling. None of that is
    // cacheable (range requests + CORS + live peer state), so the service
    // worker's job here is narrowly "make the app shell installable and
    // offline-launchable", not "cache the model". `globPatterns` below is
    // therefore restricted to app-shell file types, `globIgnores` belts
    // the same exclusion for the gguf/stages tree in case a shard ever
    // lands under a matching extension, and the `runtimeCaching` rules are
    // explicit NetworkOnly passthroughs for every cross-origin/model/
    // signaling surface so the SW can never intercept or proxy them —
    // when in doubt here, passthrough, never cache.
    VitePWA({
      // DISABLED (2026-07-18): the service worker's app-shell cache made
      // every field test unreproducible — a deployed fix could not be
      // observed because the SW kept serving the previously precached
      // bundle + legion-stage.wasm, so a "still broken" report could
      // never be distinguished from "stale cache". Deleting the plugin
      // would NOT fix that: service workers already registered in users'
      // browsers survive removal and keep serving their cache forever.
      // `selfDestroying` instead ships a SW that unregisters itself and
      // deletes its caches on activation — the only way to actually
      // retire an already-deployed PWA. Everything below is left intact
      // so this is a one-line revert once stage loading is trustworthy
      // again and cache-vs-code is no longer a confound.
      selfDestroying: true,
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      devOptions: { enabled: false },
      // `selfDestroying` only retires the SERVICE WORKER (cache). It STILL
      // emitted manifest.webmanifest and injected its <link> into index.html,
      // so Chrome kept treating this as an installable PWA — and an already
      // INSTALLED copy keeps launching as a standalone app with its own
      // storage. `manifest: false` stops the manifest being emitted or
      // linked, which is what actually de-PWAs the site. The previous
      // manifest object (name/icons/theme) is in git history — restore it
      // alongside removing this line to re-enable installability.
      manifest: false,
      workbox: {
        // App shell only — see plugin-level comment above.
        globPatterns: ['**/*.{js,css,html,wasm,ico,png,svg,webmanifest}'],
        globIgnores: [
          '**/*.gguf',
          '**/webllm/**',
          '**/stages/**',
          // onnxruntime-web's threaded/SIMD WASM (bundled transitively via
          // @unstable-legion/speech -> @huggingface/transformers, only
          // ever fetched by the speechWorker after the user opts into ASR
          // host mode) is ~21MB — far past what the "app shell" precache
          // budget below is sized for. Same treatment as the gguf/webllm
          // exclusions above: fetched at runtime, never precached.
          '**/ort-*.wasm',
        ],
        // legion-stage.wasm is ~4.3MB (the stage-runtime wasm glue, part
        // of the app shell); 6MB gives it headroom without coming
        // anywhere near opening the door to GB-scale model shards.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // Cross-origin model mirrors + same-origin model/signaling paths:
        // NEVER cache or proxy through the SW. These use CORS + HTTP
        // range requests (model shards) or persistent connections (mesh
        // signaling) that a cache/SW proxy would break.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/huggingface\.co\//,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^https:\/\/cdn\.codecai\.net\//,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /\/webllm\//,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /\.gguf(\?.*)?$/,
            handler: 'NetworkOnly',
          },
          {
            // onnxruntime-web's own WASM — see the matching globIgnores
            // entry above for why it's excluded from precaching.
            urlPattern: /\/ort-.*\.wasm(\?.*)?$/,
            handler: 'NetworkOnly',
          },
          {
            // MQTT-over-WSS mesh signaling. The SW never sees WebSocket
            // handshakes via the fetch API anyway, but this keeps the
            // exclusion explicit and self-documenting.
            urlPattern: /^wss?:\/\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  server: {
    port: 5174,
    host: '0.0.0.0',
    watch: {
      ignored: ['**/e2e/**', '**/test-results/**', '**/playwright-report/**'],
    },
  },
  preview: { port: 5174, host: '0.0.0.0' },
  // speechWorker.ts (via @unstable-legion/speech/worker -> lazy
  // @huggingface/transformers import) needs its worker bundle
  // code-split, which Rollup can't do under the default 'iife' worker
  // output format ("UMD and IIFE output formats are not supported for
  // code-splitting builds") — 'es' matches the `{ type: 'module' }` every
  // worker in this app is already constructed with at runtime. Same fix as
  // apps/demo/vite.config.ts.
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  optimizeDeps: {
    include: [
      '@unstable-legion/core',
      '@unstable-legion/react',
      '@unstable-legion/stage-runtime',
      // Same lazy-discovery gotcha as stage-runtime above, for the same
      // reason: only imported from src/workers/speechWorker.ts, a
      // separate module graph entry point Vite doesn't crawl from the
      // main thread until the ASR-host toggle actually constructs one.
      '@unstable-legion/speech',
      // Same lazy-discovery gotcha again: `useVadListen.ts` (mesh-react)
      // only `await import('@ricky0123/vad-web')`s once the Composer's
      // "🎙 Listen" toggle is switched on, so Vite's crawler never sees it
      // from the main entry graph either.
      '@ricky0123/vad-web',
      '@codecai/web',
      '@codecai/web-llm',
      '@codecai/web-safety',
      '@trystero-p2p/mqtt',
      '@msgpack/msgpack',
    ],
  },
});
