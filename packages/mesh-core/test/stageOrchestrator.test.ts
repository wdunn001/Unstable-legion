/**
 * stageOrchestrator unit tests — a MOCK transport (in-memory bus, no
 * Trystero) + MOCK stage hooks (no wasm/WebGPU) driving
 * `runDriverStageSession` through: happy path, host death mid-decode
 * (replan -> continue-from-history), graceful leave (instant replan, no
 * timeout wait), and no-spare (clean abort).
 *
 * The mock "host" plays the role legion-stage-runtime's harness
 * `host.ts` plays for real — it isn't `stageOrchestrator.ts`'s job to
 * implement (see the SCOPE NOTE at the top of that file) but tests need
 * *something* on the other end of the wire, so each test wires a small
 * deterministic responder.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runDriverStageSession, type StageOrchestratorPeer, type StageOrchestratorEvent } from '../src/stageOrchestrator.ts';
import {
  decodeStageControl,
  encodeStageControl,
  makeStagePong,
  makeStageReady,
  makeStageStop,
  makeStageToken,
} from '../src/stageControl.ts';
import type { MeshToolFrame } from '../src/types.ts';
import type { StagePlan } from '../src/stagePlanner.ts';

// ── Mock mesh: in-memory bus wiring StageOrchestratorPeer to fake hosts ────

interface FakeHost {
  peerId: string;
  isFinal: boolean;
  /** Deterministic token for a given seq. */
  tokenFor: (seq: number) => number;
  /** Stop responding to sf frames from this seq onward (simulate death). */
  dieAtSeq?: number;
  /** After receiving this many sf frames, proactively send stage.stop
   * instead of a token (simulate graceful pagehide leave). */
  gracefulStopAtSeq?: number;
  /** Every `sf` stream starts with one header frame (no seq) before any
   * real activation frame — tracked per-host so a post-replan resend to
   * a fresh host is handled correctly. */
  headerSeen: boolean;
  framesSeen: number;
  tokensSent: number[];
}

function makeFakeHost(peerId: string, overrides: Partial<FakeHost> = {}): FakeHost {
  return {
    peerId,
    isFinal: true,
    tokenFor: (seq) => 1000 + seq,
    headerSeen: false,
    framesSeen: 0,
    tokensSent: [],
    ...overrides,
  };
}

function createMockMesh(selfId: string) {
  const toolListeners = new Set<(frame: MeshToolFrame, peerId: string) => void>();
  const stageFrameListeners = new Set<(bytes: Uint8Array, peerId: string) => void>();
  const hosts = new Map<string, FakeHost>();
  const sentTool: Array<{ frame: MeshToolFrame; peers?: string | string[] }> = [];
  let currentSessionId = '';

  function deliverToolToDriver(frame: MeshToolFrame, fromPeerId: string): void {
    for (const cb of toolListeners) cb(frame, fromPeerId);
  }

  function targetsOf(peers?: string | string[]): string[] {
    if (!peers) return [];
    return Array.isArray(peers) ? peers : [peers];
  }

  const peer: StageOrchestratorPeer = {
    selfId,
    async sendTool(frame, peers) {
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
        } else if (decoded.kind === 'stage.load') {
          currentSessionId = decoded.sessionId;
          const ready = makeStageReady(
            decoded.sessionId,
            { isFirst: decoded.payload.layerStart === 0, isFinal: host.isFinal, nEmbd: 8 },
            decoded.callId,
          );
          queueMicrotask(() => deliverToolToDriver(encodeStageControl(ready), targetId));
        }
        // stage.stop from driver -> nothing to simulate; host just stops mattering.
      }
    },
    onTool(cb) {
      toolListeners.add(cb);
      return () => toolListeners.delete(cb);
    },
    async sendStageFrame(_bytes, peers) {
      for (const targetId of targetsOf(peers)) {
        const host = hosts.get(targetId);
        if (!host) continue;
        if (!host.headerSeen) {
          // Every `sf` stream opens with one header frame (no seq) —
          // nothing to reply to, just note we've seen it.
          host.headerSeen = true;
          continue;
        }
        const seq = host.framesSeen;
        host.framesSeen += 1;
        if (host.dieAtSeq !== undefined && seq >= host.dieAtSeq) {
          continue; // simulate death: never reply
        }
        if (host.gracefulStopAtSeq !== undefined && seq === host.gracefulStopAtSeq) {
          const stop = makeStageStop(currentSessionId, 'pagehide');
          queueMicrotask(() => deliverToolToDriver(encodeStageControl(stop), targetId));
          continue;
        }
        const token = host.tokenFor(seq);
        host.tokensSent.push(token);
        const msg = makeStageToken(currentSessionId, token, seq, false);
        queueMicrotask(() => deliverToolToDriver(encodeStageControl(msg), targetId));
      }
    },
    onStageFrame(cb) {
      stageFrameListeners.add(cb);
      return () => stageFrameListeners.delete(cb);
    },
  };

  return { peer, hosts, sentTool };
}

