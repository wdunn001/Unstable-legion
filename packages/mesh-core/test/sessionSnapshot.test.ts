import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSnapshotIdentity,
  isSessionSnapshotEnvelope,
  snapshotRestoreVerdict,
  encodeSnapshotChunk,
  decodeSnapshotChunk,
  SnapshotReassembler,
  planSnapshotHandoff,
  type SnapshotIdentity,
  type SessionSnapshotEnvelope,
} from '../src/sessionSnapshot.js';
import {
  encodeStageControl,
  decodeStageControl,
  isStageControlFrame,
  makeStageSnapshotRequest,
  makeStageSnapshotOffer,
  makeStageRestore,
  makeStageRestoreAck,
} from '../src/stageControl.js';

const identity = (over: Partial<SnapshotIdentity> = {}): SnapshotIdentity => ({
  modelId: 'qwen3-8b-q4',
  stateSchema: 'llama-kv-v1',
  numericClass: 'wgpu-f16-r0',
  layerStart: 8,
  layerEnd: 16,
  ...over,
});

const envelope = (over: Partial<SessionSnapshotEnvelope> = {}): SessionSnapshotEnvelope => ({
  ...identity(),
  sessionId: 'sess-a',
  tokensDecoded: 42,
  totalBytes: 9,
  chunkCount: 2,
  ...over,
});

// ── the restore gate ────────────────────────────────────────────────────

test('restore accepts an exactly-matching identity', () => {
  const v = snapshotRestoreVerdict(identity(), identity());
  assert.equal(v.ok, true);
  assert.equal(v.reason, null);
});

test('restore refuses each identity field independently', () => {
  const cases: Array<[Partial<SnapshotIdentity>, string]> = [
    [{ modelId: 'qwen3-14b-q4' }, 'model-mismatch'],
    [{ stateSchema: 'llama-kv-v2' }, 'state-schema-mismatch'],
    [{ numericClass: 'wgpu-f32-r0' }, 'numeric-class-mismatch'],
    [{ layerEnd: 24 }, 'range-mismatch'],
    [{ layerStart: 0 }, 'range-mismatch'],
  ];
  for (const [over, reason] of cases) {
    const v = snapshotRestoreVerdict(identity(), identity(over));
    assert.equal(v.ok, false, `${reason} should refuse`);
    assert.equal(v.reason, reason);
    assert.ok(v.detail.length > 0, 'refusal must explain itself');
  }
});

test('a numeric-class difference is refused even when everything else matches', () => {
  // The failure this field exists for: same model, same schema, same range,
  // different reduction order. The bytes decode; the tokens diverge.
  const snap = identity();
  const target = identity({ numericClass: 'wgpu-f16-r1' });
  assert.equal(snapshotRestoreVerdict(snap, target).reason, 'numeric-class-mismatch');
});

test('a superset range is refused rather than silently adopted', () => {
  // A peer owning layers 8..24 still cannot adopt state captured over 8..16.
  const v = snapshotRestoreVerdict(identity({ layerEnd: 16 }), identity({ layerEnd: 24 }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'range-mismatch');
});

// ── envelope guards ─────────────────────────────────────────────────────

test('identity guard rejects malformed shapes', () => {
  assert.equal(isSnapshotIdentity(identity()), true);
  assert.equal(isSnapshotIdentity(null), false);
  assert.equal(isSnapshotIdentity({ ...identity(), modelId: '' }), false);
  assert.equal(isSnapshotIdentity({ ...identity(), numericClass: 42 }), false);
  assert.equal(isSnapshotIdentity({ ...identity(), layerStart: -1 }), false);
  // An empty or inverted range is not a segment.
  assert.equal(isSnapshotIdentity({ ...identity(), layerStart: 16, layerEnd: 16 }), false);
  assert.equal(isSnapshotIdentity({ ...identity(), layerStart: 20, layerEnd: 16 }), false);
});

test('envelope guard ties chunkCount to totalBytes', () => {
  assert.equal(isSessionSnapshotEnvelope(envelope()), true);
  assert.equal(isSessionSnapshotEnvelope(envelope({ totalBytes: 0, chunkCount: 0 })), true);
  // A non-empty payload in zero chunks, or an empty one in some chunks,
  // is a truncated or padded transfer.
  assert.equal(isSessionSnapshotEnvelope(envelope({ totalBytes: 9, chunkCount: 0 })), false);
  assert.equal(isSessionSnapshotEnvelope(envelope({ totalBytes: 0, chunkCount: 2 })), false);
  assert.equal(isSessionSnapshotEnvelope(envelope({ tokensDecoded: -1 })), false);
});

// ── chunk framing ───────────────────────────────────────────────────────

test('chunk round-trips with its index, count and bytes intact', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const wire = encodeSnapshotChunk({ sessionId: 'sess-a', chunkIndex: 1, chunkCount: 3, bytes });
  const back = decodeSnapshotChunk(wire);
  assert.ok(back);
  assert.equal(back.sessionId, 'sess-a');
  assert.equal(back.chunkIndex, 1);
  assert.equal(back.chunkCount, 3);
  assert.deepEqual([...back.bytes], [1, 2, 3, 4, 5]);
});

