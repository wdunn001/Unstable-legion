/**
 * runCommunalDriverSession unit tests — a MOCK transport (in-memory bus)
 * driving the `stage.session.open`/`accept`/`busy` handshake specifically
 * (M2's control kinds, wired to a driver for the first time in M3). Same
 * mock-mesh idiom as `stageOrchestrator.test.ts`'s legacy-path tests, but
 * the fake hosts speak session-open instead of stage.load.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommunalDriverSession, type CommunalRoute } from '../src/stageOrchestrator.ts';
import {
  decodeStageControl,
  encodeStageControl,
  makeStagePong,
  makeStageSessionAccept,
  makeStageSessionBusy,
  makeStageStop,
  makeStageToken,
  type StageControlMessage,
} from '../src/stageControl.ts';
import { decodeStageFrameEnvelope } from '../src/stageFrameEnvelope.ts';
import type { CommunalHostStageAd } from '../src/communalTopology.ts';
import type { MeshToolFrame } from '../src/types.ts';
import type { StagePlan } from '../src/stagePlanner.ts';

// ── Fake session-open host ──────────────────────────────────────────────

interface FakeSessionHost {
  peerId: string;
  isFinal: boolean;
  tokenFor: (seq: number) => number;
  /** How this host answers stage.session.open: 'accept' immediately,
   * 'busyThenAccept' (queues, then the eventual same-callId accept),
   * 'busyRejected' (queue itself full, never admits), or 'silent' (never
   * replies — simulates a dead/unreachable host so the driver falls
   * through to the next candidate on timeout). */
  openBehavior: 'accept' | 'busyThenAccept' | 'busyRejected' | 'silent';
  /** ms delay before the queued accept arrives, for busyThenAccept. */
  queuedAcceptDelayMs?: number;
  dieAtSeq?: number;
  gracefulStopAtSeq?: number;
  headerSeen: boolean;
  framesSeen: number;
  opensReceived: number;
}

function makeFakeSessionHost(peerId: string, overrides: Partial<FakeSessionHost> = {}): FakeSessionHost {
  return {
    peerId,
    isFinal: true,
    tokenFor: (seq) => 2000 + seq,
    openBehavior: 'accept',
    headerSeen: false,
    framesSeen: 0,
    opensReceived: 0,
    ...overrides,
  };
}

