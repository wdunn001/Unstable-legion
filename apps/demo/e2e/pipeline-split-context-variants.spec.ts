/**
 * Casefile DEBUG-CASEFILE.md decisive test 2: multi-page/context
 * dimension. Test 1 (debug-two-workers.spec.ts) ruled out the demo
 * bundle/minification as the cause — two sequential full-model loads in
 * one page, one production bundle, both succeed cleanly.
 *
 * This file flips ONE variable at a time against the REAL demo pipeline
 * (not a synthetic stand-in) using `setupPeerMesh` (helpers.ts):
 *   - contextMode: 'shared' (harness shape, one renderer) vs 'separate'
 *     (mainline pipeline-split.spec.ts's current shape, one renderer
 *     PER peer)
 *   - hostCount: 1 (driver + one host, no hot spare — "2-pages-no-spare")
 *     vs 2 (mainline's driver + hostA + hostB)
 *
 * Each variant runs the real split-inference pipeline end to end and
 * asserts completion (>=32 tokens, phase finished, no restarts) — same
 * bar as the mainline spec, just without the 2-host plan-shape
 * assertions (hotSparePeerId etc.) that don't apply when hostCount is 1.
 */
import { test, expect } from '@playwright/test';
import { readStageDebug, setupPeerMesh, type PeerMeshOptions } from './helpers.js';

const GATE_TIMEOUT_MS = 15 * 60 * 1000;

async function runVariant(context: import('@playwright/test').BrowserContext, room: string, opts: PeerMeshOptions): Promise<void> {
  const { driver, hosts } = await setupPeerMesh(context, room, opts);

  await driver.locator('.sp-prompt').fill('Name three colors.');
  await driver.locator('.sp-run-row button', { hasText: 'run split inference' }).click();

  await expect
    .poll(async () => (await readStageDebug(driver)).pipeline?.plan?.stages?.length, { timeout: 60_000 })
    .toBe(2);

  await expect
    .poll(async () => (await readStageDebug(driver)).pipeline?.readyStageIndexes ?? [], { timeout: 5 * 60_000 })
    .toEqual(expect.arrayContaining([1]));

  await expect
    .poll(
      async () => {
        const d = await readStageDebug(driver);
        const s = d.pipeline?.status;
        if (s?.phase === 'aborted' || s?.phase === 'finished') {
          console.log(
            `[test] terminal status=${JSON.stringify(s)} tokens=${d.pipeline?.tokens?.length ?? 0} restarts=${d.pipeline?.restartCount ?? 0}`,
          );
        }
        return s?.phase === 'aborted' ? `aborted: ${JSON.stringify(s)}` : s?.phase;
      },
      { timeout: 10 * 60_000, message: 'pipeline should reach finished' },
    )
    .toBe('finished');

  const final = await readStageDebug(driver);
  console.log(`[test] final status=${final.pipeline?.status.phase} tokens=${final.pipeline?.tokens.length} text=${JSON.stringify(final.pipeline?.text)}`);
  expect(final.pipeline?.tokens.length ?? 0).toBeGreaterThanOrEqual(32);
  expect(final.pipeline?.restartCount).toBe(0);

  await driver.close();
  for (const h of hosts) await h.close();
}

test('casefile test 2a: 3 peers, ONE SHARED context (revert per-peer contexts — harness shape)', async ({ context }) => {
  test.setTimeout(GATE_TIMEOUT_MS);
  const room = `c3-ctxvar-shared3-${Date.now().toString(36)}`;
  await runVariant(context, room, { hostCount: 2, contextMode: 'shared' });
});

test('casefile test 2b: 2 peers (driver + one host, no spare), SEPARATE contexts', async ({ context }) => {
  test.setTimeout(GATE_TIMEOUT_MS);
  const room = `c3-ctxvar-sep2-${Date.now().toString(36)}`;
  await runVariant(context, room, { hostCount: 1, contextMode: 'separate' });
});