test('chunk survives a multi-byte sessionId', () => {
  const wire = encodeSnapshotChunk({
    sessionId: 'sess-é中',
    chunkIndex: 0,
    chunkCount: 1,
    bytes: new Uint8Array([7]),
  });
  assert.equal(decodeSnapshotChunk(wire)?.sessionId, 'sess-é中');
});

test('encode rejects an out-of-range index', () => {
  const bytes = new Uint8Array([0]);
  assert.throws(() => encodeSnapshotChunk({ sessionId: 's', chunkIndex: 3, chunkCount: 3, bytes }), RangeError);
  assert.throws(() => encodeSnapshotChunk({ sessionId: 's', chunkIndex: 0, chunkCount: 0, bytes }), RangeError);
  assert.throws(() => encodeSnapshotChunk({ sessionId: '', chunkIndex: 0, chunkCount: 1, bytes }), RangeError);
});

test('decode returns null on garbage rather than throwing', () => {
  assert.equal(decodeSnapshotChunk(new Uint8Array([])), null);
  assert.equal(decodeSnapshotChunk(new Uint8Array([1, 2, 3])), null);
  // Truncated: header claims a sessionId longer than the buffer holds.
  const truncated = new Uint8Array(10);
  new DataView(truncated.buffer).setUint16(0, 0xff, true);
  assert.equal(decodeSnapshotChunk(truncated), null);
});

test('decode rejects a chunk whose index exceeds its count', () => {
  const wire = encodeSnapshotChunk({ sessionId: 's', chunkIndex: 0, chunkCount: 2, bytes: new Uint8Array([1]) });
  // Corrupt the index in place to 5 with count still 2.
  const idLen = new DataView(wire.buffer).getUint16(0, true);
  new DataView(wire.buffer).setUint32(2 + idLen, 5, true);
  assert.equal(decodeSnapshotChunk(wire), null);
});

// ── reassembly ──────────────────────────────────────────────────────────

test('reassembles chunks arriving out of order', () => {
  const r = new SnapshotReassembler();
  assert.equal(r.accept({ sessionId: 's', chunkIndex: 2, chunkCount: 3, bytes: new Uint8Array([5, 6]) }), true);
  assert.equal(r.complete, false);
  r.accept({ sessionId: 's', chunkIndex: 0, chunkCount: 3, bytes: new Uint8Array([1, 2]) });
  r.accept({ sessionId: 's', chunkIndex: 1, chunkCount: 3, bytes: new Uint8Array([3, 4]) });
  assert.equal(r.complete, true);
  assert.deepEqual([...(r.take() as Uint8Array)], [1, 2, 3, 4, 5, 6]);
});

test('reassembler rejects a chunk that disagrees on the count', () => {
  const r = new SnapshotReassembler();
  r.accept({ sessionId: 's', chunkIndex: 0, chunkCount: 3, bytes: new Uint8Array([1]) });
  assert.equal(r.accept({ sessionId: 's', chunkIndex: 0, chunkCount: 4, bytes: new Uint8Array([1]) }), false);
});

test('take returns null while chunks are missing and resets after success', () => {
  const r = new SnapshotReassembler();
  r.accept({ sessionId: 's', chunkIndex: 0, chunkCount: 2, bytes: new Uint8Array([1]) });
  assert.equal(r.take(), null);
  r.accept({ sessionId: 's', chunkIndex: 1, chunkCount: 2, bytes: new Uint8Array([2]) });
  assert.deepEqual([...(r.take() as Uint8Array)], [1, 2]);
  assert.equal(r.complete, false, 'take must reset');
  assert.equal(r.take(), null);
});

// ── control-message wiring ──────────────────────────────────────────────

test('snapshot.request round-trips as a call frame', () => {
  const msg = makeStageSnapshotRequest('sess-a');
  const frame = encodeStageControl(msg);
  assert.equal(frame.kind, 'call');
  assert.equal(isStageControlFrame(frame), true);
  const back = decodeStageControl(frame);
  assert.equal(back?.kind, 'stage.snapshot.request');
  assert.equal(back?.sessionId, 'sess-a');
});

test('snapshot.offer round-trips as a result frame carrying the envelope', () => {
  const env = envelope();
  const frame = encodeStageControl(makeStageSnapshotOffer(env, 'call-1'));
  assert.equal(frame.kind, 'result');
  const back = decodeStageControl(frame);
  assert.equal(back?.kind, 'stage.snapshot.offer');
  assert.deepEqual(back?.payload, env);
});

