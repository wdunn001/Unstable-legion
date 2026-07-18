/**
 * End-to-end regression test for the M3 solo/self-host routing bug: a
 * communal route whose remote segment's winning candidate IS the driver's
 * own `peerId` (the only-candidate-when-solo case, and the "some hops
 * local, some remote" mixed case) must dispatch that hop's
 * `stage.session.open`/prefill/decode traffic locally — never emit a
 * Trystero `sendTool`/`sendStageFrame` addressed at `selfId` (which threw
 * "no peer with id <selfId> found" and stalled/aborted after 30s before
 * the `peer.ts` self-loopback fix).
 *
 * Uses a REAL `joinMesh` Peer (not a hand-rolled mock `StageOrchestratorPeer`
 * like `communalDriverSession.test.ts`) over a fake Trystero room that
 * throws on any self-addressed wire send — exactly reproducing the bug's
 * failure mode if the loopback fix regresses. The "host" side is a minimal
 * inline responder speaking the same `stageControl.ts` wire contract
 * `useStageHost.ts` implements (ping/session.open/sf-frame/decode), kept
 * deliberately small since exercising the real WebGPU worker needs a
 * browser — this test's job is proving the MESH TRANSPORT LAYER routes a
 * self-addressed hop locally, not re-testing `useStageHost`'s own worker
 * logic (that hook's existing tests / e2e cover that).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { joinMesh, type TrysteroRoom } from '../src/peer.ts';
import { runCommunalDriverSession, type CommunalRoute, type StageOrchestratorPeer } from '../src/stageOrchestrator.ts';
import {
  decodeStageControl,
  encodeStageControl,
  isStageControlFrame,
  makeStagePong,
  makeStageSessionAccept,
  makeStageToken,
} from '../src/stageControl.ts';
import { decodeStageFrameEnvelope } from '../src/stageFrameEnvelope.ts';
import { MESH_PROTOCOL_VERSION, type MeshPeerCap } from '../src/types.ts';
import type { CommunalHostStageAd } from '../src/communalTopology.ts';
import type { StagePlan } from '../src/stagePlanner.ts';

function makeCap(): MeshPeerCap {
  return {
    v: MESH_PROTOCOL_VERSION,
    ts: Date.now(),
    nick: 'solo',
    modelId: 'm',
    available: true,
    skills: [],
    systemPromptSummary: '',
    tools: [],
  };
}

/** Fake Trystero room that faithfully reproduces the real failure mode:
 * addressing a peer id with no data channel (including our own selfId,
 * which Trystero never has a channel to) throws. Also counts every send
 * that actually reaches the wire, keyed by action name, so the test can
 * assert NOTHING addressed to `selfId` ever got this far. */
function makeStrictFakeRoom(selfId: string): { room: TrysteroRoom; wireSendsByAction: Record<string, number> } {
  const wireSendsByAction: Record<string, number> = {};
  const room: TrysteroRoom = {
    makeAction<T>(name: string) {
      const sender = async (_payload: T, peers?: string | string[]) => {
        const targets = peers === undefined ? [] : Array.isArray(peers) ? peers : [peers];
        if (targets.includes(selfId)) {
          throw new Error(`no peer with id ${selfId} found`);
        }
        wireSendsByAction[name] = (wireSendsByAction[name] ?? 0) + 1;
      };
      return [sender, () => undefined, () => undefined] as ReturnType<TrysteroRoom['makeAction']>;
    },
    onPeerJoin: () => undefined,
    onPeerLeave: () => undefined,
    leave: () => undefined,
  };
  return { room, wireSendsByAction };
}

/** Minimal inline stand-in for `useStageHost.ts`'s wire-protocol answer
 * loop — just enough of the ping/session-open/sf-frame contract to prove
 * the TRANSPORT routes a self-addressed hop locally. Not a re-test of
 * useStageHost's own worker-loading/admission logic. */
