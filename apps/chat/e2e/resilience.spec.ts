/**
 * apps/chat resilience e2e — proves the app reacts to a hosting/load
 * failure GRACEFULLY (Part A) instead of the observed live symptom (a
 * silent spinner + a tight per-tick retry loop hammering a failing fetch).
 *
 * A single host joins with `?testModel=1&badShard=1` (see chatModelSource.ts)
 * — its claimed stage points at a shard URL that 404s, so the worker load
 * deterministically fails. We then assert:
 *
 *   1. The failure is SURFACED — a visible host-error card appears (never a
 *      silent spinner) with model-named, human copy.
 *   2. The retry loop is BOUNDED — over a ~30s window the attempt count
 *      stays small (exponential backoff), not the hundreds/thousands a
 *      tight per-tick loop would produce.
 *
 * Reuses the same build+preview/globalSetup infra as product.spec.ts. This
 * is a single-context test (no successful assembly needed — we're proving
 * the FAILURE path), so it's fast relative to the full-assembly smoke.
 */
import { test, expect } from '@playwright/test';
import { acceptHosting, joinChat, readChatDebug, wirePageLogging } from './helpers.js';

const TEST_TIMEOUT_MS = 4 * 60 * 1000;

test('resilience: a bad shard surfaces a host-error card and backs off (bounded retries, no tight loop)', async ({ context }) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  const room = `chat-resilience-${Date.now().toString(36)}`;
  const browser = context.browser();
  if (!browser) throw new Error('requires a browser-backed context');

  const hostCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  wirePageLogging(host, 'badhost');

  // Join as a host pointed at a deliberately-404 shard URL.
  await joinChat(host, room, 'badhost', '&badShard=1');
  await acceptHosting(host);

  // ── 1. The failure is surfaced in the UI (not a silent spinner) ───────
  // The host claims its range, tries to load the bad shard, fails, and the
  // hosting panel shows a host-error card. Give it generous headroom for
  // WebGPU warm-up + the first failing fetch.
  await expect(host.locator('.host-error-card')).toBeVisible({ timeout: 90_000 });
  const cardText = await host.locator('.host-error-message').innerText();
  console.log(`[test] host-error card: "${cardText}"`);
  expect(cardText.toLowerCase()).toMatch(/load|host|retry|fail/);

  const errSnap = await readChatDebug(host);
  expect(errSnap.hostingError).toBeTruthy();
  expect(['retrying', 'error']).toContain(errSnap.hostingPhase);
  console.log(`[test] hosting phase=${errSnap.hostingPhase} attempt=${errSnap.hostingRetryAttempt}`);

  // ── 2. Retries are BOUNDED by backoff, not a tight loop ───────────────
  const attemptAtStart = (await readChatDebug(host)).hostingRetryAttempt ?? 0;
  const WINDOW_MS = 45_000;
  await host.waitForTimeout(WINDOW_MS);
  const attemptAfter = (await readChatDebug(host)).hostingRetryAttempt ?? 0;
  const delta = attemptAfter - attemptAtStart;
  console.log(`[test] retry attempts over ${WINDOW_MS / 1000}s: ${attemptAtStart} -> ${attemptAfter} (delta ${delta})`);
  // The loop IS still retrying (not silently stuck / given up entirely) —
  // each failing load takes ~10-20s of real WebGPU warm-up + fetch, so a
  // healthy backoff yields a couple attempts in this window.
  expect(delta).toBeGreaterThanOrEqual(1);
  // …but it's BOUNDED: exponential backoff (2s→4s→8s→…) produces a handful
  // of attempts. The bug we fixed — a tight per-tick loop — would produce
  // dozens–hundreds/second. Anything in single digits proves backoff.
  expect(delta).toBeLessThan(12);

  // Still failing (bad shard never resolves) → card still present, honest.
  await expect(host.locator('.host-error-card')).toBeVisible();

  for (const p of [host]) await p.close().catch(() => undefined);
});
