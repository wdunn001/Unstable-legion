/**
 * M2 acceptance: ONE host tab serving TWO CONCURRENT driver sessions over
 * one loaded stage. Reuses the real production pipeline-split path
 * (`useStageHost`'s multi-session rewrite answering `stage.load`, still
 * the wire kind `stageOrchestrator.ts`'s driver sends — see
 * `useStageHost.ts`'s M2 doc comment on the legacy vs `stage.session.open`
 * origins) rather than a synthetic harness page: two REAL driver tabs each
 * run their own local stage-0 worker and send `stage.load` to the SAME
 * single remote host tab. Proves the thing M1 proved at the stage-runtime
 * layer (N sessions over one loaded stage, token-exact, no cross-talk) now
 * holds end-to-end over the mesh — real WebGPU, real wasm, real `tc`/`sf`
 * wire traffic, real sessionId-enveloped activation frames.
 *
 * Method (mirrors legion-stage-runtime's M1 multisession.spec.ts):
 *   1. Run prompt A alone (driver1 vs the host) to completion — reference.
 *   2. Run prompt B alone (driver2 vs the SAME now-already-loaded host,
 *      reusing the worker — see useStageHost.ts's `ensureWorkerLoaded`
 *      fast path) — reference.
 *   3. Run prompt A and prompt B AGAIN, this time CONCURRENTLY (both
 *      drivers click "run" back-to-back, no awaiting between them) against
 *      the same host — sampling the host's session-occupancy debug
 *      surface while both are in flight to confirm genuine overlap.
 *   4. Assert each concurrent run's token stream is token-exact vs its
 *      own solo reference — if session KV state leaked or aliased across
 *      the two concurrent sessions, this is what would catch it.
 */
import { test, expect } from '@playwright/test';
import {
  joinDemo,
  wirePageLogging,
  setHostingEnabled,
  waitForHostActive,
  rosterStageHostPeerIds,
  readStageDebug,
  runSplitInference,
  waitForPipelineFinished,
} from './helpers.js';

const GATE_TIMEOUT_MS = 15 * 60 * 1000;

const PROMPT_A = 'Name three colors.';
const PROMPT_B = 'List two kinds of fruit.';

