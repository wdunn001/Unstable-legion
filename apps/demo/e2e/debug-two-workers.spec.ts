/**
 * Casefile DEBUG-CASEFILE.md decisive test 1: bundle vs environment.
 * Two stage workers, ONE page, this demo's own PRODUCTION build (the
 * suite this file lives in always runs against `vite build` + `vite
 * preview` — see playwright.config.ts). No mesh, no multi-context, no
 * Trystero — isolates the wasm worker + streamToMemfs path.
 *
 * Dies (a worker never reaches 'ready', or the page/worker closes) -> the
 * demo BUNDLE is implicated (bisect: disable minify, manualChunks, etc).
 * Both reach 'ready' -> the bug is NOT in the bundle; move to casefile
 * test 2 (multi-page/context dimension).
 */
import { test, expect, type Page } from '@playwright/test';

const GATE_TIMEOUT_MS = 15 * 60 * 1000;

interface DebugTwoWorkersState {
  worker1: { phase: string; error?: string };
  worker2: { phase: string; error?: string };
  done: boolean;
}

function wirePageLogging(page: Page, label: string): void {
  page.on('console', (msg) => console.log(`[${label}] ${msg.text()}`));
  page.on('pageerror', (err) => console.error(`[${label} pageerror] ${err.message}`));
  page.on('worker', (worker) => {
    console.log(`[${label}] worker SPAWNED -> ${worker.url()}`);
    worker.on('close', () => console.error(`[${label}] worker CLOSED -> ${worker.url()}`));
  });
}

test('debug: two stage workers loading full.gguf concurrently in one demo page (production build)', async ({ page }) => {
  test.setTimeout(GATE_TIMEOUT_MS);
  wirePageLogging(page, 'debug');

  // Sequential: mirrors the real driver-then-remote load order (see
  // debugTwoWorkersMain.ts doc comment). A concurrent-mode run of this
  // same page surfaced a DIFFERENT bug (an explicit early network error
  // when vite preview serves two simultaneous 610MB fetches) — that's
  // not the casefile's silent-death signature, so this test pins the
  // sequential order to isolate the actual defect under investigation.
  await page.goto('/debug-two-workers.html?mode=sequential');

  await page.waitForFunction(
    () => (window as unknown as { __debugTwoWorkers?: DebugTwoWorkersState }).__debugTwoWorkers?.done === true,
    undefined,
    { timeout: GATE_TIMEOUT_MS, polling: 1000 },
  );

  const state = await page.evaluate(
    () => (window as unknown as { __debugTwoWorkers?: DebugTwoWorkersState }).__debugTwoWorkers,
  );
  console.log(`[test] final state: ${JSON.stringify(state)}`);

  expect(state, '__debugTwoWorkers was never set').toBeTruthy();
  expect(state!.worker1.phase, `worker1 failed: ${state!.worker1.error ?? '(no error — worker likely died silently)'}`).toBe('ready');
  expect(state!.worker2.phase, `worker2 failed: ${state!.worker2.error ?? '(no error — worker likely died silently)'}`).toBe('ready');
});
