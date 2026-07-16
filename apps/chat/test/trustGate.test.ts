import test from 'node:test';
import assert from 'node:assert/strict';
import { ACK_PENDING_ROUTE, hostSetKey, needsTrustAck, remoteHostPeerIds } from '../src/trustStatement.ts';

test('hostSetKey: order-independent, de-duplicated', () => {
  assert.equal(hostSetKey(['b', 'a']), hostSetKey(['a', 'b']));
  assert.equal(hostSetKey(['a', 'a', 'b']), hostSetKey(['a', 'b']));
});

test('remoteHostPeerIds: excludes the local stage-0, includes remotes', () => {
  const plan = {
    stages: [
      { stageIndex: 0, peerId: 'self' },
      { stageIndex: 1, peerId: 'host-a' },
      { stageIndex: 2, peerId: 'host-b' },
    ],
  };
  assert.deepEqual(remoteHostPeerIds(plan), ['host-a', 'host-b']);
  assert.deepEqual(remoteHostPeerIds(undefined), []);
});

test('needsTrustAck: never acked -> true', () => {
  assert.equal(needsTrustAck(null, undefined), true);
  assert.equal(needsTrustAck(null, 'host-a'), true);
});

test('needsTrustAck: acked but route unresolved (pending sentinel) -> false', () => {
  assert.equal(needsTrustAck(ACK_PENDING_ROUTE, undefined), false);
  assert.equal(needsTrustAck(ACK_PENDING_ROUTE, 'host-a'), false);
});

test('needsTrustAck: acked against a key, no current plan yet -> false', () => {
  assert.equal(needsTrustAck('host-a', undefined), false);
});

test('needsTrustAck: acked against a key, plan matches -> false', () => {
  assert.equal(needsTrustAck('host-a', 'host-a'), false);
});

test('needsTrustAck: acked against a key, plan now differs -> true (host-set change re-prompt)', () => {
  assert.equal(needsTrustAck('host-a', 'host-b'), true);
  assert.equal(needsTrustAck(hostSetKey(['host-a', 'host-b']), hostSetKey(['host-a'])), true);
});
