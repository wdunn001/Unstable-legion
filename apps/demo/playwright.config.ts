import { defineConfig, devices } from '@playwright/test';

// Phase C workstream C3 acceptance: real WebGPU, real Trystero MQTT relays,
// multiple pages in one chromium instance sharing one GPU adapter — same
// discipline as legion-stage-runtime's harness config
// (H:\dev\legion-stage-runtime\harness\playwright.config.ts), which this
// mirrors closely. Model loads (full.gguf, ~610MB, x3 pages) are slow —
// timeouts are generous per that config's own precedent.
const GATE_TIMEOUT_MS = 20 * 60 * 1000;

export default defineConfig({
  testDir: './e2e',
  timeout: GATE_TIMEOUT_MS,
  expect: { timeout: GATE_TIMEOUT_MS },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4183',
    trace: 'retain-on-failure',
  },
  webServer: {
    // Dev server (not build+preview): serves TS/workers transformed
    // on-the-fly, no separate build step to keep green while iterating.
    // Port 4183 (NOT legion-stage-runtime harness's 4173 — that repo's
    // own playwright.config.ts owns 4173 and may already be running
    // concurrently; picking a distinct port avoids Playwright's
    // `reuseExistingServer` silently attaching to the WRONG app).
    command: 'npx vite --port 4183 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4183',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium-webgpu',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        // Headless Chrome on this box returns no WebGPU adapter
        // (navigator.gpu.requestAdapter() -> null) even with
        // --enable-unsafe-webgpu; headed mode gets a real adapter
        // (verified in legion-stage-runtime's Phase A/B gates on the
        // same lab GPU). Headed it is.
        headless: false,
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            '--enable-features=Vulkan',
            '--disable-dawn-features=disallow_unsafe_apis',
            // mDNS ICE-candidate obfuscation isn't needed here (every
            // page is 127.0.0.1, same machine) but disabling it is a
            // harmless no-op and matches the proven harness config.
            '--disable-features=WebRtcHideLocalIpsWithMdns',
            // 3 pages share one physical GPU (full.gguf ~610MB each,
            // 3x fits) — no extra flags needed beyond WebGPU enablement.
          ],
        },
      },
    },
  ],
});