// ── Local stage-0 mock hooks ────────────────────────────────────────────

function makeMockLocalHooks(nEmbd = 8) {
  let calls = 0;
  return {
    nEmbd,
    async tokenize(text: string) {
      // Deterministic fake tokenization: one token per word, offset so
      // it doesn't collide with fake host token ids (>=1000).
      return text.split(/\s+/).filter(Boolean).map((_, i) => 1 + i);
    },
    async detokenize(tokens: readonly number[]) {
      return tokens.join(',');
    },
    async reset() {
      calls++;
    },
    async prefill(tokens: readonly number[], _positions: readonly number[]) {
      // Real Codec activation frames require activations.length === tokenCount * nEmbd.
      return { activation: new Float32Array(Math.max(1, tokens.length) * nEmbd) };
    },
    async decode(_token: number) {
      return { activation: new Float32Array(nEmbd) }; // one token per decode step
    },
    get resetCalls() {
      return calls;
    },
  };
}

function twoStagePlan(remotePeerId: string): StagePlan {
  return {
    modelId: 'm',
    totalLayers: 8,
    stages: [
      { stageIndex: 0, peerId: 'local', layerStart: 0, layerEnd: 4, isFirst: true, isFinal: false, capacityBytes: 1, assignedBytes: 1, cacheHitFraction: 0 },
      { stageIndex: 1, peerId: remotePeerId, layerStart: 4, layerEnd: 8, isFirst: false, isFinal: true, capacityBytes: 1, assignedBytes: 1, cacheHitFraction: 0 },
    ],
    perTokenHopBytes: 32,
    unselectedPeerIds: [],
  };
}

const FAST_TIMEOUTS = { pingMs: 200, loadMs: 200, bootstrapStepMs: 200, stepTimeoutFloorMs: 50 };

function collectEvents(handle: { on: (l: (ev: StageOrchestratorEvent) => void) => () => void }): StageOrchestratorEvent[] {
  const events: StageOrchestratorEvent[] = [];
  handle.on((ev) => events.push(ev));
  return events;
}

// ── Happy path ─────────────────────────────────────────────────────────────

