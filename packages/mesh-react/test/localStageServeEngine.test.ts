/**
 * localStageServeEngine unit tests — REUSE-STAGE0 Phase 1's ADOPTED-mode
 * serving core. No React, no real StageWorkerClient/Peer — a fake client
 * that also tracks `load`/`dispose`/`reset` calls (methods
 * `ServedStageClient` doesn't even declare, but a REAL `StageWorkerClient`
 * has them, so this is an empirical guard against a future refactor
 * accidentally reaching for them despite the narrower type) and a fake
 * mesh peer that records `sendTool`/`sendStageFrame` calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeStageControl, type StageSessionOpenPayload } from '@unstable-legion/core';
import {
  createLocalStageServeEngine,
  sameServedConfig,
  type ServedStageClient,
  type ServedStageConfig,
} from '../src/localStageServeEngine.ts';

function fakeClient(overrides: Partial<ServedStageClient> = {}) {
  const calls = {
    sessionCreate: [] as string[],
    sessionFree: [] as string[],
    tokenize: [] as [string, boolean][],
    prefill: 0,
    decode: 0,
    // NOT part of ServedStageClient's own type — tracked to prove the
    // engine never reaches for them (see this file's module doc comment).
    load: 0,
    dispose: 0,
    reset: 0,
  };
  const client: ServedStageClient & { load: () => void; dispose: () => void; reset: () => void } = {
    isFirst: true,
    isFinal: false,
    nEmbd: 8,
    async sessionCreate(sessionId: string) {
      calls.sessionCreate.push(sessionId);
    },
    async sessionFree(sessionId: string) {
      calls.sessionFree.push(sessionId);
    },
    async tokenize(text: string, addSpecial: boolean) {
      calls.tokenize.push([text, addSpecial]);
      return [11, 22, 33];
    },
    async detokenize(tokens: number[]) {
      return tokens.join(',');
    },
    async tokenIsEog() {
      return false;
    },
    async prefill() {
      calls.prefill++;
      return { predictedToken: 7 };
    },
    async decode() {
      calls.decode++;
      return { predictedToken: 7 };
    },
    load: () => {
      calls.load++;
    },
    dispose: () => {
      calls.dispose++;
    },
    reset: () => {
      calls.reset++;
    },
    ...overrides,
  };
  return { client, calls };
}

function fakeMeshPeer() {
  const tool: { frame: unknown; peers?: string | string[] }[] = [];
  const frame: { bytes: Uint8Array; peers?: string | string[] }[] = [];
  const meshPeer = {
    async sendTool(f: unknown, peers?: string | string[]) {
      tool.push({ frame: f, peers });
    },
    async sendStageFrame(bytes: Uint8Array, peers?: string | string[]) {
      frame.push({ bytes, peers });
    },
  };
  return { meshPeer, sent: { tool, frame } };
}

const CONFIG: ServedStageConfig = { modelId: 'qwen3-8b', layerStart: 0, layerEnd: 2, totalLayers: 36, ctxSize: 4096, wireDtype: 'i8' };

function openPayload(sessionId: string, opts: Partial<StageSessionOpenPayload> = {}): StageSessionOpenPayload {
  return {
    sessionId,
    modelId: CONFIG.modelId,
    layerStart: CONFIG.layerStart,
    layerEnd: CONFIG.layerEnd,
    totalLayers: CONFIG.totalLayers,
    ctxSize: CONFIG.ctxSize,
    wireDtype: CONFIG.wireDtype,
    ...opts,
  };
}

test('sameServedConfig: exact match only — any single field difference is a mismatch', () => {
  assert.equal(sameServedConfig(CONFIG, { ...CONFIG }), true);
  assert.equal(sameServedConfig(CONFIG, { ...CONFIG, layerEnd: 3 }), false);
  assert.equal(sameServedConfig(CONFIG, { ...CONFIG, wireDtype: 'f16' }), false);
  assert.equal(sameServedConfig(CONFIG, { ...CONFIG, modelId: 'other' }), false);
});

test('adopted-mode serve: a session-open matching the resident config tokenizes promptText, creates a lane, and NEVER calls load/dispose/reset', async () => {
  const { client, calls } = fakeClient();
  const { meshPeer, sent } = fakeMeshPeer();
  const engine = createLocalStageServeEngine({ meshPeer, client, config: CONFIG, maxSessions: 2, epoch: 1 });

  await engine.handleSessionOpen(openPayload('s1', { promptText: 'hello there', isFinal: false, nextPeerId: 'peerB', prevPeerId: 'driverA' }), 'driverA', 'call1');

  assert.deepEqual(calls.sessionCreate, ['s1']);
  assert.equal(calls.tokenize.length, 1);
  assert.deepEqual(calls.tokenize[0], ['hello there', true]);
  // The whole point of ADOPTED mode — see this engine's module doc comment.
  assert.equal(calls.load, 0);
  assert.equal(calls.dispose, 0);
  assert.equal(calls.reset, 0);

  assert.equal(engine.getSessions().length, 1);
  assert.equal(engine.getSessions()[0]?.isFirst, true);

  // A stage.session.accept went back to the opener.
  assert.equal(sent.tool.length, 1);
  const decoded = decodeStageControl(sent.tool[0]!.frame as Parameters<typeof decodeStageControl>[0]);
  assert.equal(decoded?.kind, 'stage.session.accept');
});

test('adopted-mode serve: a session-open for a DIFFERENT range than the resident config is REFUSED — no sessionCreate, no tokenize, a stage.stop is sent instead (never attempts to reload — there is no load path)', async () => {
  const { client, calls } = fakeClient();
  const { meshPeer, sent } = fakeMeshPeer();
  const engine = createLocalStageServeEngine({ meshPeer, client, config: CONFIG, maxSessions: 2, epoch: 1 });

  await engine.handleSessionOpen(openPayload('s1', { layerStart: 2, layerEnd: 36 }), 'driverA', 'call1');

  assert.equal(calls.sessionCreate.length, 0);
  assert.equal(calls.tokenize.length, 0);
  assert.equal(calls.load, 0);
  assert.equal(engine.getSessions().length, 0);
  assert.equal(sent.tool.length, 1);
  const decoded = decodeStageControl(sent.tool[0]!.frame as Parameters<typeof decodeStageControl>[0]);
  assert.equal(decoded?.kind, 'stage.stop');
});

test('off-by-one: engine admission ceiling is N (served lanes) — a resident worker loaded natively with 1+N sessions (1 fused, owned by useCommunalChat, N servable) must NOT let this engine admit more than N concurrent SERVED sessions', async () => {
  const { client } = fakeClient();
  const { meshPeer } = fakeMeshPeer();
  const N = 1;
  // If this engine mistakenly re-added the "+1 fused" accounting
  // `useStageHost.ts` does (because IT owns the load) on top of an
  // ALREADY-resident-adjusted N, it would wrongly admit 2 concurrent
  // sessions here instead of 1 — this is exactly what this test guards.
  const engine = createLocalStageServeEngine({ meshPeer, client, config: CONFIG, maxSessions: N, epoch: 1 });

  await engine.handleSessionOpen(openPayload('s1'), 'driverA', 'call1');
  await engine.handleSessionOpen(openPayload('s2'), 'driverB', 'call2');

  assert.equal(engine.getSessions().length, 1, 'only N=1 session admitted immediately');
  assert.equal(engine.getQueueLength(), 1, 'the second request queues rather than being admitted — ceiling is N, not N+1');
});

test('off-by-one: with maxSessions=N=2, exactly 2 concurrent sessions admit before a 3rd queues', async () => {
  const { client } = fakeClient();
  const { meshPeer } = fakeMeshPeer();
  const engine = createLocalStageServeEngine({ meshPeer, client, config: CONFIG, maxSessions: 2, epoch: 1 });

  await engine.handleSessionOpen(openPayload('s1'), 'driverA', 'call1');
  await engine.handleSessionOpen(openPayload('s2'), 'driverB', 'call2');
  await engine.handleSessionOpen(openPayload('s3'), 'driverC', 'call3');

  assert.equal(engine.getSessions().length, 2);
  assert.equal(engine.getQueueLength(), 1);
});

test('getLoadedStageEntry: reflects config/epoch/maxSessions and live activeSessions count', async () => {
  const { client } = fakeClient();
  const { meshPeer } = fakeMeshPeer();
  const engine = createLocalStageServeEngine({ meshPeer, client, config: CONFIG, maxSessions: 3, epoch: 7 });

  const beforeOpen = engine.getLoadedStageEntry();
  assert.equal(beforeOpen.layerStart, 0);
  assert.equal(beforeOpen.layerEnd, 2);
  assert.equal(beforeOpen.includeEmbeddings, true); // client.isFirst
  assert.equal(beforeOpen.maxSessions, 3);
  assert.equal(beforeOpen.activeSessions, 0);
  assert.equal(beforeOpen.epoch, 7);

  await engine.handleSessionOpen(openPayload('s1'), 'driverA', 'call1');
  assert.equal(engine.getLoadedStageEntry().activeSessions, 1);
});

test('freeSession (via stage.stop) releases the lane, calls client.sessionFree, and admits a queued request', async () => {
  const { client, calls } = fakeClient();
  const { meshPeer } = fakeMeshPeer();
  const engine = createLocalStageServeEngine({ meshPeer, client, config: CONFIG, maxSessions: 1, epoch: 1 });

  await engine.handleSessionOpen(openPayload('s1'), 'driverA', 'call1');
  await engine.handleSessionOpen(openPayload('s2'), 'driverB', 'call2');
  assert.equal(engine.getSessions().length, 1);
  assert.equal(engine.getQueueLength(), 1);

  await engine.handleStop('s1', 'driverA', 'user stop');
  assert.deepEqual(calls.sessionFree, ['s1']);
  // The queued s2 request should now be admitted, freeing the queue.
  assert.equal(engine.getQueueLength(), 0);
  assert.equal(engine.getSessions().length, 1);
  assert.equal(engine.getSessions()[0]?.sessionId, 's2');
  // Still never touched load/dispose/reset.
  assert.equal(calls.load, 0);
  assert.equal(calls.dispose, 0);
  assert.equal(calls.reset, 0);
});
