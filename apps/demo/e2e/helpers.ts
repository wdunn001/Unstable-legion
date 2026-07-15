/**
 * Shared Playwright helpers for the Phase C pipeline-split e2e specs.
 * Drives the REAL demo UI (PersonaForm join flow, Dashboard, the
 * StagePipelinePanel toggle/prompt/run controls) rather than a
 * test-only harness page — this is the actual app, not a stand-in.
 */
import { expect, type BrowserContext, type Page } from '@playwright/test';

export function randomRoomSuffix(): string {
  return `c3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

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
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      // eslint-disable-next-line no-console
      console.log(`[${label}] main frame navigated -> ${frame.url()}`);
    }
  });
  // Workers die silently by default: pipe their lifecycle + console so a
  // stage worker that throws during module init is visible in test output.
  page.on('worker', (worker) => {
    // eslint-disable-next-line no-console
    console.log(`[${label}] worker SPAWNED -> ${worker.url()}`);
    worker.on('close', () => console.error(`[${label}] worker CLOSED -> ${worker.url()}`));
  });
  // Route stage-worker console output through the page logger — a worker that
  // throws during wasm/model init otherwise dies with its logs unseen.
  page.on('console', (msg) => {
    const loc = msg.location()?.url ?? '';
    if (loc.includes('stageWorker')) {
      // eslint-disable-next-line no-console
      console.log(`[${label} stage-worker] ${msg.text()}`);
    }
  });
  page.on('requestfailed', (req) => {
    // eslint-disable-next-line no-console
    console.error(`[${label}] request FAILED ${req.failure()?.errorText} -> ${req.url()}`);
  });
  page.on('websocket', (ws) => {
    // eslint-disable-next-line no-console
    console.log(`[${label}] WS open -> ${ws.url()}`);
    ws.on('close', () => console.log(`[${label}] WS closed -> ${ws.url()}`));
    ws.on('socketerror', (err) => console.log(`[${label}] WS error -> ${ws.url()}: ${err}`));
  });
}

/** Navigate to the demo with an isolated room + nick, join via PersonaForm. */
export async function joinDemo(page: Page, roomId: string, nick: string): Promise<void> {
  await page.goto(`/?room=${encodeURIComponent(roomId)}&nochat=1`);
  await page.locator('#ul-nick').fill(nick);
  await page.locator('button[type="submit"]').click();
  await page.locator('.ul-app').waitFor({ state: 'visible', timeout: 30_000 });
}

/** Toggle this page's "host stages" checkbox in the StagePipelinePanel. */
export async function setHostingEnabled(page: Page, enabled: boolean): Promise<void> {
  const checkbox = page.locator('.sp-host-toggle input[type="checkbox"]');
  const isChecked = await checkbox.isChecked();
  if (isChecked !== enabled) await checkbox.click();
}

/** Wait until `window.__legionStage.host.active` is true (cap published). */
export async function waitForHostActive(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __legionStage?: { host?: { active?: boolean } } }).__legionStage?.host?.active === true,
    undefined,
    { timeout: timeoutMs, polling: 250 },
  );
}

export interface DebugStageSnapshot {
  selfId?: string;
  roster?: { peerId: string; hasStageHost: boolean; nick: string }[];
  host?: { active: boolean; session?: unknown; tokensDecoded: number; lastError?: string };
  pipeline?: {
    status: { phase: string; error?: string; reason?: string };
    plan?: {
      stages: { stageIndex: number; peerId: string; layerStart: number; layerEnd: number; isFinal: boolean }[];
      hotSparePeerId?: string;
    };
    tokens: number[];
    text: string;
    tpotMs?: number;
    restartCount: number;
    readyStageIndexes: number[];
  };
}

export async function readStageDebug(page: Page): Promise<DebugStageSnapshot> {
  return page.evaluate(() => (window as unknown as { __legionStage?: DebugStageSnapshot }).__legionStage ?? {});
}

/** Roster peerIds (excluding self) that currently advertise a `stageHost` cap. */
export async function rosterStageHostPeerIds(page: Page): Promise<string[]> {
  const snap = await readStageDebug(page);
  return (snap.roster ?? []).filter((r) => r.hasStageHost && r.peerId !== snap.selfId).map((r) => r.peerId);
}

export interface ThreePeerMesh {
  driver: Page;
  hostA: Page;
  hostB: Page;
  hostASelfId: string;
  hostBSelfId: string;
}

/**
 * Join 3 pages to one isolated room: driver + two hosting-enabled stage
 * hosts. Waits until the driver's roster sees BOTH `stageHost` caps
 * before returning, so callers start from "discovery complete."
 */
export async function setupThreePeerMesh(context: BrowserContext, room: string): Promise<ThreePeerMesh> {
  // One CONTEXT (= one renderer process) per peer. Same-origin pages in a
  // shared context share a renderer, and its memory budget with it: with two
  // ~1.3 GB stage workers, whichever loads second gets OOM-killed by Chrome
  // with no ErrorEvent (root-caused in the run-8 timeline: perfectly
  // serialized loads, second stage worker dies right after device init).
  // Separate contexts also model reality — real peers are separate machines.
  const browser = context.browser();
  if (!browser) throw new Error('setupThreePeerMesh requires a browser-backed context');
  const driverCtx = await browser.newContext();
  const hostACtx = await browser.newContext();
  const hostBCtx = await browser.newContext();
  const driver = await driverCtx.newPage();
  const hostA = await hostACtx.newPage();
  const hostB = await hostBCtx.newPage();
  wirePageLogging(driver, 'driver');
  wirePageLogging(hostA, 'hostA');
  wirePageLogging(hostB, 'hostB');

  await joinDemo(driver, room, 'driver');
  await joinDemo(hostA, room, 'hostA');
  await joinDemo(hostB, room, 'hostB');

  await setHostingEnabled(hostA, true);
  await setHostingEnabled(hostB, true);
  await waitForHostActive(hostA);
  await waitForHostActive(hostB);

  const hostASelfId = (await readStageDebug(hostA)).selfId!;
  const hostBSelfId = (await readStageDebug(hostB)).selfId!;

  await expect(
    async () => {
      const ids = await rosterStageHostPeerIds(driver);
      if (!ids.includes(hostASelfId) || !ids.includes(hostBSelfId)) {
        throw new Error(`driver roster missing hosts: has ${JSON.stringify(ids)}, want [${hostASelfId}, ${hostBSelfId}]`);
      }
    },
  ).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] });

  return { driver, hostA, hostB, hostASelfId, hostBSelfId };
}