function createMockMesh(selfId: string) {
  const toolListeners = new Set<(frame: MeshToolFrame, peerId: string) => void>();
  const hosts = new Map<string, FakeSessionHost>();
  const sentTool: Array<{ frame: MeshToolFrame; peers?: string | string[] }> = [];
  let currentSessionId = '';

  function deliverToolToDriver(frame: MeshToolFrame, fromPeerId: string): void {
    for (const cb of toolListeners) cb(frame, fromPeerId);
  }
  function targetsOf(peers?: string | string[]): string[] {
    if (!peers) return [];
    return Array.isArray(peers) ? peers : [peers];
  }

  const peer = {
    selfId,
    async sendTool(frame: MeshToolFrame, peers?: string | string[]) {
      sentTool.push({ frame, peers });
      for (const targetId of targetsOf(peers)) {
        const host = hosts.get(targetId);
        if (!host) continue;
        const decoded = decodeStageControl(frame);
        if (!decoded) continue;
        if (decoded.kind === 'stage.ping') {
          currentSessionId = decoded.sessionId;
          const pong = makeStagePong(decoded.sessionId, decoded.payload.sentAtMs, decoded.callId);
          queueMicrotask(() => deliverToolToDriver(encodeStageControl(pong), targetId));
        } else if (decoded.kind === 'stage.session.open') {
          currentSessionId = decoded.sessionId;
          host.opensReceived += 1;
          if (host.openBehavior === 'accept') {
            const accept = makeStageSessionAccept(
              decoded.sessionId,
              { nEmbd: 8, isFirst: decoded.payload.layerStart === 0, isFinal: host.isFinal, activeSessions: 1, maxSessions: 4 },
              decoded.callId,
            );
            queueMicrotask(() => deliverToolToDriver(encodeStageControl(accept), targetId));
          } else if (host.openBehavior === 'busyThenAccept') {
            const busy = makeStageSessionBusy(decoded.sessionId, { queuePosition: 1 }, decoded.callId);
            queueMicrotask(() => deliverToolToDriver(encodeStageControl(busy), targetId));
            setTimeout(() => {
              const accept = makeStageSessionAccept(
                decoded.sessionId,
                { nEmbd: 8, isFirst: decoded.payload.layerStart === 0, isFinal: host.isFinal, activeSessions: 1, maxSessions: 4 },
                decoded.callId, // SAME callId as the original open — this is the real contract
              );
              deliverToolToDriver(encodeStageControl(accept), targetId);
            }, host.queuedAcceptDelayMs ?? 30);
          } else if (host.openBehavior === 'busyRejected') {
            const busy = makeStageSessionBusy(decoded.sessionId, {}, decoded.callId); // no queuePosition -> rejected outright
            queueMicrotask(() => deliverToolToDriver(encodeStageControl(busy), targetId));
          }
          // 'silent' -> no reply at all, driver's sendAndAwaitControl times out
        }
      }
    },
    onTool(cb: (frame: MeshToolFrame, peerId: string) => void) {
      toolListeners.add(cb);
      return () => toolListeners.delete(cb);
    },
    async sendStageFrame(bytes: Uint8Array, peers?: string | string[]) {
      for (const targetId of targetsOf(peers)) {
        const host = hosts.get(targetId);
        if (!host) continue;
        // M3 session-open origin: NO separate header sf frame — the very
        // first sf send is already a real prefill/decode frame. Verify
        // the envelope decodes and route by seq.
        const envelope = decodeStageFrameEnvelope(bytes);
        if (!envelope) continue;
        const seq = host.framesSeen;
        host.framesSeen += 1;
        if (host.dieAtSeq !== undefined && seq >= host.dieAtSeq) continue;
        if (host.gracefulStopAtSeq !== undefined && seq === host.gracefulStopAtSeq) {
          const stop = makeStageStop(currentSessionId, 'pagehide');
          queueMicrotask(() => deliverToolToDriver(encodeStageControl(stop), targetId));
          continue;
        }
        const token = host.tokenFor(seq);
        const msg = makeStageToken(currentSessionId, token, seq, false);
        queueMicrotask(() => deliverToolToDriver(encodeStageControl(msg), targetId));
      }
    },
    onStageFrame() {
      return () => undefined;
    },
  };

  return { peer, hosts, sentTool };
}

function makeMockLocalHooks(nEmbd = 8) {
  return {
    nEmbd,
    async tokenize(text: string) {
      return text.split(/\s+/).filter(Boolean).map((_, i) => 1 + i);
    },
    async detokenize(tokens: readonly number[]) {
      return tokens.join(',');
    },
    async reset() {},
    async prefill(tokens: readonly number[], _positions: readonly number[]) {
      return { activation: new Float32Array(Math.max(1, tokens.length) * nEmbd) };
    },
    async decode(_token: number) {
      return { activation: new Float32Array(nEmbd) };
    },
  };
}

function makeAd(peerId: string, overrides: Partial<CommunalHostStageAd> = {}): CommunalHostStageAd {
  return {
    peerId,
    modelId: 'm',
    layerStart: 2,
    layerEnd: 8,
    includeEmbeddings: false,
    includeOutput: true,
    ctxSize: 512,
    wireDtype: 'f32',
    maxSessions: 4,
    activeSessions: 0,
    epoch: 1,
    headroom: 4,
    stabilityScore: 1000,
    ...overrides,
  };
}

