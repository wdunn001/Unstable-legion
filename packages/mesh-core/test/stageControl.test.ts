/**
 * stageControl unit tests — guards, encode/decode round-trip over the
 * `tc` wire shape, and PendingToolCallTracker correlation flows (load ->
 * ready, ping -> pong, timeout).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeStageControl,
  decodeStageControl,
  isStageControlFrame,
  isStageLoadPayload,
  isStageTokenPayload,
  isStageSessionOpenPayload,
  isStageSessionAcceptPayload,
  isStageSessionBusyPayload,
  makeStageLoad,
  makeStageReady,
  makeStagePing,
  makeStagePong,
  makeStageStop,
  makeStageProgress,
  makeStageLoadProgress,
  makeStageToken,
  makeStageSessionOpen,
  makeStageSessionAccept,
  makeStageSessionBusy,
  stageTokenCallId,
  newSessionId,
} from '../src/stageControl.ts';
import { PendingToolCallTracker, newCallId } from '../src/tools.ts';
import type { MeshToolFrame } from '../src/types.ts';

// ── payload guards ─────────────────────────────────────────────────────────

test('isStageLoadPayload: requires manifestUrl or shardUrls', () => {
  const base = {
    sessionId: 's1',
    modelId: 'qwen3-0.6b-q8_0',
    layerStart: 0,
    layerEnd: 14,
    totalLayers: 28,
    includeEmbeddings: true,
    includeOutput: false,
    wireDtype: 'f16' as const,
    ctxSize: 2048,
  };
  assert.equal(isStageLoadPayload(base), false); // neither manifestUrl nor shardUrls
  assert.equal(isStageLoadPayload({ ...base, shardUrls: ['https://x/shard-0.gguf'] }), true);
  assert.equal(isStageLoadPayload({ ...base, manifestUrl: 'https://x/manifest.json' }), true);
  assert.equal(isStageLoadPayload({ ...base, layerEnd: 0 }), false); // layerEnd <= layerStart
  assert.equal(isStageLoadPayload({ ...base, shardUrls: [], wireDtype: 'bogus' }), false);
});

test('isStageTokenPayload: rejects missing/malformed fields', () => {
  assert.equal(isStageTokenPayload({ sessionId: 's', token: 5, seq: 0, done: false }), true);
  assert.equal(isStageTokenPayload({ sessionId: 's', token: 5, seq: 0 }), false); // missing done
  assert.equal(isStageTokenPayload({ sessionId: 's', token: 'nope', seq: 0, done: false }), false);
});

// ── encode/decode round-trip ────────────────────────────────────────────────

test('encodeStageControl/decodeStageControl round-trip: stage.load (call-shaped)', () => {
  const sessionId = newSessionId();
  const msg = makeStageLoad(sessionId, {
    modelId: 'qwen3-0.6b-q8_0',
    layerStart: 0,
    layerEnd: 14,
    totalLayers: 28,
    includeEmbeddings: true,
    includeOutput: false,
    shardUrls: ['https://x/shard-0.gguf'],
    wireDtype: 'f16',
    ctxSize: 2048,
  });
  const frame = encodeStageControl(msg);
  assert.equal(frame.kind, 'call');
  const decoded = decodeStageControl(frame);
  assert.ok(decoded);
  assert.equal(decoded!.kind, 'stage.load');
  assert.equal(decoded!.sessionId, sessionId);
  assert.deepEqual(decoded, msg);
});

test('encodeStageControl/decodeStageControl round-trip: stage.ready (result-shaped)', () => {
  const sessionId = newSessionId();
  const callId = newCallId();
  const msg = makeStageReady(sessionId, { isFirst: false, isFinal: true, nEmbd: 1024 }, callId);
  const frame = encodeStageControl(msg);
  assert.equal(frame.kind, 'result');
  const decoded = decodeStageControl(frame);
  assert.deepEqual(decoded, msg);
});

test('encodeStageControl/decodeStageControl round-trip: stage.token uses seq-derived callId', () => {
  const sessionId = newSessionId();
  const msg = makeStageToken(sessionId, 42, 3, false);
  assert.equal(msg.callId, stageTokenCallId(sessionId, 3));
  const frame = encodeStageControl(msg);
  const decoded = decodeStageControl(frame);
  assert.deepEqual(decoded, msg);
});

test('encodeStageControl/decodeStageControl round-trip: stage.stop, stage.ping, stage.pong, stage.progress', () => {
  const sessionId = newSessionId();
  const stop = makeStageStop(sessionId, 'pagehide');
  assert.deepEqual(decodeStageControl(encodeStageControl(stop)), stop);

  const ping = makeStagePing(sessionId);
  assert.deepEqual(decodeStageControl(encodeStageControl(ping)), ping);

  const pong = makeStagePong(sessionId, ping.payload.sentAtMs, ping.callId);
  assert.deepEqual(decodeStageControl(encodeStageControl(pong)), pong);

  const progress = makeStageProgress(sessionId, 16, 15);
  assert.deepEqual(decodeStageControl(encodeStageControl(progress)), progress);
});

test('decodeStageControl: rejects non-stage tc frames without throwing', () => {
  const ordinaryCall: MeshToolFrame = {
    kind: 'call',
    v: 1,
    ts: Date.now(),
    callId: 'tc-1',
    toolName: 'current_time',
    args: {},
  };
  assert.equal(decodeStageControl(ordinaryCall), null);
  assert.equal(isStageControlFrame(ordinaryCall), false);

  const ordinaryResult: MeshToolFrame = {
    kind: 'result',
    v: 1,
    ts: Date.now(),
    callId: 'tc-1',
    status: 'ok',
    result: { content: 'hi' },
  };
  assert.equal(decodeStageControl(ordinaryResult), null);
  assert.equal(isStageControlFrame(ordinaryResult), false);
});

test('decodeStageControl: rejects malformed stage frames (bad payload) without throwing', () => {
  const malformedLoad: MeshToolFrame = {
    kind: 'call',
    v: 1,
    ts: Date.now(),
    callId: 'c1',
    toolName: 'stage.load',
    args: { sessionId: 's1' /* missing everything else */ },
  };
  assert.equal(decodeStageControl(malformedLoad), null);
});

