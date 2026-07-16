/**
 * apps/chat user-to-user room chat e2e — proves the NEW human chat surface
 * works end to end across real browser tabs over the real mesh, and that
 * its three guarantees hold live:
 *
 *   1. Peers in a room exchange text messages that render on every peer
 *      (the Room tab, distinct from the AI Assistant pane).
 *   2. Compression is exercised on the wire — a sender's on-wire bytes are
 *      strictly fewer than the raw msgpack bytes (dict-deflate).
 *   3. Anti-flood throttling — a single peer hammering the room past its
 *      standing-gated burst is throttled (most sends rejected), and the
 *      room does NOT receive the whole flood.
 *
 * Unlike product.spec.ts this needs NO model / WebGPU / capacity: the room
 * chat is independent of the AI pipeline, so peers just join and talk. That
 * keeps this suite fast — only real Trystero MQTT peer discovery is
 * exercised (the same discovery product.spec.ts already relies on).
 */
import { test, expect, type Page } from '@playwright/test';
import { joinChat, declineHosting, wirePageLogging } from './helpers.js';

const TIMEOUT_MS = 4 * 60 * 1000;

interface RoomSnapshot {
  tab?: string;
  selfId?: string;
  messageCount?: number;
  texts?: string[];
  stats?: {
    framesSent: number;
    rawBytesSent: number;
    wireBytesSent: number;
    ratio: number;
    droppedFlood: number;
    droppedDup: number;
    droppedDecode: number;
  };
}

async function readRoom(page: Page): Promise<RoomSnapshot> {
  return page.evaluate(() => (window as unknown as { __legionRoomChat?: RoomSnapshot }).__legionRoomChat ?? {});
}

async function openRoomTab(page: Page): Promise<void> {
  await page.locator('.chat-tab', { hasText: 'Room' }).click();
  await expect(page.locator('[data-testid="room-chat"]')).toBeVisible();
}

async function sendRoomMessage(page: Page, text: string): Promise<void> {
  await page.locator('.room-composer-input').fill(text);
  await page.locator('.room-composer-send').click();
}

/** Fire N sends as fast as the hook allows, straight through the real
 * `useUserChat.send` (bypassing the composer's one-at-a-time cadence) so
 * the outbound rate limiter is actually stressed. Returns the tally. */
async function floodRoom(page: Page, n: number): Promise<Record<string, number>> {
  return page.evaluate(async (count) => {
    const send = (window as unknown as { __legionRoomChatSend?: (t: string) => Promise<string> }).__legionRoomChatSend;
    const tally: Record<string, number> = {};
    if (!send) return tally;
    for (let i = 0; i < count; i++) {
      const kind = await send(`flood ${i}`);
      tally[kind] = (tally[kind] ?? 0) + 1;
    }
    return tally;
  }, n);
}

test('room chat: two peers exchange compressed messages; a flood is throttled', async ({ context }) => {
  test.setTimeout(TIMEOUT_MS);
  const room = `chat-room-${Date.now().toString(36)}`;
  const browser = context.browser();
  if (!browser) throw new Error('requires a browser-backed context');

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const alice = await ctxA.newPage();
  const bob = await ctxB.newPage();
  wirePageLogging(alice, 'alice');
  wirePageLogging(bob, 'bob');

  // ── Both join the same room (no hosting needed — room chat is
  //    independent of the AI capacity pipeline). ─────────────────────
  await joinChat(alice, room, 'alice');
  await joinChat(bob, room, 'bob');
  await declineHosting(alice);
  await declineHosting(bob);

  await openRoomTab(alice);
  await openRoomTab(bob);

  // ── Wait until each sees the other in the People roster (peers
  //    discovered over the real mesh). ────────────────────────────────
  await expect(alice.locator('.room-person-nick', { hasText: 'bob' })).toBeVisible({ timeout: 90_000 });
  await expect(bob.locator('.room-person-nick', { hasText: 'alice' })).toBeVisible({ timeout: 90_000 });
  console.log('[test] alice and bob discovered each other');

  // ── 1. Alice → Bob ────────────────────────────────────────────────
  await sendRoomMessage(alice, 'hey bob, on my way');
  await expect(bob.locator('.room-msg-text', { hasText: 'hey bob, on my way' })).toBeVisible({ timeout: 60_000 });
  // And it echoes locally for Alice too.
  await expect(alice.locator('.room-msg-text', { hasText: 'hey bob, on my way' })).toBeVisible();
  console.log('[test] alice → bob delivered + rendered');

  // ── 2. Bob → Alice ────────────────────────────────────────────────
  await sendRoomMessage(bob, 'sounds good to me');
  await expect(alice.locator('.room-msg-text', { hasText: 'sounds good to me' })).toBeVisible({ timeout: 60_000 });
  console.log('[test] bob → alice delivered + rendered');

  // ── Compression exercised on the wire (dict-deflate) ──────────────
  const aliceStats = (await readRoom(alice)).stats!;
  console.log(`[test] alice wire stats: ${JSON.stringify(aliceStats)}`);
  expect(aliceStats.framesSent).toBeGreaterThan(0);
  expect(aliceStats.wireBytesSent).toBeGreaterThan(0);
  expect(aliceStats.wireBytesSent).toBeLessThan(aliceStats.rawBytesSent);
  expect(aliceStats.ratio).toBeLessThan(1);

  // ── 3. Flood control: Bob hammers the room; the outbound rate limiter
  //    throttles most of it, and Alice does NOT receive the whole flood.
  const bobBeforeFlood = (await readRoom(bob)).stats!.framesSent;
  const aliceCountBefore = (await readRoom(alice)).messageCount ?? 0;
  const tally = await floodRoom(bob, 20);
  console.log(`[test] flood tally: ${JSON.stringify(tally)}`);
  expect(tally.throttled ?? 0).toBeGreaterThan(0); // the limiter kicked in
  const bobSentDuringFlood = (await readRoom(bob)).stats!.framesSent - bobBeforeFlood;
  expect(bobSentDuringFlood).toBeLessThan(20); // most of the flood never left Bob's tab

  // Alice receives at most what Bob actually sent — the flood was capped,
  // not delivered wholesale.
  await alice.waitForTimeout(5_000);
  const aliceCountAfter = (await readRoom(alice)).messageCount ?? 0;
  const aliceGained = aliceCountAfter - aliceCountBefore;
  console.log(`[test] bob emitted ${bobSentDuringFlood} of 20; alice gained ${aliceGained}`);
  expect(aliceGained).toBeLessThan(20);
  expect(aliceGained).toBeLessThanOrEqual(bobSentDuringFlood);

  for (const p of [alice, bob]) await p.close().catch(() => undefined);
});