function routeFor(candidates: readonly CommunalHostStageAd[]): CommunalRoute {
  const plan: StagePlan = {
    modelId: 'm',
    totalLayers: 8,
    stages: [
      { stageIndex: 0, peerId: 'local', layerStart: 0, layerEnd: 2, isFirst: true, isFinal: false, capacityBytes: 0, assignedBytes: 0, cacheHitFraction: 0 },
      { stageIndex: 1, peerId: candidates[0]!.peerId, layerStart: 2, layerEnd: 8, isFirst: false, isFinal: true, capacityBytes: 0, assignedBytes: 0, cacheHitFraction: 0 },
    ],
    perTokenHopBytes: 32,
    unselectedPeerIds: [],
  };
  return { plan, attachOrder: new Map([[1, candidates]]) };
}

const FAST_TIMEOUTS = { pingMs: 200, loadMs: 200, bootstrapStepMs: 200, stepTimeoutFloorMs: 50 };

function collectEvents(handle: { on: (l: (ev: unknown) => void) => () => void }): unknown[] {
  const events: unknown[] = [];
  handle.on((ev) => events.push(ev));
  return events;
}

// ── Happy path: immediate accept ─────────────────────────────────────────

test('communal session-open: immediate accept completes the session, no header sf frame sent separately', async () => {
  const mesh = createMockMesh('driver');
  const hostA = makeFakeSessionHost('hostA');
  mesh.hosts.set('hostA', hostA);

  const handle = runCommunalDriverSession({
    peer: mesh.peer,
    route: routeFor([makeAd('hostA')]),
    modelId: 'm',
    prompt: 'hello world',
    maxDecodeTokens: 3,
    localHooks: makeMockLocalHooks(),
    replanRoute: () => null,
    timeouts: FAST_TIMEOUTS,
  });
  const events = collectEvents(handle);

  const result = await handle.result();
  assert.equal(result.aborted, false);
  assert.equal(hostA.opensReceived, 1);
  // 2 prompt tokens + 3 generated.
  assert.equal(result.tokens.length, 5);
  assert.ok((events as { type: string }[]).some((e) => e.type === 'stageReady'));
  assert.ok((events as { type: string }[]).some((e) => e.type === 'finished'));
});

// ── Busy with a queue position -> eventual accept on the SAME callId ────

test('communal session-open: busy+queued resolves via a LATER accept on the same callId', async () => {
  const mesh = createMockMesh('driver');
  const hostA = makeFakeSessionHost('hostA', { openBehavior: 'busyThenAccept', queuedAcceptDelayMs: 20 });
  mesh.hosts.set('hostA', hostA);

  const handle = runCommunalDriverSession({
    peer: mesh.peer,
    route: routeFor([makeAd('hostA')]),
    modelId: 'm',
    prompt: 'hi',
    maxDecodeTokens: 2,
    localHooks: makeMockLocalHooks(),
    replanRoute: () => null,
    timeouts: FAST_TIMEOUTS,
    queueWaitMs: 2000,
  });

  const result = await handle.result();
  assert.equal(result.aborted, false);
  assert.equal(hostA.opensReceived, 1); // only ONE open sent — no retry needed, the queue resolved
});

// ── Busy (queue full, rejected) -> falls through to the next candidate ──

test('communal session-open: busy-rejected candidate falls through to the next attach candidate', async () => {
  const mesh = createMockMesh('driver');
  const hostA = makeFakeSessionHost('hostA', { openBehavior: 'busyRejected' });
  const hostB = makeFakeSessionHost('hostB', { tokenFor: (seq) => 9000 + seq });
  mesh.hosts.set('hostA', hostA);
  mesh.hosts.set('hostB', hostB);

  const handle = runCommunalDriverSession({
    peer: mesh.peer,
    route: routeFor([makeAd('hostA'), makeAd('hostB')]),
    modelId: 'm',
    prompt: 'hi there',
    maxDecodeTokens: 2,
    localHooks: makeMockLocalHooks(),
    replanRoute: () => null,
    timeouts: FAST_TIMEOUTS,
  });
  const events = collectEvents(handle) as { type: string; peerId?: string }[];

  const result = await handle.result();
  assert.equal(result.aborted, false);
  assert.equal(hostA.opensReceived, 1);
  assert.equal(hostB.opensReceived, 1);
  assert.ok(events.some((e) => e.type === 'stageReady' && e.peerId === 'hostB'));
});