test('isStageControlFrame: true for stage kinds, false for ordinary tool traffic', () => {
  const load = encodeStageControl(makeStageLoad('s1', {
    modelId: 'm', layerStart: 0, layerEnd: 1, totalLayers: 2,
    includeEmbeddings: true, includeOutput: false, shardUrls: ['x'], wireDtype: 'f16', ctxSize: 512,
  }));
  assert.equal(isStageControlFrame(load), true);
  const token = encodeStageControl(makeStageToken('s1', 1, 0, false));
  assert.equal(isStageControlFrame(token), true);
});

// ── PendingToolCallTracker correlation flows ────────────────────────────────

test('tracker flow: stage.load -> stage.ready settles the waiter keyed by callId', async () => {
  const tracker = new PendingToolCallTracker();
  const sessionId = newSessionId();
  const load = makeStageLoad(sessionId, {
    modelId: 'm', layerStart: 0, layerEnd: 4, totalLayers: 8,
    includeEmbeddings: true, includeOutput: false, shardUrls: ['x'], wireDtype: 'f16', ctxSize: 512,
  });
  const waiter = tracker.expect(load.callId, 1000);
  // Simulate the host replying with stage.ready on the same callId, wrapped
  // as a MeshToolResult (settle() only cares about {callId, status, ...}).
  const ready = makeStageReady(sessionId, { isFirst: true, isFinal: false, nEmbd: 1024 }, load.callId);
  const resultFrame = encodeStageControl(ready) as { kind: 'result' } & import('../src/types.ts').MeshToolResult;
  const settled = tracker.settle(resultFrame);
  assert.equal(settled, true);
  const got = await waiter;
  assert.equal(got.callId, load.callId);
  const decoded = decodeStageControl({ kind: 'result', ...got });
  assert.equal(decoded?.kind, 'stage.ready');
});

test('tracker flow: stage.ping -> stage.pong settles the waiter', async () => {
  const tracker = new PendingToolCallTracker();
  const sessionId = newSessionId();
  const ping = makeStagePing(sessionId);
  const waiter = tracker.expect(ping.callId, 1000);
  const pong = makeStagePong(sessionId, ping.payload.sentAtMs, ping.callId);
  const resultFrame = encodeStageControl(pong) as { kind: 'result' } & import('../src/types.ts').MeshToolResult;
  tracker.settle(resultFrame);
  const got = await waiter;
  assert.equal(got.callId, ping.callId);
});

