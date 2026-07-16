/**
 * apps/chat product smoke test — a lighter, product-level happy path.
 * The deep communal self-assembly/churn/recovery proof already lives in
 * apps/demo/e2e/communal.spec.ts (same underlying `useCommunalHost`/
 * `useCommunalChat` hooks, unmodified here); this spec instead proves
 * the THINGS THIS APP ADDS actually work end to end in a real browser:
 *
 *   1. Capacity gating — chat is genuinely unavailable until the mesh
 *      self-assembles 100% coverage, and the composer reflects that.
 *   2. The trust interstitial genuinely gates the first message (not a
 *      decoration) and its acknowledge button is what dispatches the
 *      queued send.
 *   3. A real streamed reply renders as Markdown in the chat pane.
 *   4. IndexedDB persistence survives a hard reload.
 *
 * Uses the `?testModel=1` escape hatch (see chatModelSource.ts) — the
 * same already-proven `qwen3-0.6b-q8_0` asset apps/demo's communal.spec.ts
 * drives real WebGPU inference against. Production targets Qwen3-8B;
 * that asset isn't fetchable in this dev/CI environment (no manifest
 * deployed yet either — see chatModelSource.ts's HONEST STATE note), so
 * this suite proves the APP's behavior against the real mesh protocol,
 * not the specific production model weights.
 */
import { test, expect } from '@playwright/test';
import {
  acceptHosting,
  declineHosting,
  joinChat,
  readChatDebug,
  sendChatMessage,
  waitForCapacityReady,
  waitForChatFinished,
  waitForHostingActive,
  wirePageLogging,
} from './helpers.js';

const GATE_TIMEOUT_MS = 20 * 60 * 1000;

test('product: capacity gate, trust interstitial, streamed markdown reply, reload persistence', async ({ context }) => {
  test.setTimeout(GATE_TIMEOUT_MS);
  const room = `chat-product-${Date.now().toString(36)}`;
  const browser = context.browser();
  if (!browser) throw new Error('requires a browser-backed context');

  const hostCtxs = [await browser.newContext(), await browser.newContext(), await browser.newContext()];
  const driverCtx = await browser.newContext();
  const hosts = await Promise.all(hostCtxs.map((c) => c.newPage()));
  const driver = await driverCtx.newPage();
  hosts.forEach((p, i) => wirePageLogging(p, `host${i + 1}`));
  wirePageLogging(driver, 'driver');

  // ── Driver joins first, alone — chat must be gated ────────────────
  await joinChat(driver, room, 'driver');
  // The model identity must be prominent, not buried — header pill first,
  // the capacity meter's model-named status line further down.
  await expect(driver.locator('.app-model-pill')).toContainText('Qwen3-0.6B');
  await expect(driver.locator('.capacity-status-line')).toContainText('Qwen3-0.6B');
  await expect(driver.locator('.trust-badge')).toBeVisible();
  await expect(driver.locator('.consent-banner')).toBeVisible();
  await declineHosting(driver); // driver doesn't need to contribute compute to prove the product flow
  await expect(driver.locator('.composer-input')).toBeDisabled();
  const gapSnapBefore = await readChatDebug(driver);
  expect(gapSnapBefore.capacityReady).toBeFalsy();
  console.log(`[test] driver alone: capacity=${gapSnapBefore.capacityPercent}% (expect gated)`);

  // ── 3 hosts self-assemble coverage from empty ─────────────────────
  await Promise.all(hosts.map((p, i) => joinChat(p, room, `host${i + 1}`)));
  for (const h of hosts) {
    await acceptHosting(h);
    // Small stagger avoids dog-piling simultaneous full.gguf fetches onto
    // vite preview's static file server in the same event-loop tick — see
    // apps/demo/e2e/communal.spec.ts's identical stagger for the same
    // reason. Does not fake coordination-free assembly: no host has
    // claimed/loaded anything yet when the stagger starts.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  await Promise.all(hosts.map((h) => waitForHostingActive(h, 8 * 60_000)));
  console.log('[test] all 3 hosts report active (claimed + loaded + warm + advertising)');

  // ── Driver's capacity meter should unlock ─────────────────────────
  await waitForCapacityReady(driver, 3 * 60_000);
  await expect(driver.locator('.composer-input')).toBeEnabled();
  const readySnap = await readChatDebug(driver);
  console.log(`[test] driver capacity ready: ${readySnap.capacityPercent}%`);

  // ── First message: trust interstitial must gate it ────────────────
  await driver.locator('.composer-input').fill('Name three colors.');
  await driver.locator('.composer-send').click();
  const interstitial = driver.locator('.trust-interstitial');
  await expect(interstitial).toBeVisible({ timeout: 10_000 });
  // Exact verbatim wording from docs/TRUST.md's canonical statement —
  // "readable by hosts", no hedging.
  await expect(interstitial).toContainText('readable by the room’s hosts');
  // The message must NOT have been sent yet — gated, not a decoration.
  await expect.poll(async () => (await readChatDebug(driver)).chatStatus?.phase).not.toBe('running');
  await driver.locator('.trust-interstitial-ack').click();
  await expect(interstitial).toBeHidden();

  // ── Reply streams and finishes ─────────────────────────────────────
  const result = await waitForChatFinished(driver, 'driver', 8 * 60_000);
  console.log(`[test] driver finished: restarts=${result.chatRestartCount} textLen=${result.chatText?.length}`);
  expect(result.chatText?.length ?? 0).toBeGreaterThan(0);

  // ── The reply rendered as an assistant bubble in the chat pane ─────
  const assistantBubbles = driver.locator('.msg-bubble-assistant');
  await expect(assistantBubbles.first()).toBeVisible();
  const renderedText = await assistantBubbles.first().innerText();
  expect(renderedText.trim().length).toBeGreaterThan(0);
  const userBubble = driver.locator('.msg-bubble-user').first();
  await expect(userBubble).toContainText('Name three colors.');

  // ── Reload: conversation persists (IndexedDB) ──────────────────────
  await driver.reload();
  await driver.locator('.join-nick-input').waitFor({ state: 'visible', timeout: 15_000 });
  // Nick persisted via localStorage (usePersona) — the join screen
  // pre-fills it; just re-submit to get back into the Dashboard.
  await driver.locator('.join-submit').click();
  await driver.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  await expect(driver.locator('.conversation-item').first()).toBeVisible({ timeout: 15_000 });
  await expect(driver.locator('.msg-bubble-user').first()).toContainText('Name three colors.', { timeout: 15_000 });
  await expect(driver.locator('.msg-bubble-assistant').first()).toBeVisible();
  console.log('[test] conversation persisted across reload');

  for (const p of [...hosts, driver]) {
    await p.close().catch(() => undefined);
  }
});
