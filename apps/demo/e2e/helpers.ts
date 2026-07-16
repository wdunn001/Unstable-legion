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

/** Navigate to the demo with an isolated room + nick, join via PersonaForm.
 * `extraQuery` appends additional `&key=value` query params (e.g.
 * `&spreadWidth=1` — see communal.spec.ts) without disturbing every
 * existing 3-arg call site. */
export async function joinDemo(page: Page, roomId: string, nick: string, extraQuery = ''): Promise<void> {
  await page.goto(`/?room=${encodeURIComponent(roomId)}&nochat=1${extraQuery}`);
  await page.locator('#ul-nick').fill(nick);
  await page.locator('button[type="submit"]').click();
  await page.locator('.ul-app').waitFor({ state: 'visible', timeout: 30_000 });
}

/** Toggle this page's "host stages" checkbox in the StagePipelinePanel. */
export async function setHostingEnabled(page: Page, enabled: boolean): Promise<void> {
  const checkbox = page.locator('.stage-host-toggle input[type="checkbox"]');
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
  host?: {
    active: boolean;
    sessions?: { sessionId: string; driverPeerId: string; layerStart: number; layerEnd: number; decodedCount: number }[];
    tokensDecoded: number;
    maxSessions?: number;
    queueLength?: number;
    lastError?: string;
  };
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

/** Fill the prompt box and click "run split inference" — does not await
 * completion, so callers can kick off two drivers back-to-back and poll
 * both concurrently (see multi-session-host.spec.ts). */
export async function runSplitInference(page: Page, prompt: string): Promise<void> {
  await page.locator('.stage-pipeline-prompt').fill(prompt);
  await page.locator('.sp-run-row button', { hasText: 'run split inference' }).click();
}

/** Poll a driver page's `pipeline.status.phase` until it reaches
 * 'finished'. Mirrors pipeline-split.spec.ts's polling idiom — returns a
 * distinctive string on abort/error (rather than throwing) so a failed
 * run's status/reason shows up in the assertion diff instead of just
 * "expected finished, got aborted". */
export async function waitForPipelineFinished(page: Page, label: string, timeoutMs = 10 * 60_000): Promise<DebugStageSnapshot> {
  await expect
    .poll(
      async () => {
        const d = await readStageDebug(page);
        const s = d.pipeline?.status;
        if (s?.phase === 'aborted' || s?.phase === 'error') {
          // eslint-disable-next-line no-console
          console.log(`[test] ${label} terminal status=${JSON.stringify(s)} tokens=${d.pipeline?.tokens?.length ?? 0}`);
          return s.phase === 'aborted' ? `aborted: ${JSON.stringify(s)}` : `error: ${JSON.stringify(s)}`;
        }
        return s?.phase;
      },
      { timeout: timeoutMs, message: `${label} pipeline should reach finished` },
    )
    .toBe('finished');
  return readStageDebug(page);
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

export interface PeerMeshOptions {
  /** Number of stage-hosting peers besides the driver. Mainline is 2
   * (one active remote + one hot spare); casefile test 2's "2-pages-
   * no-spare variant" uses 1. */
  hostCount: 1 | 2;
  /** 'separate' = one BrowserContext per peer (current mainline shape,
   * real-machine-like, each peer its own renderer). 'shared' = every
   * page in ONE BrowserContext (== ONE renderer process) — the shape
   * every legion-stage-runtime harness control (p2p.spec, parity page)
   * actually runs under. Casefile test 2: revert to 'shared' and
   * compare against mainline's 'separate'. */
  contextMode: 'separate' | 'shared';
}

export interface PeerMesh {
  driver: Page;
  hosts: Page[];
  hostSelfIds: string[];
}

/**
 * Generalized version of `setupThreePeerMesh` — parameterized over host
 * count and context-sharing so casefile test 2 (multi-page/context
 * dimension) can flip ONE variable at a time against the same real demo
 * UI flow the mainline spec drives, instead of a synthetic stand-in.
 */
export async function setupPeerMesh(context: BrowserContext, room: string, opts: PeerMeshOptions): Promise<PeerMesh> {
  const browser = context.browser();
  if (!browser) throw new Error('setupPeerMesh requires a browser-backed context');

  const contexts: BrowserContext[] = [];
  const nextContext = async (): Promise<BrowserContext> => {
    if (opts.contextMode === 'shared') {
      if (contexts.length === 0) contexts.push(await browser.newContext());
      return contexts[0]!;
    }
    const ctx = await browser.newContext();
    contexts.push(ctx);
    return ctx;
  };

  const driverCtx = await nextContext();
  const driver = await driverCtx.newPage();
  wirePageLogging(driver, 'driver');
  await joinDemo(driver, room, 'driver');

  const hosts: Page[] = [];
  const hostSelfIds: string[] = [];
  for (let i = 0; i < opts.hostCount; i++) {
    const label = opts.hostCount === 1 ? 'host' : i === 0 ? 'hostA' : 'hostB';
    const hostCtx = await nextContext();
    const host = await hostCtx.newPage();
    wirePageLogging(host, label);
    await joinDemo(host, room, label);
    await setHostingEnabled(host, true);
    await waitForHostActive(host);
    hosts.push(host);
    hostSelfIds.push((await readStageDebug(host)).selfId!);
  }

  await expect(
    async () => {
      const ids = await rosterStageHostPeerIds(driver);
      for (const id of hostSelfIds) {
        if (!ids.includes(id)) throw new Error(`driver roster missing host ${id}: has ${JSON.stringify(ids)}`);
      }
    },
  ).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] });

  return { driver, hosts, hostSelfIds };
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

