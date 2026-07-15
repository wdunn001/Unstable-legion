/**
 * Phase C workstream C3 COMPAT acceptance: a 4th peer joining with NO
 * `stageHost` cap (never toggled "host stages") must interoperate
 * normally — chat/roster are unaffected by Phase C's additive wire
 * fields (mesh-core's guards treat `stageHost` as optional; v1 peers
 * without it simply don't get planned onto).
 */
import { test, expect } from '@playwright/test';
import { joinDemo, readStageDebug, rosterStageHostPeerIds, setHostingEnabled, wirePageLogging } from './helpers.js';

test('compat: a peer without stageHost interoperates normally (roster/chat unaffected)', async ({ context }) => {
  test.setTimeout(90_000);
  const room = `c3-compat-${Date.now().toString(36)}`;

  const driver = await context.newPage();
  const hostA = await context.newPage();
  const plain = await context.newPage();
  wirePageLogging(driver, 'driver');
  wirePageLogging(hostA, 'hostA');
  wirePageLogging(plain, 'plain');

  await joinDemo(driver, room, 'driver');
  await joinDemo(hostA, room, 'hostA');
  await joinDemo(plain, room, 'plain-no-stagehost');

  await setHostingEnabled(hostA, true);

  // The stage-hosting peer's cap propagates to everyone, including the
  // plain (non-hosting) peer's own roster view.
  await expect
    .poll(async () => rosterStageHostPeerIds(driver), { timeout: 30_000 })
    .not.toEqual([]);
  await expect
    .poll(async () => rosterStageHostPeerIds(plain), { timeout: 30_000 })
    .not.toEqual([]);

  // The plain peer itself never advertises stageHost.
  const plainDebug = await readStageDebug(plain);
  expect(plainDebug.host?.active).not.toBe(true);
  const driverRoster = (await readStageDebug(driver)).roster ?? [];
  const plainEntry = driverRoster.find((r) => r.peerId === plainDebug.selfId);
  expect(plainEntry?.hasStageHost).toBe(false);

  // Ordinary chat still works between the plain peer and everyone else —
  // roster size reflects all 3 peers on every page (Phase C didn't
  // fragment the mesh into "stage-capable" vs "everyone else" rooms).
  for (const page of [driver, hostA, plain]) {
    await expect.poll(async () => (await readStageDebug(page)).roster?.length ?? 0, { timeout: 20_000 }).toBe(3);
  }

  await driver.close();
  await hostA.close();
  await plain.close();
});
