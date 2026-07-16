/**
 * Phase C workstream C3 CHAOS acceptance: closing the active remote
 * stage host mid-decode must NOT kill the run. `runDriverStageSession`'s
 * continue-from-history replan (mesh-core's proven Phase C orchestrator)
 * should pick the hot spare, reload it, re-prefill the full history, and
 * resume — session survives, restartCount === 1, and the final text
 * preserves every token generated before the kill (verbatim prefix).
 */
import { test, expect } from '@playwright/test';
import { readStageDebug, setupThreePeerMesh } from './helpers.js';

const GATE_TIMEOUT_MS = 15 * 60 * 1000;

test('chaos: killing the active remote stage host mid-decode triggers exactly one continue-from-history replan', async ({ context }) => {
  test.setTimeout(GATE_TIMEOUT_MS);
  const room = `c3-chaos-${Date.now().toString(36)}`;
  const { driver, hostA, hostB, hostASelfId, hostBSelfId } = await setupThreePeerMesh(context, room);

  // The panel's "run split inference" button always requests 64 decode
  // tokens (see StagePipelinePanel.tsx) — no UI control to raise it, but
  // 64 is generous enough for a real mid-decode kill window given actual
  // per-token latency.
  await driver.locator('.stage-pipeline-prompt').fill('Describe a rainy afternoon in a small coastal town.');
  await driver.locator('.sp-run-row button', { hasText: 'run split inference' }).click();

  await expect
    .poll(async () => (await readStageDebug(driver)).pipeline?.plan?.stages?.length, { timeout: 60_000 })
    .toBe(2);

  const planned = await readStageDebug(driver);
  const plan = planned.pipeline!.plan!;
  const remoteStage = plan.stages.find((s) => s.stageIndex === 1)!;
  const activeHostId = remoteStage.peerId;
  const activeHostPage = activeHostId === hostASelfId ? hostA : hostB;
  const spareHostId = activeHostId === hostASelfId ? hostBSelfId : hostASelfId;
  console.log(`[test] active remote host = ${activeHostId.slice(0, 8)}, hot spare = ${spareHostId.slice(0, 8)}`);
  expect(plan.hotSparePeerId).toBe(spareHostId);

  // Wait for real mid-decode progress — at least a few tokens generated
  // before we pull the plug, so this is demonstrably mid-session, not a
  // race against the initial handshake.
  await expect
    .poll(async () => (await readStageDebug(driver)).pipeline?.tokens?.length ?? 0, { timeout: 5 * 60_000, message: 'waiting for mid-decode progress before killing the host' })
    .toBeGreaterThanOrEqual(3);

  const preKillSnapshot = await readStageDebug(driver);
  const preKillTokens = [...(preKillSnapshot.pipeline?.tokens ?? [])];
  const preKillText = preKillSnapshot.pipeline?.text ?? '';
  console.log(`[test] pre-kill: ${preKillTokens.length} tokens, text=${JSON.stringify(preKillText)}`);

  // ── The chaos event: close the active remote host's page. ───────────
  await activeHostPage.close();

  // ── Assert: exactly one replan, session survives, resumes. ──────────
  await expect
    .poll(async () => (await readStageDebug(driver)).pipeline?.restartCount ?? 0, { timeout: 60_000, message: 'expected exactly one replan after the host closed' })
    .toBe(1);

  // The new plan's remote stage must now be the (still-alive) hot spare.
  const afterReplan = await readStageDebug(driver);
  const newRemote = afterReplan.pipeline?.plan?.stages.find((s) => s.stageIndex === 1);
  expect(newRemote?.peerId).toBe(spareHostId);

  // Session must NOT have aborted — it should keep running to completion.
  await expect
    .poll(async () => (await readStageDebug(driver)).pipeline?.status?.phase, { timeout: 10 * 60_000, message: 'pipeline should finish (not abort) after replan' })
    .toBe('finished');

  const final = await readStageDebug(driver);
  console.log(`[test] final: restartCount=${final.pipeline?.restartCount} tokens=${final.pipeline?.tokens.length} text=${JSON.stringify(final.pipeline?.text)}`);
  expect(final.pipeline?.status.phase).toBe('finished');
  expect(final.pipeline?.restartCount).toBe(1);
  // Token history is continuous across the replan (continue-from-history
  // re-prefills promptTokens+generatedTokens so far) — the pre-kill
  // tokens must appear verbatim as a prefix of the final generated tokens.
  const finalTokens = final.pipeline?.tokens ?? [];
  expect(finalTokens.length).toBeGreaterThanOrEqual(preKillTokens.length);
  expect(finalTokens.slice(0, preKillTokens.length)).toEqual(preKillTokens);
  // Final text is coherent (non-empty, at least as long as the pre-kill text).
  expect((final.pipeline?.text ?? '').length).toBeGreaterThanOrEqual(preKillText.length);

  await driver.close();
  const survivingHost = activeHostId === hostASelfId ? hostB : hostA;
  await survivingHost.close();
});
