/**
 * Fast plumbing check (no model load): two pages join an isolated room,
 * one enables "host stages", the other observes the `stageHost` cap show
 * up in its roster. Validates WebGPU feature-detect + cap publish +
 * roster propagation before the expensive full pipeline specs run.
 */
import { test, expect } from '@playwright/test';
import { joinDemo, randomRoomSuffix, readStageDebug, rosterStageHostPeerIds, setHostingEnabled, wirePageLogging } from './helpers.js';

test('discovery: a hosting-enabled peer publishes stageHost and another peer sees it in the roster', async ({ context }) => {
  test.setTimeout(60_000);
  const room = randomRoomSuffix();

  const driver = await context.newPage();
  wirePageLogging(driver, 'driver');
  await joinDemo(driver, room, 'driver');

  const host = await context.newPage();
  wirePageLogging(host, 'host1');
  await joinDemo(host, room, 'host1');

  const hostDebug = await readStageDebug(host);
  expect(hostDebug.host?.active, 'host should not be active before toggling').not.toBe(true);

  await setHostingEnabled(host, true);

  await host.waitForFunction(
    () => (window as unknown as { __legionStage?: { host?: { active?: boolean } } }).__legionStage?.host?.active === true,
    undefined,
    { timeout: 30_000, polling: 250 },
  );

  const finalHostDebug = await readStageDebug(host);
  expect(finalHostDebug.host?.active).toBe(true);

  for (let i = 0; i < 20; i++) {
    const snap = await readStageDebug(driver);
    // eslint-disable-next-line no-console
    console.log(`[test] driver roster snapshot #${i}:`, JSON.stringify(snap.roster));
    if ((snap.roster ?? []).length > 1) break;
    await driver.waitForTimeout(5000);
  }

  await expect
    .poll(async () => rosterStageHostPeerIds(driver), { timeout: 20_000, message: 'driver roster should see host1 stageHost cap' })
    .toEqual(expect.arrayContaining([finalHostDebug.selfId]));

  await driver.close();
  await host.close();
});