test('tracker flow: unresolved call rejects after timeout', async () => {
  const tracker = new PendingToolCallTracker();
  const callId = newCallId();
  await assert.rejects(tracker.expect(callId, 20), /timed out/);
});

// ── M2: stage.session.open / accept / busy ──────────────────────────────────

test('isStageSessionOpenPayload: requires wireHeader + a well-formed layer range', () => {
  const base = {
    sessionId: 's1',
    modelId: 'qwen3-0.6b-q8_0',
    layerStart: 0,
    layerEnd: 28,
    totalLayers: 28,
    ctxSize: 2048,
    wireDtype: 'f16' as const,
    wireHeader: 'YmFzZTY0aGVhZGVy',
  };
  assert.equal(isStageSessionOpenPayload(base), true);
  assert.equal(isStageSessionOpenPayload({ ...base, wireHeader: '' }), false);
  assert.equal(isStageSessionOpenPayload({ ...base, wireHeader: undefined }), false);
  assert.equal(isStageSessionOpenPayload({ ...base, layerEnd: 0 }), false);
  assert.equal(isStageSessionOpenPayload({ ...base, wireDtype: 'bogus' }), false);
});

test('isStageSessionAcceptPayload: requires positive nEmbd/activeSessions/maxSessions', () => {
  const base = { sessionId: 's1', nEmbd: 1024, isFirst: true, isFinal: true, activeSessions: 1, maxSessions: 4 };
  assert.equal(isStageSessionAcceptPayload(base), true);
  assert.equal(isStageSessionAcceptPayload({ ...base, nEmbd: 0 }), false);
  assert.equal(isStageSessionAcceptPayload({ ...base, maxSessions: 0 }), false);
  assert.equal(isStageSessionAcceptPayload({ ...base, activeSessions: -1 }), false);
  assert.equal(isStageSessionAcceptPayload({ ...base, isFirst: 'yes' }), false);
});

test('isStageSessionBusyPayload: queuePosition/estWaitMs are optional but must be well-typed when present', () => {
  assert.equal(isStageSessionBusyPayload({ sessionId: 's1' }), true);
  assert.equal(isStageSessionBusyPayload({ sessionId: 's1', queuePosition: 3 }), true);
  assert.equal(isStageSessionBusyPayload({ sessionId: 's1', queuePosition: -1 }), false);
  assert.equal(isStageSessionBusyPayload({ sessionId: 's1', estWaitMs: -5 }), false);
  assert.equal(isStageSessionBusyPayload({ sessionId: 's1', queuePosition: 1.5 }), false);
});

test('encodeStageControl/decodeStageControl round-trip: stage.session.open (call-shaped)', () => {
  const sessionId = newSessionId();
  const msg = makeStageSessionOpen(sessionId, {
    modelId: 'qwen3-0.6b-q8_0',
    layerStart: 0,
    layerEnd: 28,
    totalLayers: 28,
    ctxSize: 2048,
    wireDtype: 'f16',
    wireHeader: 'aGVhZGVyLWJ5dGVz',
  });
  const frame = encodeStageControl(msg);
  assert.equal(frame.kind, 'call');
  const decoded = decodeStageControl(frame);
  assert.ok(decoded);
  assert.equal(decoded!.kind, 'stage.session.open');
  assert.equal(decoded!.sessionId, sessionId);
  assert.deepEqual(decoded, msg);
});

test('encodeStageControl/decodeStageControl round-trip: stage.session.accept (result-shaped)', () => {
  const sessionId = newSessionId();
  const callId = newCallId();
  const msg = makeStageSessionAccept(sessionId, { nEmbd: 1024, isFirst: true, isFinal: true, activeSessions: 2, maxSessions: 4 }, callId);
  const frame = encodeStageControl(msg);
  assert.equal(frame.kind, 'result');
  const decoded = decodeStageControl(frame);
  assert.deepEqual(decoded, msg);
});