// ── M3/M4 communal pipeline helpers (communal.spec.ts) ──────────────────

/** Toggle this page's "contribute to communal pipeline" checkbox in
 * `CommunalHostPanel` — distinct from `setHostingEnabled` (the LEGACY
 * `StagePipelinePanel` toggle), which now renders alongside it on every
 * page (see `stage-host-toggle` vs `communal-host-toggle`). */
export async function setCommunalHostEnabled(page: Page, enabled: boolean): Promise<void> {
  const checkbox = page.locator('.communal-host-toggle input[type="checkbox"]');
  const isChecked = await checkbox.isChecked();
  if (isChecked !== enabled) await checkbox.click();
}

/** Wait until `window.__legionCommunal.communal.active` is true (claimed
 * stage loaded, warmed, and advertised). */
export async function waitForCommunalHostActive(page: Page, timeoutMs = 8 * 60_000): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __legionCommunal?: { communal?: { active?: boolean } } }).__legionCommunal?.communal?.active === true,
    undefined,
    { timeout: timeoutMs, polling: 500 },
  );
}

export interface DebugCommunalLoadedStage {
  modelId: string;
  layerStart: number;
  layerEnd: number;
  includeOutput?: boolean;
  activeSessions?: number;
  maxSessions?: number;
}

export interface DebugCommunalSnapshot {
  selfId?: string;
  roster?: { peerId: string; loadedStages: DebugCommunalLoadedStage[] }[];
  communal?: {
    supported: boolean;
    unsupportedReason?: string;
    phase: string;
    claim?: { layerStart: number; layerEnd: number; includeOutput: boolean };
    active: boolean;
    sessions: { sessionId: string; driverPeerId: string; layerStart: number; layerEnd: number; decodedCount: number }[];
    tokensDecoded: number;
    maxSessions: number;
    queueLength: number;
    lastError?: string;
  };
}

export async function readCommunalDebug(page: Page): Promise<DebugCommunalSnapshot> {
  return page.evaluate(() => (window as unknown as { __legionCommunal?: DebugCommunalSnapshot }).__legionCommunal ?? {});
}

export interface DebugCommunalChatSnapshot {
  selfId?: string;
  status?: { phase: string; error?: string; reason?: string };
  plan?: {
    stages: { stageIndex: number; peerId: string; layerStart: number; layerEnd: number; isFinal: boolean }[];
    hotSparePeerId?: string;
  };
  tokens?: number[];
  text?: string;
  restartCount?: number;
  readyStageIndexes?: number[];
}

export async function readCommunalChatDebug(page: Page): Promise<DebugCommunalChatSnapshot> {
  return page.evaluate(() => (window as unknown as { __legionCommunalChat?: DebugCommunalChatSnapshot }).__legionCommunalChat ?? {});
}

/** Fill the prompt box and click "run communal chat" — does not await
 * completion (same non-blocking idiom as `runSplitInference`, so two
 * drivers can be kicked off back-to-back for genuine concurrency). */
export async function runCommunalChat(page: Page, prompt: string): Promise<void> {
  await page.locator('.communal-chat-prompt').fill(prompt);
  await page.locator('.communal-chat-run').click();
}

/** Poll a driver page's communal-chat `status.phase` until it reaches
 * 'finished'. Same abort/error-surfacing idiom as `waitForPipelineFinished`. */
export async function waitForCommunalChatFinished(page: Page, label: string, timeoutMs = 10 * 60_000): Promise<DebugCommunalChatSnapshot> {
  await expect
    .poll(
      async () => {
        const d = await readCommunalChatDebug(page);
        const s = d.status;
        if (s?.phase === 'aborted' || s?.phase === 'error') {
          // eslint-disable-next-line no-console
          console.log(`[test] ${label} terminal status=${JSON.stringify(s)} tokens=${d.tokens?.length ?? 0} restarts=${d.restartCount ?? 0}`);
          return s.phase === 'aborted' ? `aborted: ${JSON.stringify(s)}` : `error: ${JSON.stringify(s)}`;
        }
        return s?.phase;
      },
      { timeout: timeoutMs, message: `${label} communal chat should reach finished` },
    )
    .toBe('finished');
  return readCommunalChatDebug(page);
}