test('restore round-trips with a nested envelope and a re-keyed session', () => {
  const env = envelope({ sessionId: 'sess-old' });
  const frame = encodeStageControl(makeStageRestore('sess-new', env));
  const back = decodeStageControl(frame);
  assert.equal(back?.kind, 'stage.restore');
  assert.equal(back?.sessionId, 'sess-new');
  assert.equal((back?.payload as { envelope: SessionSnapshotEnvelope }).envelope.sessionId, 'sess-old');
});

test('restore.ack round-trips both verdicts', () => {
  const okFrame = encodeStageControl(makeStageRestoreAck('sess-a', { accepted: true }, 'c1'));
  assert.equal(decodeStageControl(okFrame)?.kind, 'stage.restore.ack');

  const noFrame = encodeStageControl(
    makeStageRestoreAck('sess-a', { accepted: false, reason: 'numeric-class-mismatch', detail: 'x vs y' }, 'c2'),
  );
  const back = decodeStageControl(noFrame);
  assert.equal((back?.payload as { reason: string }).reason, 'numeric-class-mismatch');
});

test('a refusal without a reason is rejected on the wire', () => {
  // Hand-built because makeStageRestoreAck's callers are typed; a buggy or
  // hostile peer is not.
  const frame = encodeStageControl({
    kind: 'stage.restore.ack',
    callId: 'c3',
    sessionId: 'sess-a',
    payload: { sessionId: 'sess-a', accepted: false },
  });
  assert.equal(decodeStageControl(frame), null);
});

test('an acceptance carrying a reason is rejected on the wire', () => {
  const frame = encodeStageControl({
    kind: 'stage.restore.ack',
    callId: 'c4',
    sessionId: 'sess-a',
    payload: { sessionId: 'sess-a', accepted: true, reason: 'model-mismatch' },
  });
  assert.equal(decodeStageControl(frame), null);
});

test('a restore carrying a malformed envelope is rejected on the wire', () => {
  const frame = encodeStageControl({
    kind: 'stage.restore',
    callId: 'c5',
    sessionId: 'sess-a',
    payload: { sessionId: 'sess-a', envelope: { ...envelope(), numericClass: '' } },
  });
  assert.equal(decodeStageControl(frame), null);
});

// ── handoff policy ──────────────────────────────────────────────────────

test('handoff re-prefills when there is no snapshot', () => {
  const d = planSnapshotHandoff(null, identity(), 500);
  assert.equal(d.action, 'reprefill');
  assert.match(d.reason, /no snapshot/);
});

test('handoff re-prefills when the identity does not match', () => {
  const d = planSnapshotHandoff(envelope({ tokensDecoded: 400 }), identity({ numericClass: 'other' }), 500);
  assert.equal(d.action, 'reprefill');
  assert.match(d.reason, /numeric class/);
});

test('handoff restores when the snapshot covers most of the session', () => {
  const d = planSnapshotHandoff(envelope({ tokensDecoded: 480 }), identity(), 500);
  assert.equal(d.action, 'restore');
  assert.equal(d.replaySteps, 20);
});

test('handoff re-prefills when the snapshot saves too little to ship', () => {
  // Twenty tokens into a long conversation the transfer costs more than
  // the replay it avoids.
  const d = planSnapshotHandoff(envelope({ tokensDecoded: 4 }), identity(), 2000);
  assert.equal(d.action, 'reprefill');
  assert.match(d.reason, /below the 16 threshold/);
});

test('handoff threshold is tunable', () => {
  const snap = envelope({ tokensDecoded: 4 });
  assert.equal(planSnapshotHandoff(snap, identity(), 2000, { minStepsSaved: 2 }).action, 'restore');
});

test('handoff refuses a snapshot from ahead of the session', () => {
  // Driver and host disagree on position. Guessing would corrupt the run.
  const d = planSnapshotHandoff(envelope({ tokensDecoded: 900 }), identity(), 500);
  assert.equal(d.action, 'reprefill');
  assert.match(d.reason, /ahead of the session/);
});

test('handoff refuses an empty snapshot even when it is compatible', () => {
  const d = planSnapshotHandoff(envelope({ tokensDecoded: 400, totalBytes: 0, chunkCount: 0 }), identity(), 500);
  assert.equal(d.action, 'reprefill');
  assert.match(d.reason, /no state/);
});

test('a restore at the current position replays nothing', () => {
  const d = planSnapshotHandoff(envelope({ tokensDecoded: 500 }), identity(), 500);
  assert.equal(d.action, 'restore');
  assert.equal(d.replaySteps, 0);
});
