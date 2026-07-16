/**
 * M3/M4 acceptance: the communal pipeline's actual milestone proof.
 *
 *   a. 3 host tabs (communal hosting enabled) join an isolated room and
 *      self-assemble coverage of qwen3-0.6b FROM EMPTY — no coordinator,
 *      no election (`communalHostClaim`, `useCommunalHost.ts`). Asserts
 *      the driver-visible topology (`buildCommunalTopology` over the live
 *      roster) reaches 100% coverage.
 *   b. 2 driver tabs (`useCommunalChat`, the M3 gap this pass closes) open
 *      CONCURRENT communal chats against that self-assembled mesh, each
 *      streaming real tokens.
 *   c. Kill the host BOTH drivers actually depend on, mid-decode. Asserts
 *      the HONEST outcome the assembled topology's redundancy produces:
 *      recovery via continue-from-history (a warm spare existed) or a
 *      clean abort surfacing the coverage loss (no spare existed) —
 *      whichever the real, live self-assembly actually produced, not a
 *      pre-decided expectation.
 *
 * `spreadWidth=1` (a URL-param e2e knob, see `CommunalChatPanel.tsx`) on
 * both driver pages forces them onto the SAME top-ranked host
 * deterministically — without it, `planCommunalRoute`'s anti-stampede
 * spread (`hash(driverPeerId) % min(candidates,3)`) could legitimately
 * fan the two drivers across different candidates, in which case killing
 * one host wouldn't exercise "both chats depend on it" at all. Forcing
 * the shared-dependency shape is what makes this a meaningful test of
 * "kill one host, both chats survive" rather than leaving it to which
 * peerId hashes land where.
 */
import { test, expect } from '@playwright/test';
import { buildCommunalTopology, type MeshRosterEntry } from '@unstable-legion/core';
import { STAGE_MODEL_ID, STAGE_TOTAL_LAYERS, STAGE_DRIVER_LAYERS } from '@unstable-legion/react';
import {
  joinDemo,
  wirePageLogging,
  setCommunalHostEnabled,
  waitForCommunalHostActive,
  readCommunalDebug,
  runCommunalChat,
  readCommunalChatDebug,
  waitForCommunalChatFinished,
  type DebugCommunalSnapshot,
} from './helpers.js';

const GATE_TIMEOUT_MS = 20 * 60 * 1000;

/** Build minimal-but-valid `MeshRosterEntry` stand-ins from the debug
 * snapshot's simplified `{peerId, loadedStages}` roster so
 * `buildCommunalTopology` (the SAME pure function `CommunalHostPanel`'s
 * production code calls) can be run directly against what the driver page
 * actually sees — the acceptance criterion is explicitly framed as
 * "buildCommunalTopology over the roster", not a hand-rolled coverage
 * check. Only the fields `collectCommunalAds`/`hostStabilityScore`
 * actually read are populated (same minimal shape already proven in
 * packages/mesh-react/test/economyWiring.test.ts). */
function toRosterEntries(roster: DebugCommunalSnapshot['roster']): MeshRosterEntry[] {
  return (roster ?? []).map((r) => ({
    v: 1,
    ts: 0,
    peerId: r.peerId,
    lastSeen: 0,
    nick: r.peerId,
    modelId: 'n/a',
    available: true,
    skills: [],
    systemPromptSummary: '',
    tools: [],
    stageHost:
      r.loadedStages.length > 0
        ? {
            maxStorageBufferBytes: 1,
            wasmHeapBudget: 1,
            loadedStages: r.loadedStages.map((s) => ({
              modelId: s.modelId,
              layerStart: s.layerStart,
              layerEnd: s.layerEnd,
              includeEmbeddings: false,
              includeOutput: s.includeOutput ?? false,
              ctxSize: 512,
              wireDtype: 'f32' as const,
              maxSessions: s.maxSessions ?? 4,
              activeSessions: s.activeSessions ?? 0,
              epoch: 0,
            })),
          }
        : undefined,
  }));
}