function attachMinimalSelfHost(peer: StageOrchestratorPeer, opts: { isFirst: boolean; isFinal: boolean; nEmbd: number }): () => void {
  let seq = 0;
  const unsubTool = peer.onTool((frame, peerId) => {
    if (!isStageControlFrame(frame)) return;
    if (frame.kind !== 'call') return;
    const decoded = decodeStageControl(frame);
    if (!decoded) return;
    if (decoded.kind === 'stage.ping') {
      void peer.sendTool(encodeStageControl(makeStagePong(decoded.sessionId, decoded.payload.sentAtMs, decoded.callId)), peerId);
    } else if (decoded.kind === 'stage.session.open') {
      void peer.sendTool(
        encodeStageControl(
          makeStageSessionAccept(
            decoded.sessionId,
            { nEmbd: opts.nEmbd, isFirst: opts.isFirst, isFinal: opts.isFinal, activeSessions: 1, maxSessions: 4 },
            decoded.callId,
          ),
        ),
        peerId,
      );
    }
  });
  let currentSessionId = '';
  const unsubFrame = peer.onStageFrame((bytes, peerId) => {
    const envelope = decodeStageFrameEnvelope(bytes);
    if (!envelope) return;
    currentSessionId = envelope.sessionId;
    const thisSeq = seq;
    seq += 1;
    const token = 5000 + thisSeq;
    void peer.sendTool(encodeStageControl(makeStageToken(currentSessionId, token, thisSeq, false)), peerId);
  });
  return () => {
    unsubTool();
    unsubFrame();
  };
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
    async prefill(tokens: readonly number[]) {
      return { activation: new Float32Array(Math.max(1, tokens.length) * nEmbd) };
    },
    async decode() {
      return { activation: new Float32Array(nEmbd) };
    },
  };
}

function soloRoute(selfId: string): CommunalRoute {
  // Exactly the shape `planCommunalRoute` produces when `selfId` is the
  // ONLY communal host on the roster (the reported solo bug): the
  // winning candidate for the one covered segment is the driver's own
  // peerId, because `useCommunalHost` advertised its own contributed
  // range and nothing else exists on the mesh yet.
  const plan: StagePlan = {
    modelId: 'm',
    totalLayers: 8,
    stages: [
      { stageIndex: 0, peerId: selfId, layerStart: 0, layerEnd: 2, isFirst: true, isFinal: false, capacityBytes: 0, assignedBytes: 0, cacheHitFraction: 0 },
      { stageIndex: 1, peerId: selfId, layerStart: 2, layerEnd: 8, isFirst: false, isFinal: true, capacityBytes: 0, assignedBytes: 0, cacheHitFraction: 0 },
    ],
    perTokenHopBytes: 32,
    unselectedPeerIds: [],
  };
  const ad: CommunalHostStageAd = {
    peerId: selfId,
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
  };
  return { plan, attachOrder: new Map([[1, [ad]]]) };
}

test('solo self-host: a route whose remote hop is peerId===selfId completes with ZERO wire sends addressed to self', async () => {
  const selfId = 'solo-driver';
  const { room, wireSendsByAction } = makeStrictFakeRoom(selfId);
  const peer = joinMesh({ joinRoom: () => room, selfId, trysteroConfig: {}, roomId: 'r', cap: makeCap() });

  const detachHost = attachMinimalSelfHost(peer, { isFirst: false, isFinal: true, nEmbd: 8 });

  const handle = runCommunalDriverSession({
    peer,
    route: soloRoute(selfId),
    modelId: 'm',
    prompt: 'hello there',
    maxDecodeTokens: 3,
    localHooks: makeMockLocalHooks(),
    replanRoute: () => null,
    timeouts: { pingMs: 2000, loadMs: 2000, bootstrapStepMs: 2000, stepTimeoutFloorMs: 200 },
  });

  const events: { type: string }[] = [];
  handle.on((ev) => events.push(ev as { type: string }));

  const result = await handle.result();

  detachHost();
  peer.leave();

  assert.equal(result.aborted, false, `expected a clean finish, got aborted: ${result.abortReason}`);
  // 2 prompt tokens + 3 generated.
  assert.equal(result.tokens.length, 5);
  assert.ok(events.some((e) => e.type === 'stageReady'));
  assert.ok(events.some((e) => e.type === 'finished'));
  assert.ok(!events.some((e) => e.type === 'stall'), 'expected no stall/timeout events for a self-hosted hop');
  assert.ok(!events.some((e) => e.type === 'aborted'), 'expected no abort for a self-hosted hop');
  // The whole point: nothing addressed to `selfId` ever reached the fake
  // Trystero sender on the stage-control ('tc') or stage-frame ('sf')
  // actions — every control/frame exchange for the self-hosted stage was
  // answered via the local loopback, not the wire. ('cap' traffic is the
  // unrelated peer-presence heartbeat every `joinMesh` peer broadcasts on
  // join, irrespective of this fix — not addressed at any particular
  // peer, so it's not part of what this test is proving.)
  assert.equal(wireSendsByAction.tc ?? 0, 0);
  assert.equal(wireSendsByAction.sf ?? 0, 0);
});

