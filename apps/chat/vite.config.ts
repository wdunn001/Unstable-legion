import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
  plugins: [react()],
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