test('encodeStageControl/decodeStageControl round-trip: stage.session.busy, with and without queuePosition', () => {
  const sessionId = newSessionId();
  const callId = newCallId();
  const queued = makeStageSessionBusy(sessionId, { queuePosition: 2, estWaitMs: 4000 }, callId);
  assert.deepEqual(decodeStageControl(encodeStageControl(queued)), queued);

  const rejected = makeStageSessionBusy(sessionId, {}, callId);
  assert.deepEqual(decodeStageControl(encodeStageControl(rejected)), rejected);
  assert.equal((rejected.payload as { queuePosition?: number }).queuePosition, undefined);
});

test('isStageControlFrame: true for the new stage.session.* kinds', () => {
  const open = encodeStageControl(makeStageSessionOpen('s1', {
    modelId: 'm', layerStart: 0, layerEnd: 1, totalLayers: 1, ctxSize: 512, wireDtype: 'f16', wireHeader: 'aGk=',
  }));
  assert.equal(isStageControlFrame(open), true);
  const accept = encodeStageControl(makeStageSessionAccept('s1', { nEmbd: 8, isFirst: true, isFinal: true, activeSessions: 1, maxSessions: 1 }, 'c1'));
  assert.equal(isStageControlFrame(accept), true);
  const busy = encodeStageControl(makeStageSessionBusy('s1', {}, 'c1'));
  assert.equal(isStageControlFrame(busy), true);
});

test('tracker flow: stage.session.open -> stage.session.accept settles the waiter keyed by callId', async () => {
  const tracker = new PendingToolCallTracker();
  const sessionId = newSessionId();
  const open = makeStageSessionOpen(sessionId, {
    modelId: 'm', layerStart: 0, layerEnd: 4, totalLayers: 8, ctxSize: 512, wireDtype: 'f16', wireHeader: 'aGVhZA==',
  });
  const waiter = tracker.expect(open.callId, 1000);
  const accept = makeStageSessionAccept(sessionId, { nEmbd: 1024, isFirst: true, isFinal: false, activeSessions: 1, maxSessions: 4 }, open.callId);
  const resultFrame = encodeStageControl(accept) as { kind: 'result' } & import('../src/types.ts').MeshToolResult;
  const settled = tracker.settle(resultFrame);
  assert.equal(settled, true);
  const got = await waiter;
  const decoded = decodeStageControl({ kind: 'result', ...got });
  assert.equal(decoded?.kind, 'stage.session.accept');
});

test('tracker flow: stage.session.open -> stage.session.busy settles the waiter (host at capacity)', async () => {
  const tracker = new PendingToolCallTracker();
  const sessionId = newSessionId();
  const open = makeStageSessionOpen(sessionId, {
    modelId: 'm', layerStart: 0, layerEnd: 4, totalLayers: 8, ctxSize: 512, wireDtype: 'f16', wireHeader: 'aGVhZA==',
  });
  const waiter = tracker.expect(open.callId, 1000);
  const busy = makeStageSessionBusy(sessionId, { queuePosition: 1, estWaitMs: 2000 }, open.callId);
  const resultFrame = encodeStageControl(busy) as { kind: 'result' } & import('../src/types.ts').MeshToolResult;
  tracker.settle(resultFrame);
  const got = await waiter;
  const decoded = decodeStageControl({ kind: 'result', ...got });
  assert.equal(decoded?.kind, 'stage.session.busy');
  assert.equal((decoded as { payload: { queuePosition?: number } }).payload.queuePosition, 1);
});

test('decodeStageControl: rejects malformed stage.session.open (missing wireHeader) without throwing', () => {
  const malformed: MeshToolFrame = {
    kind: 'call',
    v: 1,
    ts: Date.now(),
    callId: 'c1',
    toolName: 'stage.session.open',
    args: { sessionId: 's1', modelId: 'm', layerStart: 0, layerEnd: 1, totalLayers: 1, ctxSize: 512, wireDtype: 'f16' },
  };
  assert.equal(decodeStageControl(malformed), null);
});

