/**
 * Mobile layout smoke (chromium-mobile project, Pixel 7 viewport) —
 * asserts the collapse-strip structure that makes the app usable on a
 * phone: chat pane is the primary full-height surface, both sidebars are
 * one-line strips, the header wraps instead of overflowing, and nothing
 * forces horizontal scroll. Runs against `?testModel=1` via the shared
 * joinChat helper; no stage/model load is required for layout assertions.
 */
import { test, expect } from '@playwright/test';
import { joinChat, wirePageLogging } from './helpers.js';

const room = `mobile-smoke-${Date.now().toString(36)}`;

test('mobile: chat-first collapse-strip layout, no horizontal overflow', async ({ page }) => {
  wirePageLogging(page, 'mobile');
  await joinChat(page, room, 'mobile-tester');

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();

  // 1. No horizontal overflow anywhere.
  const scrollWidth = await page.evaluate(() => document.scrollingElement?.scrollWidth ?? 0);
  expect(scrollWidth).toBeLessThanOrEqual(viewport!.width);

  // 2. Both sidebars are collapsed strips by default (~one line).
  const chatStripBox = await page.locator('.conversation-sidebar .sidebar-toggle').boundingBox();
  expect(chatStripBox).not.toBeNull();
  const listBody = page.locator('.conversation-list-body');
  await expect(listBody).toHaveClass(/conversation-list-body-collapsed/);
  const meshSidebar = page.locator('.mesh-sidebar');
  await expect(meshSidebar).toHaveClass(/mesh-sidebar-collapsed/);
  const meshBox = await meshSidebar.boundingBox();
  expect(meshBox!.height).toBeLessThanOrEqual(48);

  // 3. Composer is visible INSIDE the viewport (the whole point of the
  // chat-first layout + dvh fix).
  const composerBox = await page.locator('.composer-input').boundingBox();
  expect(composerBox).not.toBeNull();
  expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(viewport!.height + 1);

  // 4. Conversation strip expands and collapses on tap.
  await page.locator('.conversation-sidebar .sidebar-toggle').click();
  await expect(listBody).not.toHaveClass(/conversation-list-body-collapsed/);
  await page.locator('.conversation-sidebar .sidebar-toggle').click();
  await expect(listBody).toHaveClass(/conversation-list-body-collapsed/);

  // 5. Header wraps to at most ~2 condensed lines.
  const headerBox = await page.locator('.app-header').boundingBox();
  expect(headerBox!.height).toBeLessThanOrEqual(70);
});