// ── A silent (dead) candidate times out and falls through too ──────────

test('communal session-open: a silent/unreachable candidate times out and falls through', async () => {
  const mesh = createMockMesh('driver');
  const hostA = makeFakeSessionHost('hostA', { openBehavior: 'silent' });
  const hostB = makeFakeSessionHost('hostB', { tokenFor: (seq) => 7000 + seq });
  mesh.hosts.set('hostA', hostA);
  mesh.hosts.set('hostB', hostB);

  const handle = runCommunalDriverSession({
    peer: mesh.peer,
    route: routeFor([makeAd('hostA'), makeAd('hostB')]),
    modelId: 'm',
    prompt: 'hi there',
    maxDecodeTokens: 2,
    localHooks: makeMockLocalHooks(),
    replanRoute: () => null,
    timeouts: FAST_TIMEOUTS,
  });

  const result = await handle.result();
  assert.equal(result.aborted, false);
  assert.equal(hostB.opensReceived, 1);
});

// ── Every candidate exhausted -> replanRoute is consulted ────────────────

test('communal session-open: every candidate busy-rejected -> triggers replanRoute', async () => {
  const mesh = createMockMesh('driver');
  const hostA = makeFakeSessionHost('hostA', { openBehavior: 'busyRejected' });
  const hostB = makeFakeSessionHost('hostB', { openBehavior: 'busyRejected' });
  const hostC = makeFakeSessionHost('hostC', { tokenFor: (seq) => 4000 + seq });
  mesh.hosts.set('hostA', hostA);
  mesh.hosts.set('hostB', hostB);
  mesh.hosts.set('hostC', hostC);

  let replanCalls = 0;
  const handle = runCommunalDriverSession({
    peer: mesh.peer,
    route: routeFor([makeAd('hostA'), makeAd('hostB')]),
    modelId: 'm',
    prompt: 'hi',
    maxDecodeTokens: 2,
    localHooks: makeMockLocalHooks(),
    replanRoute: () => {
      replanCalls++;
      return routeFor([makeAd('hostC')]);
    },
    timeouts: FAST_TIMEOUTS,
    replanJitterMs: 0,
  });

  const result = await handle.result();
  assert.equal(result.aborted, false);
  assert.equal(replanCalls, 1);
  assert.equal(hostC.opensReceived, 1);
});

// ── Host death mid-decode -> replan -> continue-from-history ────────────

test('communal session: host death mid-decode replans via replanRoute and preserves token history', async () => {
  const mesh = createMockMesh('driver');
  const hostA = makeFakeSessionHost('hostA', { dieAtSeq: 1 }); // dies after its first decode-step reply
  const hostB = makeFakeSessionHost('hostB', { tokenFor: (seq) => 6000 + seq });
  mesh.hosts.set('hostA', hostA);
  mesh.hosts.set('hostB', hostB);

  let replanCalls = 0;
  const handle = runCommunalDriverSession({
    peer: mesh.peer,
    route: routeFor([makeAd('hostA')]),
    modelId: 'm',
    prompt: 'hello world',
    maxDecodeTokens: 4,
    localHooks: makeMockLocalHooks(),
    replanRoute: (lostPeerId) => {
      replanCalls++;
      assert.equal(lostPeerId, 'hostA');
      return routeFor([makeAd('hostB')]);
    },
    timeouts: FAST_TIMEOUTS,
    replanJitterMs: 0,
  });

  const result = await handle.result();
  assert.equal(result.aborted, false);
  assert.equal(replanCalls, 1);
  assert.equal(result.restartCount, 1);
  assert.equal(result.tokens.length, 6); // 2 prompt + 4 generated
  const generated = result.tokens.slice(2);
  assert.equal(new Set(generated).size, 4); // no duplicate/corrupted tokens across the swap
});