test('tracker flow: stage.token settles keyed by the seq-derived callId, not a preceding call', async () => {
  // stage.token has no preceding tc "call" — the driver mints the
  // callId itself (stageTokenCallId(sessionId, seq)) BEFORE sending the
  // sf frame, then the host's stage.token result echoes it back.
  const tracker = new PendingToolCallTracker();
  const sessionId = 's1';
  const seq = 7;
  const waiter = tracker.expect(stageTokenCallId(sessionId, seq), 1000);
  const token = makeStageToken(sessionId, 99, seq, false);
  assert.equal(token.callId, stageTokenCallId(sessionId, seq));
  const resultFrame = encodeStageControl(token) as { kind: 'result' } & import('../src/types.ts').MeshToolResult;
  const settled = tracker.settle(resultFrame);
  assert.equal(settled, true);
  const got = await waiter;
  const decoded = decodeStageControl({ kind: 'result', ...got });
  assert.equal(decoded?.kind, 'stage.token');
  assert.equal((decoded as { payload: { token: number } }).payload.token, 99);
});

test('stage.load.progress: round-trips as a result-shaped push and guards phase', async () => {
  const msg = makeStageLoadProgress('s1', {
    shardsFetched: 24,
    totalShards: 36,
    bytesFetched: 2_600_000_000,
    totalBytes: 4_425_000_000,
    phase: 'downloading',
  });
  // Fresh callId (never a load's) so it can't settle a ready/accept waiter.
  assert.ok(msg.callId.startsWith('tc-'));
  const frame = encodeStageControl(msg);
  assert.equal(frame.kind, 'result');
  const decoded = decodeStageControl(frame);
  assert.equal(decoded?.kind, 'stage.load.progress');
  assert.equal((decoded as { payload: { shardsFetched: number } }).payload.shardsFetched, 24);
  assert.equal((decoded as { payload: { phase?: string } }).payload.phase, 'downloading');

  // phase is optional (absent is valid — an old/plain host may omit it).
  const noPhase = makeStageLoadProgress('s2', { shardsFetched: 1, totalShards: 2, bytesFetched: 10 });
  assert.equal(decodeStageControl(encodeStageControl(noPhase))?.kind, 'stage.load.progress');

  // A bad phase is rejected (guard), not silently accepted.
  const badPhase = encodeStageControl(noPhase) as { kind: 'result'; result: { payload: Record<string, unknown> } };
  (badPhase.result.payload as Record<string, unknown>).phase = 'bogus';
  assert.equal(decodeStageControl(badPhase as never), null);
});

test('PendingToolCallTracker.resetTimeout: each reset pushes the deadline out (progress keeps a slow call alive)', async () => {
  const tracker = new PendingToolCallTracker();
  const callId = newCallId();
  const waiter = tracker.expect(callId, 60).catch((e: Error) => `rejected:${e.message}`);
  // Reset every 30ms, five times — total 150ms > the 60ms base window, but
  // no 60ms gap ever elapses, so it must NOT time out.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(tracker.resetTimeout(callId, 60), true);
  }
  // Now settle it cleanly — it survived all the resets.
  const settled = tracker.settle({ v: 1, ts: Date.now(), callId, status: 'ok', result: {} } as never);
  assert.equal(settled, true);
  const got = await waiter;
  assert.notEqual(typeof got === 'string' && got.startsWith('rejected'), true);
});

test('PendingToolCallTracker.rejectCall: rejects one specific call (ceiling backstop) without touching others', async () => {
  const tracker = new PendingToolCallTracker();
  const a = newCallId();
  const b = newCallId();
  const wa = tracker.expect(a, 10_000).then(() => 'a-resolved').catch((e: Error) => `a:${e.message}`);
  const wb = tracker.expect(b, 10_000).then(() => 'b-resolved').catch((e: Error) => `b:${e.message}`);
  assert.equal(tracker.rejectCall(a, 'ceiling exceeded'), true);
  assert.equal(await wa, 'a:ceiling exceeded');
  // b is untouched and still pending — settle it to prove it wasn't rejected.
  assert.equal(tracker.settle({ v: 1, ts: Date.now(), callId: b, status: 'ok', result: {} } as never), true);
  assert.equal(await wb, 'b-resolved');
  // rejectCall on an unknown id is a no-op.
  assert.equal(tracker.rejectCall('nope', 'x'), false);
});
