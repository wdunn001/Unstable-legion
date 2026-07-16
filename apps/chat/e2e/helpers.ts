/**
 * Shared Playwright helpers for apps/chat's product e2e — drives the
 * REAL app UI (JoinScreen, hosting consent, trust interstitial, the
 * chat pane), not a test-only harness page. Mirrors
 * apps/demo/e2e/helpers.ts's idioms (page logging, debug-global
 * polling) adapted to this app's own selectors and its
 * `window.__legionChat` debug snapshot (see App.tsx's Dashboard).
 */
import { expect, type Page } from '@playwright/test';

export function wirePageLogging(page: Page, label: string): void {
  page.on('console', (msg) => {
    // eslint-disable-next-line no-console
    console.log(`[${label}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    // eslint-disable-next-line no-console
    console.error(`[${label} pageerror] ${err.message}`);
  });
  page.on('crash', () => {
    // eslint-disable-next-line no-console
    console.error(`[${label}] *** PAGE CRASHED (renderer process) ***`);
  });
  page.on('worker', (worker) => {
    // eslint-disable-next-line no-console
    console.log(`[${label}] worker SPAWNED -> ${worker.url()}`);
    worker.on('close', () => console.error(`[${label}] worker CLOSED -> ${worker.url()}`));
  });
  page.on('requestfailed', (req) => {
    // eslint-disable-next-line no-console
    console.error(`[${label}] request FAILED ${req.failure()?.errorText} -> ${req.url()}`);
  });
}

/** Navigate to the chat app in an isolated room, using the small
 * already-proven test model (`?testModel=1` — see chatModelSource.ts's
 * doc comment: Qwen3-8B's real shard bytes aren't fetchable in a dev/CI
 * box, no manifest deployed yet either). Joins via the real JoinScreen. */
export async function joinChat(page: Page, roomId: string, nick: string, extraQuery = ''): Promise<void> {
  await page.goto(`/?room=${encodeURIComponent(roomId)}&testModel=1${extraQuery}`);
  await page.locator('.join-nick-input').fill(nick);
  await page.locator('.join-submit').click();
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 30_000 });
}

export async function acceptHosting(page: Page): Promise<void> {
  await page.locator('.consent-accept').click();
}

export async function declineHosting(page: Page): Promise<void> {
  await page.locator('.consent-decline').click();
}

export interface ChatDebugSnapshot {
  selfId?: string;
  capacityPercent?: number;
  capacityReady?: boolean;
  chatStatus?: { phase: string; error?: string; reason?: string };
  chatText?: string;
  chatRestartCount?: number;
  threadCount?: number;
  activeThreadId?: string;
  trustModalOpen?: boolean;
  hostingConsent?: string;
  hostingActive?: boolean;
}

export async function readChatDebug(page: Page): Promise<ChatDebugSnapshot> {
  return page.evaluate(() => (window as unknown as { __legionChat?: ChatDebugSnapshot }).__legionChat ?? {});
}

export async function waitForHostingActive(page: Page, timeoutMs = 8 * 60_000): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __legionChat?: { hostingActive?: boolean } }).__legionChat?.hostingActive === true,
    undefined,
    { timeout: timeoutMs, polling: 500 },
  );
}

export async function waitForCapacityReady(page: Page, timeoutMs = 3 * 60_000): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __legionChat?: { capacityReady?: boolean } }).__legionChat?.capacityReady === true,
    undefined,
    { timeout: timeoutMs, polling: 500 },
  );
}

/** Fill the composer and hit Send. If the trust interstitial gates this
 * send (first message in the session, or a host-set change), acknowledge
 * it — the real product flow, not a bypass: `TrustInterstitial`'s
 * acknowledge button is what actually dispatches the queued message
 * (see App.tsx's `handleAcknowledge`). */
export async function sendChatMessage(page: Page, text: string): Promise<void> {
  await page.locator('.composer-input').fill(text);
  await page.locator('.composer-send').click();
  const ack = page.locator('.trust-interstitial-ack');
  if (await ack.isVisible().catch(() => false)) {
    await ack.click();
  }
}

export async function waitForChatFinished(page: Page, label: string, timeoutMs = 10 * 60_000): Promise<ChatDebugSnapshot> {
  await expect
    .poll(
      async () => {
        const d = await readChatDebug(page);
        const phase = d.chatStatus?.phase;
        if (phase === 'aborted' || phase === 'error') {
          // eslint-disable-next-line no-console
          console.log(`[test] ${label} terminal status=${JSON.stringify(d.chatStatus)}`);
          return `${phase}: ${JSON.stringify(d.chatStatus)}`;
        }
        return phase;
      },
      { timeout: timeoutMs, message: `${label} chat should reach finished` },
    )
    .toBe('finished');
  return readChatDebug(page);
}
