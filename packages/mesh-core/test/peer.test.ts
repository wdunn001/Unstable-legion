/**
 * joinMesh self-loopback tests — the M3 solo/self-host routing fix.
 * `splitPeerTarget` gets its own direct unit coverage; the `joinMesh`
 * tests use a fake `TrysteroRoom` (structural `makeAction`) to verify
 * `sendTool`/`sendStageFrame` actually loop back to the LOCAL listener
 * registry for a self-addressed target instead of calling into Trystero
 * (which has no connection to `selfId` and would throw/hang in real life).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { joinMesh, splitPeerTarget, type TrysteroRoom } from '../src/peer.ts';
import { MESH_PROTOCOL_VERSION, type MeshPeerCap, type MeshToolFrame } from '../src/types.ts';

function makeCap(): MeshPeerCap {
  return {
    v: MESH_PROTOCOL_VERSION,
    ts: Date.now(),
    nick: 'n',
    modelId: 'm',
    available: true,
    skills: [],
    systemPromptSummary: '',
    tools: [],
  };
}

// ── splitPeerTarget ──────────────────────────────────────────────────────

test('splitPeerTarget: undefined peers -> broadcast, no loopback', () => {
  assert.deepEqual(splitPeerTarget(undefined, 'me'), { loopback: false, remote: undefined });
});

test('splitPeerTarget: single string target === selfId -> pure loopback, nothing left for the wire', () => {
  assert.deepEqual(splitPeerTarget('me', 'me'), { loopback: true, remote: [] });
});

test('splitPeerTarget: single string target !== selfId -> unaffected remote send', () => {
  assert.deepEqual(splitPeerTarget('other', 'me'), { loopback: false, remote: 'other' });
});

test('splitPeerTarget: array containing selfId -> loopback + the remaining remote ids', () => {
  assert.deepEqual(splitPeerTarget(['other', 'me'], 'me'), { loopback: true, remote: ['other'] });
});

test('splitPeerTarget: array without selfId -> unaffected, no loopback', () => {
  assert.deepEqual(splitPeerTarget(['a', 'b'], 'me'), { loopback: false, remote: ['a', 'b'] });
});

// ── joinMesh integration: fake Trystero room ─────────────────────────────

function makeFakeRoom(): {
  room: TrysteroRoom;
  toolSentToWire: Array<{ payload: MeshToolFrame; peers?: string | string[] }>;
  stageFrameSentToWire: Array<{ payload: Uint8Array; peers?: string | string[] }>;
} {
  const toolSentToWire: Array<{ payload: MeshToolFrame; peers?: string | string[] }> = [];
  const stageFrameSentToWire: Array<{ payload: Uint8Array; peers?: string | string[] }> = [];
  const room: TrysteroRoom = {
    makeAction<T>(name: string) {
      const sender = async (payload: T, peers?: string | string[]) => {
        if (name === 'tc') toolSentToWire.push({ payload: payload as MeshToolFrame, peers });
        if (name === 'sf') stageFrameSentToWire.push({ payload: payload as Uint8Array, peers });
        // Real Trystero throws when `peers` names a peer id with no data
        // channel — simulate that so a regression (routing a pure-self
        // target back into this fake sender) fails the test loudly.
        if (typeof peers === 'string' && peers === 'me') {
          throw new Error(`no peer with id ${peers} found`);
        }
        if (Array.isArray(peers) && peers.includes('me')) {
          throw new Error(`no peer with id me found`);
        }
        return undefined;
      };
      const onReceive = () => undefined;
      const onProgress = () => undefined;
      return [sender, onReceive, onProgress] as ReturnType<TrysteroRoom['makeAction']>;
    },
    onPeerJoin: () => undefined,
    onPeerLeave: () => undefined,
    leave: () => undefined,
  };
  return { room, toolSentToWire, stageFrameSentToWire };
}

function makeToolFrame(tag: string): MeshToolFrame {
  return { kind: 'call', toolName: `test.${tag}`, callId: tag, args: {} } as unknown as MeshToolFrame;
}

test('joinMesh sendTool: pure self-address loops back locally, never touches Trystero', async () => {
  const { room, toolSentToWire } = makeFakeRoom();
  const peer = joinMesh({
    joinRoom: () => room,
    selfId: 'me',
    trysteroConfig: {},
    roomId: 'r',
    cap: makeCap(),
  });

  const received: Array<{ frame: MeshToolFrame; peerId: string }> = [];
  peer.onTool((frame, peerId) => received.push({ frame, peerId }));

  const frame = makeToolFrame('open');
  await peer.sendTool(frame, 'me');

  assert.equal(received.length, 1);
  assert.equal(received[0]!.peerId, 'me');
  assert.deepEqual(received[0]!.frame, frame);
  // The initial cap broadcast on join is the only thing that should have
  // hit the fake wire sender — no 'tc' traffic for the self-addressed call.
  assert.equal(toolSentToWire.length, 0);

  peer.leave();
});

test('joinMesh sendTool: mixed self + remote target loops back AND forwards the remote portion over the wire', async () => {
  const { room, toolSentToWire } = makeFakeRoom();
  const peer = joinMesh({
    joinRoom: () => room,
    selfId: 'me',
    trysteroConfig: {},
    roomId: 'r',
    cap: makeCap(),
  });

  const received: Array<{ frame: MeshToolFrame; peerId: string }> = [];
  peer.onTool((frame, peerId) => received.push({ frame, peerId }));

  const frame = makeToolFrame('mixed');
  await peer.sendTool(frame, ['other', 'me']);

  assert.equal(received.length, 1);
  assert.equal(received[0]!.peerId, 'me');
  assert.equal(toolSentToWire.length, 1);
  assert.deepEqual(toolSentToWire[0]!.peers, ['other']);

  peer.leave();
});

test('joinMesh sendTool: pure remote target is unaffected (no loopback, forwarded as-is)', async () => {
  const { room, toolSentToWire } = makeFakeRoom();
  const peer = joinMesh({
    joinRoom: () => room,
    selfId: 'me',
    trysteroConfig: {},
    roomId: 'r',
    cap: makeCap(),
  });

  const received: Array<{ frame: MeshToolFrame; peerId: string }> = [];
  peer.onTool((frame, peerId) => received.push({ frame, peerId }));

  await peer.sendTool(makeToolFrame('remote'), 'other');

  assert.equal(received.length, 0);
  assert.equal(toolSentToWire.length, 1);
  assert.equal(toolSentToWire[0]!.peers, 'other');

  peer.leave();
});

test('joinMesh sendStageFrame: pure self-address loops back locally, never touches Trystero', async () => {
  const { room, stageFrameSentToWire } = makeFakeRoom();
  const peer = joinMesh({
    joinRoom: () => room,
    selfId: 'me',
    trysteroConfig: {},
    roomId: 'r',
    cap: makeCap(),
  });

  const received: Array<{ bytes: Uint8Array; peerId: string }> = [];
  peer.onStageFrame((bytes, peerId) => received.push({ bytes, peerId }));

  const bytes = new Uint8Array([1, 2, 3]);
  await peer.sendStageFrame(bytes, 'me');

  assert.equal(received.length, 1);
  assert.equal(received[0]!.peerId, 'me');
  assert.deepEqual(received[0]!.bytes, bytes);
  assert.equal(stageFrameSentToWire.length, 0);

  peer.leave();
});

// ── peerConnectionType ────────────────────────────────────────────────────
//
// Fake room.getPeers()/pc.getStats() — mirrors iceDiagnostics.ts's own
// captureSelectedPair shape (a nominated candidate-pair report pointing at
// two candidate reports by id).

function makeFakeStatsPc(local: { candidateType: string }, remote: { candidateType: string }): RTCPeerConnection {
  const reports = new Map<string, Record<string, unknown>>([
    ['pair-1', { type: 'candidate-pair', nominated: true, localCandidateId: 'local-1', remoteCandidateId: 'remote-1' }],
    ['local-1', { candidateType: local.candidateType }],
    ['remote-1', { candidateType: remote.candidateType }],
  ]);
  return {
    getStats: async () => reports as unknown as RTCStatsReport,
  } as unknown as RTCPeerConnection;
}

test('peerConnectionType: relay on either side of the nominated pair -> relayed', async () => {
  const { room } = makeFakeRoom();
  const pc = makeFakeStatsPc({ candidateType: 'relay' }, { candidateType: 'srflx' });
  (room as { getPeers?: () => Record<string, RTCPeerConnection> }).getPeers = () => ({ other: pc });
  const peer = joinMesh({ joinRoom: () => room, selfId: 'me', trysteroConfig: {}, roomId: 'r', cap: makeCap() });

  assert.equal(await peer.peerConnectionType!('other'), 'relayed');
  peer.leave();
});

test('peerConnectionType: host/srflx/prflx on both sides -> direct', async () => {
  const { room } = makeFakeRoom();
  const pc = makeFakeStatsPc({ candidateType: 'host' }, { candidateType: 'srflx' });
  (room as { getPeers?: () => Record<string, RTCPeerConnection> }).getPeers = () => ({ other: pc });
  const peer = joinMesh({ joinRoom: () => room, selfId: 'me', trysteroConfig: {}, roomId: 'r', cap: makeCap() });

  assert.equal(await peer.peerConnectionType!('other'), 'direct');
  peer.leave();
});

test('peerConnectionType: no connection for that peerId -> unknown', async () => {
  const { room } = makeFakeRoom();
  (room as { getPeers?: () => Record<string, RTCPeerConnection> }).getPeers = () => ({});
  const peer = joinMesh({ joinRoom: () => room, selfId: 'me', trysteroConfig: {}, roomId: 'r', cap: makeCap() });

  assert.equal(await peer.peerConnectionType!('other'), 'unknown');
  peer.leave();
});

test('peerConnectionType: room has no getPeers at all -> unknown, never throws', async () => {
  const { room } = makeFakeRoom();
  const peer = joinMesh({ joinRoom: () => room, selfId: 'me', trysteroConfig: {}, roomId: 'r', cap: makeCap() });

  assert.equal(await peer.peerConnectionType!('other'), 'unknown');
  peer.leave();
});