test('solo self-host: mixed route (self covers one hop, a real peer covers another) still routes the remote hop over the wire', async () => {
  const selfId = 'mixed-driver';
  const remotePeerId = 'remote-host';
  const { room, wireSendsByAction } = makeStrictFakeRoom(selfId);
  const peer = joinMesh({ joinRoom: () => room, selfId, trysteroConfig: {}, roomId: 'r', cap: makeCap() });

  // The local self-host answers ping/open/sf for ITSELF only — a genuinely
  // remote peer never calls into this process, so its own "replies" have
  // to be synthesized by intercepting the fake room's wire sends instead
  // (mirroring communalDriverSession.test.ts's createMockMesh idiom).
  const detachHost = attachMinimalSelfHost(peer, { isFirst: false, isFinal: false, nEmbd: 8 });

  // A 3-stage plan: local[0,2) -> self[2,5) -> remote[5,8). Only the
  // FINAL stage's token stream is actually consumed end-to-end today
  // (stageOrchestrator.ts's own SCOPE NOTE — multi-hop relay isn't wired
  // yet), so this test only asserts the TRANSPORT split: the self-hosted
  // attach never touches the wire, while a remote-hosted attach does.
  const plan: StagePlan = {
    modelId: 'm',
    totalLayers: 8,
    stages: [
      { stageIndex: 0, peerId: selfId, layerStart: 0, layerEnd: 2, isFirst: true, isFinal: false, capacityBytes: 0, assignedBytes: 0, cacheHitFraction: 0 },
      { stageIndex: 1, peerId: remotePeerId, layerStart: 2, layerEnd: 8, isFirst: false, isFinal: true, capacityBytes: 0, assignedBytes: 0, cacheHitFraction: 0 },
    ],
    perTokenHopBytes: 32,
    unselectedPeerIds: [],
  };
  const remoteAd: CommunalHostStageAd = {
    peerId: remotePeerId,
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
    stabilityScore: 500,
  };
  const route: CommunalRoute = { plan, attachOrder: new Map([[1, [remoteAd]]]) };

  const handle = runCommunalDriverSession({
    peer,
    route,
    modelId: 'm',
    prompt: 'hi',
    maxDecodeTokens: 1,
    localHooks: makeMockLocalHooks(),
    replanRoute: () => null,
    timeouts: { pingMs: 300, loadMs: 300, bootstrapStepMs: 300, stepTimeoutFloorMs: 100 },
    replanJitterMs: 0,
  });

  // A real remote peer would answer over Trystero — this fake room has no
  // such peer, so the attach to `remotePeerId` is expected to time out /
  // exhaust and the session aborts. The assertion that matters here is
  // narrower: the ATTEMPT to reach `remotePeerId` must be a genuine wire
  // send (not silently swallowed as a loopback), proving only the
  // self-addressed portion of a mixed route is intercepted.
  await handle.result();
  detachHost();
  peer.leave();

  assert.ok((wireSendsByAction.tc ?? 0) > 0, 'expected at least one real wire send attempting to reach the remote peer');
});