// ── Graceful stage.stop -> instant replan ────────────────────────────────

test('communal session: graceful stage.stop triggers instant replan without waiting a long timeout', async () => {
  const mesh = createMockMesh('driver');
  const hostA = makeFakeSessionHost('hostA', { gracefulStopAtSeq: 1 });
  const hostB = makeFakeSessionHost('hostB', { tokenFor: (seq) => 8000 + seq });
  mesh.hosts.set('hostA', hostA);
  mesh.hosts.set('hostB', hostB);

  const startedAt = Date.now();
  const handle = runCommunalDriverSession({
    peer: mesh.peer,
    route: routeFor([makeAd('hostA')]),
    modelId: 'm',
    prompt: 'hi',
    maxDecodeTokens: 3,
    localHooks: makeMockLocalHooks(),
    replanRoute: () => routeFor([makeAd('hostB')]),
    timeouts: { pingMs: 5000, loadMs: 5000, bootstrapStepMs: 5000, stepTimeoutFloorMs: 5000 },
    replanJitterMs: 0,
  });

  const result = await handle.result();
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.aborted, false);
  assert.ok(elapsedMs < 2000, `expected fast replan, took ${elapsedMs}ms`);
});

// ── No eligible route -> clean abort ─────────────────────────────────────

test('communal session: replanRoute returning null after a death -> clean abort, no hang', async () => {
  const mesh = createMockMesh('driver');
  const hostA = makeFakeSessionHost('hostA', { dieAtSeq: 0 });
  mesh.hosts.set('hostA', hostA);

  const handle = runCommunalDriverSession({
    peer: mesh.peer,
    route: routeFor([makeAd('hostA')]),
    modelId: 'm',
    prompt: 'hi',
    maxDecodeTokens: 5,
    localHooks: makeMockLocalHooks(),
    replanRoute: () => null,
    timeouts: FAST_TIMEOUTS,
    replanJitterMs: 0,
  });
  const events = collectEvents(handle) as { type: string }[];

  const result = await handle.result();
  assert.equal(result.aborted, true);
  assert.ok(events.some((e) => e.type === 'aborted'));
  assert.ok(!events.some((e) => e.type === 'finished'));
});

// ── Natural finish notifies the host so it frees the lane ───────────────

test('communal session: natural finish sends stage.stop so the host frees its lane', async () => {
  const mesh = createMockMesh('driver');
  const hostA = makeFakeSessionHost('hostA');
  mesh.hosts.set('hostA', hostA);

  const handle = runCommunalDriverSession({
    peer: mesh.peer,
    route: routeFor([makeAd('hostA')]),
    modelId: 'm',
    prompt: 'hi',
    maxDecodeTokens: 2,
    localHooks: makeMockLocalHooks(),
    replanRoute: () => null,
    timeouts: FAST_TIMEOUTS,
  });

  await handle.result();
  const stopSent = mesh.sentTool.some((s) => {
    const d = decodeStageControl(s.frame);
    return d?.kind === 'stage.stop' && (Array.isArray(s.peers) ? s.peers.includes('hostA') : s.peers === 'hostA');
  });
  assert.ok(stopSent, 'expected a stage.stop sent to hostA on natural finish');
});

// ── external abort() ──────────────────────────────────────────────────────

test('communal session: external abort() cleanly finishes with partial history intact', async () => {
  const mesh = createMockMesh('driver');
  const hostA = makeFakeSessionHost('hostA');
  mesh.hosts.set('hostA', hostA);

  const handle = runCommunalDriverSession({
    peer: mesh.peer,
    route: routeFor([makeAd('hostA')]),
    modelId: 'm',
    prompt: 'hi',
    maxDecodeTokens: 1000,
    localHooks: makeMockLocalHooks(),
    replanRoute: () => null,
    timeouts: FAST_TIMEOUTS,
  });

  handle.abort('caller cancelled');

  const result = await handle.result();
  assert.equal(result.aborted, true);
  assert.equal(result.abortReason, 'caller cancelled');
});
