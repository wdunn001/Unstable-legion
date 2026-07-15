import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Vite config for the Unstable Legion demo.
//
// `commonjsOptions.include` is widened beyond the default node_modules-only
// scan because the @unstable-legion/* workspace packages are linked into
// node_modules as symlinks pointing at local sources. Without the broader
// include, Vite skips CJS conversion on those and crashes on the dynamic
// `require()` shape from msgpack / trystero in their dist/cjs builds.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    // e2e/*.spec.ts and Playwright's own output dirs aren't part of the
    // app's module graph, but Vite's default watcher still covers the
    // whole project root — editing a spec file (or Playwright writing a
    // trace) while a run is in progress otherwise triggers a FULL PAGE
    // RELOAD on every connected client (no matching module -> Vite's
    // full-reload fallback), which silently wipes all in-memory
    // WASM/WebGPU stage state mid-test. Root-caused while building
    // Phase C's multi-page e2e specs (workstream C3) — a pipeline-split
    // run that had been progressing normally reloaded out from under
    // itself the moment a sibling spec file was written to disk.
    watch: {
      ignored: ['**/e2e/**', '**/test-results/**', '**/playwright-report/**'],
    },
    // (Considered a dev-only /.well-known/codec proxy here for the local
    // "failed to load token maps" noise — root cause turned out to be
    // @codecai/web sending a codec-client-version header that broke the
    // jsDelivr CORS preflight, fixed at source in the Codec repo. No
    // workaround needed once that dist is rebuilt/picked up.)
  },
  preview: { port: 5173, host: '0.0.0.0' },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      // Multi-page build: the default single-entry `vite build` only
      // emits index.html's graph. debug-two-workers.html (casefile
      // decisive test 1 — two stage workers, one page, PRODUCTION build)
      // needs its own entry point built too, or `vite preview` 404s on it.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        debugTwoWorkers: fileURLToPath(new URL('./debug-two-workers.html', import.meta.url)),
      },
    },
  },
  optimizeDeps: {
    include: [
      '@unstable-legion/core',
      '@unstable-legion/react',
      // Phase C: only imported lazily, inside src/workers/stageWorker.ts
      // (a separate module graph entry point Vite doesn't crawl from the
      // main thread) — without listing it explicitly, Vite doesn't
      // discover it until the FIRST time a stage worker is actually
      // constructed, at which point it re-runs esbuild dep optimization
      // and does a full-page reload on every connected client. In a
      // multi-page pipeline-split run that reload lands mid-session
      // (right as `stage.load` arrives) and silently wipes all
      // in-memory WASM/WebGPU state — looks exactly like a crash.
      // Root-caused while building workstream C3's e2e specs.
      '@unstable-legion/stage-runtime',
      '@codecai/web',
      '@codecai/web-llm',
      '@codecai/web-safety',
      '@trystero-p2p/mqtt',
      '@msgpack/msgpack',
    ],
  },
});
