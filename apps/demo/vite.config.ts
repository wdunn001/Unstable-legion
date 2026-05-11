import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config for the Unstable Legion demo.
//
// `commonjsOptions.include` is widened beyond the default node_modules-only
// scan because the @unstable-legion/* workspace packages are linked into
// node_modules as symlinks pointing at local sources. Without the broader
// include, Vite skips CJS conversion on those and crashes on the dynamic
// `require()` shape from msgpack / trystero in their dist/cjs builds.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: '0.0.0.0' },
  preview: { port: 5173, host: '0.0.0.0' },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  optimizeDeps: {
    include: [
      '@unstable-legion/core',
      '@unstable-legion/react',
      '@codecai/web',
      '@codecai/web-llm',
      '@codecai/web-safety',
      '@trystero-p2p/mqtt',
      '@msgpack/msgpack',
    ],
  },
});
