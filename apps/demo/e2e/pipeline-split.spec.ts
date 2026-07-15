/**
 * Phase C workstream C3 mainline acceptance: 3 real pages in one
 * chromium instance (real WebGPU, real Trystero MQTT relays) — driver +
 * 2 stage hosts. Asserts discovery -> plan (2-stage split, local +
 * exactly one remote, the other host held as hot spare) -> downstream-
 * first ready sequence -> streamed completion of >= 32 tokens.
 */
import { test, expect } from '@playwright/test';
import { readStageDebug, setupThreePeerMesh } from './helpers.js';

const GATE_TIMEOUT_MS = 15 * 60 * 1000;

test('pipeline-split: driver plans a 2-stage split across 2 stage hosts and streams >= 32 tokens', async ({ context }) => {
  test.setTimeout(GATE_TIMEOUT_MS);
  const room = `c3-pipeline-${Date.now().toString(36)}`;
  const { driver, hostA, hostB, hostASelfId, hostBSelfId } = await setupThreePeerMesh(context, room);

  // ── Run the split pipeline from the driver's UI ─────────────────────
  await driver.locator('.sp-prompt').fill('Name three colors.');
  await driver.locator('.sp-run-row button', { hasText: 'run split inference' }).click();

  // ── Plan assertion: local stage 0 + exactly one remote stage; the
  //    OTHER host is the hot spare, not a second active stage. ────────
  await expect
    .poll(async () => (await readStageDebug(driver)).pipeline?.plan?.stages?.length, { timeout: 60_000 })
    .toBe(2);

  const planned = await readStageDebug(driver);
  const plan = planned.pipeline!.plan!;
  const local = plan.stages.find((s) => s.stageIndex === 0)!;
  const remote = plan.stages.find((s) => s.stageIndex === 1)!;
  expect(local.peerId).toBe(planned.selfId);
  expect(local.layerStart).toBe(0);
  expect([hostASelfId, hostBSelfId]).toContain(remote.peerId);
  expect(remote.isFinal).toBe(true);
  expect(remote.layerEnd).toBeGreaterThan(local.layerEnd);
  // The un-selected host becomes the hot spare.
  const otherHost = remote.peerId === hostASelfId ? hostBSelfId : hostASelfId;
  expect(plan.hotSparePeerId).toBe(otherHost);

  console.log(`[test] plan: local[0,${local.layerEnd}) -> remote(${remote.peerId.slice(0, 8)})[${remote.layerStart},${remote.layerEnd}), spare=${otherHost.slice(0, 8)}`);

  // ── Downstream-first ready: the remote stage reaches stage.ready
  //    before the run finishes. ────────────────────────────────────────
  await expect
    .poll(async () => (await readStageDebug(driver)).pipeline?.readyStageIndexes ?? [], { timeout: 5 * 60_000 })
    .toEqual(expect.arrayContaining([1]));

  // ── Streamed completion: >= 32 tokens, status finished. ─────────────
  // Poll the whole status object (not just the phase) so a failure message
  // carries the abort reason + progress counters instead of a bare "aborted".
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
  console.log(`[test] final status=${final.pipeline?.status.phase} tokens=${final.pipeline?.tokens.length} tpotMs=${final.pipeline?.tpotMs} text=${JSON.stringify(final.pipeline?.text)}`);
  expect(final.pipeline?.tokens.length ?? 0).toBeGreaterThanOrEqual(32);
  expect(final.pipeline?.restartCount).toBe(0);
  expect((final.pipeline?.text ?? '').length).toBeGreaterThan(0);

  await driver.close();
  await hostA.close();
  await hostB.close();
});