test('happy path: prefill + N decode steps complete with the expected token history', async () => {
  const mesh = createMockMesh('driver');
  const hostA = makeFakeHost('hostA');
  mesh.hosts.set('hostA', hostA);
  const plan = twoStagePlan('hostA');
  const hooks = makeMockLocalHooks();

  const handle = runDriverStageSession({
    peer: mesh.peer,
    plan,
    modelId: 'm',
    prompt: 'hello world',
    maxDecodeTokens: 4,
    wireDtype: 'f16',
    localHooks: hooks,
    replan: () => null,
    loadExtras: () => ({ shardUrls: ['https://x/shard.gguf'], ctxSize: 512 }),
    timeouts: FAST_TIMEOUTS,
  });
  const events = collectEvents(handle);

  const result = await handle.result();
  assert.equal(result.aborted, false);
  assert.equal(result.restartCount, 0);
  // 2 prompt tokens ("hello", "world") + 4 generated tokens.
  assert.equal(result.tokens.length, 6);
  assert.deepEqual(result.tokens.slice(0, 2), [1, 2]);
  assert.deepEqual(result.tokens.slice(2), [1000, 1001, 1002, 1003]);

  const history = handle.tokenHistory();
  assert.deepEqual(history.promptTokens, [1, 2]);
  assert.deepEqual(history.generatedTokens, [1000, 1001, 1002, 1003]);

  assert.ok(events.some((e) => e.type === 'planCreated'));
  assert.ok(events.some((e) => e.type === 'stageReady' && e.peerId === 'hostA'));
  assert.ok(events.some((e) => e.type === 'finished'));
  assert.equal(events.filter((e) => e.type === 'token').length, 4);
});

// ── Host death mid-decode -> replan -> continue-from-history ───────────────

test('host death mid-decode triggers replan and resumes decode with full token history preserved', async () => {
  const mesh = createMockMesh('driver');
  const hostA = makeFakeHost('hostA', { dieAtSeq: 2 }); // dies after seq 0,1 succeed (2 tokens)
  const hostB = makeFakeHost('hostB', { tokenFor: (seq) => 5000 + seq });
  mesh.hosts.set('hostA', hostA);
  mesh.hosts.set('hostB', hostB);

  const planA = twoStagePlan('hostA');
  const planB = twoStagePlan('hostB');
  const hooks = makeMockLocalHooks();

  let replanCalls = 0;
  const handle = runDriverStageSession({
    peer: mesh.peer,
    plan: planA,
    modelId: 'm',
    prompt: 'hello world',
    maxDecodeTokens: 4,
    wireDtype: 'f16',
    localHooks: hooks,
    replan: (lostPeerId) => {
      replanCalls++;
      assert.equal(lostPeerId, 'hostA');
      return planB;
    },
    loadExtras: () => ({ shardUrls: ['https://x/shard.gguf'], ctxSize: 512 }),
    timeouts: FAST_TIMEOUTS,
  });
  const events = collectEvents(handle);

  const result = await handle.result();
  assert.equal(result.aborted, false);
  assert.equal(replanCalls, 1);
  assert.equal(result.restartCount, 1);

  // Prompt (2 tokens) + exactly maxDecodeTokens=4 generated tokens, no
  // duplicates and no gaps despite the mid-session host swap.
  assert.equal(result.tokens.length, 6);
  const generated = result.tokens.slice(2);
  assert.equal(generated.length, 4);
  assert.equal(new Set(generated).size, 4); // no duplicate tokens

  assert.ok(events.some((e) => e.type === 'replan' && e.lostPeerId === 'hostA'));
  assert.ok(events.some((e) => e.type === 'stageReady' && e.peerId === 'hostB'));
  // hostB actually received a stage.load with the SAME model/layer shape.
  const loadToHostB = mesh.sentTool.find((s) => {
    const d = decodeStageControl(s.frame);
    return d?.kind === 'stage.load' && (Array.isArray(s.peers) ? s.peers.includes('hostB') : s.peers === 'hostB');
  });
  assert.ok(loadToHostB, 'expected a stage.load sent to hostB during replan');
});

// ── Graceful leave -> instant replan without waiting for the full timeout ──