test('multi-session-host: one host serves two concurrent driver sessions, token-exact vs solo baselines', async ({ context }) => {
  test.setTimeout(GATE_TIMEOUT_MS);
  const room = `c-m2-multisession-${Date.now().toString(36)}`;
  const browser = context.browser();
  if (!browser) throw new Error('requires a browser-backed context');

  // Separate BrowserContext per peer — same rationale as
  // setupThreePeerMesh (independent renderer memory budgets for 3
  // concurrent ~1.3GB stage-worker footprints: 1 host + 2 drivers' own
  // local stage-0 workers).
  const hostCtx = await browser.newContext();
  const driver1Ctx = await browser.newContext();
  const driver2Ctx = await browser.newContext();
  const host = await hostCtx.newPage();
  const driver1 = await driver1Ctx.newPage();
  const driver2 = await driver2Ctx.newPage();
  wirePageLogging(host, 'host');
  wirePageLogging(driver1, 'driver1');
  wirePageLogging(driver2, 'driver2');

  await joinDemo(host, room, 'host');
  await joinDemo(driver1, room, 'driver1');
  await joinDemo(driver2, room, 'driver2');

  await setHostingEnabled(host, true);
  await waitForHostActive(host);
  const hostSelfId = (await readStageDebug(host)).selfId!;

  // Host commits maxSessions >= 2 at load time by default (chooseMaxSessions
  // default 4) — confirm the cap actually advertises that before relying on it.
  await expect
    .poll(async () => (await readStageDebug(host)).host?.maxSessions, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2);

  await expect(async () => {
    const ids1 = await rosterStageHostPeerIds(driver1);
    const ids2 = await rosterStageHostPeerIds(driver2);
    if (!ids1.includes(hostSelfId)) throw new Error(`driver1 roster missing host: ${JSON.stringify(ids1)}`);
    if (!ids2.includes(hostSelfId)) throw new Error(`driver2 roster missing host: ${JSON.stringify(ids2)}`);
  }).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] });

  // ── Phase 1: solo baselines, SEQUENTIAL (no capacity contention) ──────
  console.log('[test] phase 1a: driver1 solo baseline (prompt A)');
  await runSplitInference(driver1, PROMPT_A);
  const refA = await waitForPipelineFinished(driver1, 'driver1-solo');
  const tokensA_ref = refA.pipeline!.tokens;
  expect(tokensA_ref.length).toBeGreaterThan(0);
  console.log(`[test] phase 1a done: ${tokensA_ref.length} tokens`);

  console.log('[test] phase 1b: driver2 solo baseline (prompt B)');
  await runSplitInference(driver2, PROMPT_B);
  const refB = await waitForPipelineFinished(driver2, 'driver2-solo');
  const tokensB_ref = refB.pipeline!.tokens;
  expect(tokensB_ref.length).toBeGreaterThan(0);
  console.log(`[test] phase 1b done: ${tokensB_ref.length} tokens`);

  // Both solo runs should have picked the SAME (only) remote host.
  const stage1PeerA = refA.pipeline!.plan!.stages.find((s) => s.stageIndex === 1)?.peerId;
  const stage1PeerB = refB.pipeline!.plan!.stages.find((s) => s.stageIndex === 1)?.peerId;
  expect(stage1PeerA).toBe(hostSelfId);
  expect(stage1PeerB).toBe(hostSelfId);

  // The host should have freed both sessions by now (auto-freed on eos).
  await expect
    .poll(async () => (await readStageDebug(host)).host?.sessions?.length ?? -1, { timeout: 30_000 })
    .toBe(0);

  // ── Phase 2: CONCURRENT — same two prompts, same host, overlapping ────
  console.log('[test] phase 2: concurrent run — driver1 (A) + driver2 (B) vs the same host');
  await runSplitInference(driver1, PROMPT_A);
  await runSplitInference(driver2, PROMPT_B);

  // Sample the host's session occupancy while both runs are in flight —
  // the decisive evidence this was genuine concurrency, not accidental
  // serialization (e.g. one queued behind the other).
  let maxObservedConcurrentSessions = 0;
  const sampleDeadline = Date.now() + GATE_TIMEOUT_MS;
  while (Date.now() < sampleDeadline) {
    const [d1, d2, dh] = await Promise.all([readStageDebug(driver1), readStageDebug(driver2), readStageDebug(host)]);
    const count = dh.host?.sessions?.length ?? 0;
    if (count > maxObservedConcurrentSessions) maxObservedConcurrentSessions = count;
    const p1 = d1.pipeline?.status.phase;
    const p2 = d2.pipeline?.status.phase;
    if ((p1 === 'finished' || p1 === 'aborted' || p1 === 'error') && (p2 === 'finished' || p2 === 'aborted' || p2 === 'error')) {
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`[test] phase 2: max concurrent sessions observed on host = ${maxObservedConcurrentSessions}`);

  const concA = await waitForPipelineFinished(driver1, 'driver1-concurrent');
  const concB = await waitForPipelineFinished(driver2, 'driver2-concurrent');
  const tokensA_concurrent = concA.pipeline!.tokens;
  const tokensB_concurrent = concB.pipeline!.tokens;
  console.log(
    `[test] phase 2 done: A=${tokensA_concurrent.length} tok, B=${tokensB_concurrent.length} tok, ` +
      `restartsA=${concA.pipeline?.restartCount}, restartsB=${concB.pipeline?.restartCount}`,
  );

  // ── The decisive assertions ────────────────────────────────────────
  // 1. Genuine overlap actually happened (not silently serialized).
  expect(maxObservedConcurrentSessions).toBeGreaterThanOrEqual(2);
  // 2. No replans — both concurrent runs completed cleanly, first try.
  expect(concA.pipeline?.restartCount).toBe(0);
  expect(concB.pipeline?.restartCount).toBe(0);
  // 3. Token-exact vs the solo baseline — the actual cross-talk gate: if
  //    session KV state leaked or aliased between driver1's and driver2's
  //    concurrent sessions on the shared host, these would diverge.
  expect(tokensA_concurrent).toEqual(tokensA_ref);
  expect(tokensB_concurrent).toEqual(tokensB_ref);

  await host.close();
  await driver1.close();
  await driver2.close();
});
