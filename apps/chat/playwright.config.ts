import { defineConfig, devices } from '@playwright/test';

// Real WebGPU, real Trystero MQTT relays, multiple pages in one chromium
// instance sharing one GPU adapter — same discipline as
// apps/demo/playwright.config.ts (which this mirrors closely; see that
// file's comments for the full rationale of each choice below). Distinct
// port (4184, not demo's 4183) so both apps' e2e suites can run
// concurrently without Playwright's `reuseExistingServer` attaching to
// the wrong app.
const GATE_TIMEOUT_MS = 20 * 60 * 1000;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: GATE_TIMEOUT_MS,
  expect: { timeout: GATE_TIMEOUT_MS },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4184',
    trace: 'retain-on-failure',
  },
  webServer: {
    // build+preview, not the dev server — see apps/demo/playwright.config.ts's
    // comment: Vite's optimizer cache doesn't hash linked file:-dep dist
    // contents, so a rebuilt workspace package invalidates lazily mid-run
    // and a full-page reload lands mid-session, wiping WASM/WebGPU state.
    // The build itself runs in e2e/global-setup.ts (Windows process-tree
    // kill doesn't reach through a `&&` chain in the webServer command).
    command: 'npx vite preview --port 4184 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4184',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium-webgpu',
      testIgnore: /mobile\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chromium',
        headless: false,
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            '--enable-features=Vulkan',
            '--disable-dawn-features=disallow_unsafe_apis',
            '--disable-features=WebRtcHideLocalIpsWithMdns',
            '--enable-logging=stderr',
            '--v=1',
          ],
        },
      },
    },
    {
      // Mobile layout smoke — a phone-sized viewport against the same app
      // (test model). Same launch args as the desktop project (harmless
      // when the spec never loads a real stage; keeps one flag story).
      name: 'chromium-mobile',
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices['Pixel 7'],
        channel: 'chromium',
        headless: false,
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            '--enable-features=Vulkan',
            '--disable-dawn-features=disallow_unsafe_apis',
            '--disable-features=WebRtcHideLocalIpsWithMdns',
            '--enable-logging=stderr',
            '--v=1',
          ],
        },
      },
    },
  ],
});