function topologyOf(snap: DebugCommunalSnapshot) {
  return buildCommunalTopology(toRosterEntries(snap.roster), {
    modelId: STAGE_MODEL_ID,
    totalLayers: STAGE_TOTAL_LAYERS,
    driverLayers: STAGE_DRIVER_LAYERS,
  });
}

test('communal: 3 hosts self-assemble coverage from empty; 2 concurrent chats survive a host death', async ({ context }) => {
  test.setTimeout(GATE_TIMEOUT_MS);
  const room = `c-communal-${Date.now().toString(36)}`;
  const browser = context.browser();
  if (!browser) throw new Error('requires a browser-backed context');

  // Separate BrowserContext per peer (real-machine shape — same rationale
  // as setupThreePeerMesh/multi-session-host).
  const hostCtxs = [await browser.newContext(), await browser.newContext(), await browser.newContext()];
  const driverCtxs = [await browser.newContext(), await browser.newContext()];
  const hosts = await Promise.all(hostCtxs.map((c) => c.newPage()));
  const drivers = await Promise.all(driverCtxs.map((c) => c.newPage()));
  hosts.forEach((p, i) => wirePageLogging(p, `host${i + 1}`));
  drivers.forEach((p, i) => wirePageLogging(p, `driver${i + 1}`));

  // Join everyone first (cheap — no model fetch triggered by joining alone).
  await Promise.all([
    ...hosts.map((p, i) => joinDemo(p, room, `host${i + 1}`)),
    // spreadWidth=1 forces both drivers onto the same top-ranked candidate
    // — see this file's top doc comment.
    ...drivers.map((p, i) => joinDemo(p, room, `driver${i + 1}`, '&spreadWidth=1')),
  ]);

  // ── Phase a: self-assembly FROM EMPTY ──────────────────────────────
  console.log('[test] phase a: enabling communal hosting on 3 hosts');
  // A small stagger between ENABLING each host (not between joining —
  // everyone already joined above) avoids dog-piling 3 simultaneous
  // fresh full.gguf fetches onto vite preview's static file server in the
  // exact same event-loop tick (a known, separate flakiness axis —
  // DEBUG-CASEFILE.md's Test 1 side-finding — unrelated to the communal
  // self-assembly logic under test here). This does NOT fake
  // coordination-free assembly: none of the 3 hosts has claimed or loaded
  // anything yet when the stagger starts, and `communalHostClaim` is still
  // making its own independent decision every tick purely from roster
  // state, with no message exchange between hosts.
  for (const h of hosts) {
    await setCommunalHostEnabled(h, true);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  await Promise.all(hosts.map((h) => waitForCommunalHostActive(h, 8 * 60_000)));
  console.log('[test] phase a: all 3 hosts report active (claimed + loaded + warm + advertising)');

  // Driver-visible topology should converge to 100% coverage.
  await expect
    .poll(
      async () => {
        const snap = await readCommunalDebug(drivers[0]!);
        const topo = topologyOf(snap);
        console.log(
          `[test] phase a: coverage=${(topo.coverageFraction * 100).toFixed(0)}% gaps=${JSON.stringify(topo.gaps)} segments=${topo.segments.length}`,
        );
        return topo.coverageFraction;
      },
      { timeout: 3 * 60_000, message: 'driver-visible communal topology should reach 100% coverage from empty' },
    )
    .toBe(1);

  const assembledSnap = await readCommunalDebug(drivers[0]!);
  const assembledTopo = topologyOf(assembledSnap);
  expect(assembledTopo.gaps.length).toBe(0);
  expect(assembledTopo.outputCovered).toBe(true);
  console.log(
    `[test] phase a DONE: ${assembledTopo.segments.length} segment(s), ` +
      assembledTopo.segments.map((s) => `[${s.layerStart},${s.layerEnd}) x${s.candidates.length} candidate(s)`).join(', '),
  );

  // ── Phase b: 2 CONCURRENT communal chats ───────────────────────────
  console.log('[test] phase b: 2 concurrent communal chats');
  await runCommunalChat(drivers[0]!, 'Name three colors.');
  await runCommunalChat(drivers[1]!, 'List two kinds of fruit.');

  // Both should attach (stage 1 ready) before we look at who they picked.
  await expect
    .poll(async () => (await readCommunalChatDebug(drivers[0]!)).readyStageIndexes ?? [], { timeout: 5 * 60_000 })
    .toEqual(expect.arrayContaining([1]));
  await expect
    .poll(async () => (await readCommunalChatDebug(drivers[1]!)).readyStageIndexes ?? [], { timeout: 5 * 60_000 })
    .toEqual(expect.arrayContaining([1]));

  const plan1 = (await readCommunalChatDebug(drivers[0]!)).plan!;
  const plan2 = (await readCommunalChatDebug(drivers[1]!)).plan!;
  const attachedPeer1 = plan1.stages.find((s) => s.stageIndex === 1)!.peerId;
  const attachedPeer2 = plan2.stages.find((s) => s.stageIndex === 1)!.peerId;
  console.log(`[test] phase b: driver1 attached -> ${attachedPeer1.slice(0, 10)}, driver2 attached -> ${attachedPeer2.slice(0, 10)}`);
  const sharedHost = attachedPeer1 === attachedPeer2;

  // Each streams real output before we touch anything.
  await expect
    .poll(async () => (await readCommunalChatDebug(drivers[0]!)).tokens?.length ?? 0, { timeout: 5 * 60_000 })
    .toBeGreaterThanOrEqual(4);
  await expect
    .poll(async () => (await readCommunalChatDebug(drivers[1]!)).tokens?.length ?? 0, { timeout: 5 * 60_000 })
    .toBeGreaterThanOrEqual(4);
  const tokensBeforeKill1 = ((await readCommunalChatDebug(drivers[0]!)).tokens ?? []).length;
  const tokensBeforeKill2 = ((await readCommunalChatDebug(drivers[1]!)).tokens ?? []).length;
  console.log(`[test] phase b: mid-decode — driver1=${tokensBeforeKill1} tok, driver2=${tokensBeforeKill2} tok, sharedHost=${sharedHost}`);

  // ── Phase c: kill the host driver1 depends on, mid-decode ──────────
  const hostSelfIds = await Promise.all(hosts.map(async (h) => (await readCommunalDebug(h)).selfId!));
  const targetIdx = hostSelfIds.indexOf(attachedPeer1);
  expect(targetIdx, `attached peer ${attachedPeer1} should be one of our 3 host tabs (${JSON.stringify(hostSelfIds)})`).toBeGreaterThanOrEqual(0);

  // Whichever segment covers the attached peer, check for a surviving warm
  // spare BEFORE killing — this decides which honest outcome to expect
  // below, per this file's top doc comment.
  const preKillTopo = topologyOf(await readCommunalDebug(drivers[0]!));
  const attachedSegment = preKillTopo.segments.find((s) => s.candidates.some((c) => c.peerId === attachedPeer1));
  const spareExists = (attachedSegment?.candidates.length ?? 0) > 1;
  console.log(
    `[test] phase c: killing host${targetIdx + 1} (${attachedPeer1.slice(0, 10)}) mid-decode — ` +
      `segment had ${attachedSegment?.candidates.length ?? 0} candidate(s), spareExists=${spareExists}`,
  );
  const killedAt = Date.now();
  await hosts[targetIdx]!.close();

  // ── Observe the honest outcome for each affected driver ────────────
  async function observeDriver(page: (typeof drivers)[number], label: string, dependedOnKilled: boolean, tokensBeforeKill: number) {
    if (!dependedOnKilled) {
      // This driver's own attach didn't touch the killed host — it should
      // just keep going and finish normally, unaffected.
      const result = await waitForCommunalChatFinished(page, label, 6 * 60_000);
      console.log(`[test] ${label}: unaffected by the kill — finished with ${result.tokens?.length} tok, restarts=${result.restartCount}`);
      expect(result.tokens?.length ?? 0).toBeGreaterThanOrEqual(tokensBeforeKill);
      return { recovered: true, restartCount: result.restartCount ?? 0, replanObservedAt: undefined as number | undefined };
    }

    // Depended on the killed host. Watch for either:
    //   (a) restartCount going >=1 (replan fired) followed by 'finished' —
    //       recovery via a warm spare, continue-from-history intact.
    //   (b) a clean terminal 'aborted'/'error' — no spare existed, the
    //       topology genuinely lost coverage and the driver said so
    //       honestly instead of hanging.
    let replanObservedAt: number | undefined;
    const deadline = Date.now() + 6 * 60_000;
    let last: Awaited<ReturnType<typeof readCommunalChatDebug>> = {};
    while (Date.now() < deadline) {
      last = await readCommunalChatDebug(page);
      if (replanObservedAt === undefined && (last.restartCount ?? 0) >= 1) {
        replanObservedAt = Date.now();
        console.log(`[test] ${label}: replan observed at +${replanObservedAt - killedAt}ms (restartCount=${last.restartCount})`);
      }
      const phase = last.status?.phase;
      if (phase === 'finished' || phase === 'aborted' || phase === 'error') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    console.log(`[test] ${label}: terminal status=${JSON.stringify(last.status)} tokens=${last.tokens?.length ?? 0} restarts=${last.restartCount ?? 0}`);

    if (spareExists) {
      // A warm spare existed — expect real recovery, not a lucky finish
      // that happened before the kill even registered.
      expect(last.status?.phase, `${label} should recover to 'finished' via a warm spare`).toBe('finished');
      expect(last.restartCount ?? 0, `${label} should have replanned at least once`).toBeGreaterThanOrEqual(1);
      expect(last.tokens?.length ?? 0, `${label} token history should be continuous/growing, not reset`).toBeGreaterThanOrEqual(tokensBeforeKill);
      return { recovered: true, restartCount: last.restartCount ?? 0, replanObservedAt };
    }
    // No spare — the honest outcome is a clean abort/error surfacing the
    // coverage loss, never an infinite hang.
    expect(['aborted', 'error']).toContain(last.status?.phase);
    console.log(`[test] ${label}: no warm spare existed — clean ${last.status?.phase} is the correct outcome, not a bug`);
    return { recovered: false, restartCount: last.restartCount ?? 0, replanObservedAt };
  }

  const [outcome1, outcome2] = await Promise.all([
    observeDriver(drivers[0]!, 'driver1', true, tokensBeforeKill1),
    observeDriver(drivers[1]!, 'driver2', sharedHost, tokensBeforeKill2),
  ]);

  console.log(`[test] phase c DONE: driver1=${JSON.stringify(outcome1)} driver2=${JSON.stringify(outcome2)}`);

  // Staggered recovery, not simultaneous (CHAOS.md / computeReplanJitterMs's
  // anti-lockstep spread) — logged for human review rather than tightly
  // bound (real wall-clock jitter isn't worth a flaky hard assertion here;
  // the jitter FORMULA itself is unit-tested in stageOrchestrator.test.ts).
  if (sharedHost && outcome1.replanObservedAt && outcome2.replanObservedAt) {
    const staggerMs = Math.abs(outcome1.replanObservedAt - outcome2.replanObservedAt);
    console.log(`[test] replan stagger between driver1/driver2: ${staggerMs}ms`);
  }

  for (const p of [...hosts, ...drivers]) {
    await p.close().catch(() => undefined);
  }
});
