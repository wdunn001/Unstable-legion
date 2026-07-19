import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

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
      manifest: {
        name: 'Unstable Legion',
        short_name: 'Legion',
        description:
          "Unstable Legion's flagship chat app — open it and you join the shared communal mesh serving Qwen3-8B.",
        display: 'standalone',
        start_url: '/',
        scope: '/',
        theme_color: '#0c0c0c',
        background_color: '#0c0c0c',
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // App shell only — see plugin-level comment above.
        globPatterns: ['**/*.{js,css,html,wasm,ico,png,svg,webmanifest}'],
        globIgnores: [
          '**/*.gguf',
          '**/webllm/**',
          '**/stages/**',
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
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  optimizeDeps: {
    include: [
      '@unstable-legion/core',
      '@unstable-legion/react',
      '@unstable-legion/stage-runtime',
      '@codecai/web',
      '@codecai/web-llm',
      '@codecai/web-safety',
      '@trystero-p2p/mqtt',
      '@msgpack/msgpack',
    ],
  },
});