test('graceful stage.stop from the host triggers instant replan (no long timeout wait)', async () => {
  const mesh = createMockMesh('driver');
  // gracefulStopAtSeq: 1 -> the host announces stop right after its first
  // token (seq 0) instead of ever timing out.
  const hostA = makeFakeHost('hostA', { gracefulStopAtSeq: 1 });
  const hostB = makeFakeHost('hostB', { tokenFor: (seq) => 7000 + seq });
  mesh.hosts.set('hostA', hostA);
  mesh.hosts.set('hostB', hostB);

  const planA = twoStagePlan('hostA');
  const planB = twoStagePlan('hostB');
  const hooks = makeMockLocalHooks();

  const startedAt = Date.now();
  let sawGraceful = false;
  const handle = runDriverStageSession({
    peer: mesh.peer,
    plan: planA,
    modelId: 'm',
    prompt: 'hi',
    maxDecodeTokens: 3,
    wireDtype: 'f16',
    localHooks: hooks,
    replan: (lostPeerId, graceful) => {
      sawGraceful = graceful;
      assert.equal(lostPeerId, 'hostA');
      return planB;
    },
    loadExtras: () => ({ shardUrls: ['https://x/shard.gguf'], ctxSize: 512 }),
    // Deliberately huge timeouts — if the orchestrator were waiting on a
    // timeout instead of reacting to the graceful stage.stop, this test
    // would hang/timeout instead of finishing fast.
    timeouts: { pingMs: 5000, loadMs: 5000, bootstrapStepMs: 5000, stepTimeoutFloorMs: 5000 },
  });

  const result = await handle.result();
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.aborted, false);
  assert.equal(sawGraceful, true);
  assert.ok(elapsedMs < 2000, `expected instant replan, took ${elapsedMs}ms`);
});

// ── No spare -> clean abort ─────────────────────────────────────────────────

test('no eligible replacement plan -> clean abort, no hang', async () => {
  const mesh = createMockMesh('driver');
  const hostA = makeFakeHost('hostA', { dieAtSeq: 1 });
  mesh.hosts.set('hostA', hostA);
  const plan = twoStagePlan('hostA');
  const hooks = makeMockLocalHooks();

  const handle = runDriverStageSession({
    peer: mesh.peer,
    plan,
    modelId: 'm',
    prompt: 'hi',
    maxDecodeTokens: 5,
    wireDtype: 'f16',
    localHooks: hooks,
    replan: () => null, // no spare, no fallback host available
    loadExtras: () => ({ shardUrls: ['https://x/shard.gguf'], ctxSize: 512 }),
    timeouts: FAST_TIMEOUTS,
  });
  const events = collectEvents(handle);

  const result = await handle.result();
  assert.equal(result.aborted, true);
  assert.match(result.abortReason ?? '', /no eligible replacement plan/);
  assert.ok(events.some((e) => e.type === 'aborted'));
  // Never falsely reports success.
  assert.ok(!events.some((e) => e.type === 'finished'));
});

// ── abort() external cancellation ───────────────────────────────────────────

test('external abort() cleanly finishes the session with partial history intact', async () => {
  const mesh = createMockMesh('driver');
  const hostA = makeFakeHost('hostA');
  mesh.hosts.set('hostA', hostA);
  const plan = twoStagePlan('hostA');
  const hooks = makeMockLocalHooks();

  const handle = runDriverStageSession({
    peer: mesh.peer,
    plan,
    modelId: 'm',
    prompt: 'hi',
    maxDecodeTokens: 1000, // effectively unbounded — we'll abort manually
    wireDtype: 'f16',
    localHooks: hooks,
    replan: () => null,
    loadExtras: () => ({ shardUrls: ['https://x/shard.gguf'], ctxSize: 512 }),
    timeouts: FAST_TIMEOUTS,
  });

  // Abort immediately — before the mock's microtask-fast replies have any
  // chance to race the whole (effectively unbounded) decode loop to
  // completion. `doAbort` is safe to call this early: all the state it
  // touches is initialized synchronously before the async kickoff runs.
  handle.abort('caller cancelled');

  const result = await handle.result();
  assert.equal(result.aborted, true);
  assert.equal(result.abortReason, 'caller cancelled');
});
