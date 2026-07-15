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
  makeStageLoad,
  makeStageReady,
  makeStagePing,
  makeStagePong,
  makeStageStop,
  makeStageProgress,
  makeStageToken,
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
