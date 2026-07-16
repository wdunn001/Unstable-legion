/**
 * User-chat wire tests — encode/decode round-trip through compression,
 * transport-injected identity/time, dedup/replay suppression, and id
 * sequencing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import {
  encodeUserChatWire,
  decodeUserChatWire,
  createUserChatIdSequencer,
  newUserChatId,
  userChatDedupKey,
  SeenSet,
  type UserChatMessage,
} from '../src/userChat.ts';

function msg(overrides: Partial<UserChatMessage> = {}): UserChatMessage {
  return {
    v: 1,
    id: '0',
    ts: 111,
    from: 'SELF-abc',
    nick: 'ada',
    to: '',
    text: 'on my way',
    ...overrides,
  };
}

// ── Wire round-trip ──────────────────────────────────────────────────────────

test('encode/decode: round-trips text, nick, to, id — from/ts injected by transport', () => {
  const wire = encodeUserChatWire(msg({ text: 'the mesh looks healthy from here', nick: 'grace', to: 'peerX' }));
  const back = decodeUserChatWire(wire, { from: 'PEER-999', ts: 42 });
  assert.ok(back);
  assert.equal(back!.text, 'the mesh looks healthy from here');
  assert.equal(back!.nick, 'grace');
  assert.equal(back!.to, 'peerX');
  assert.equal(back!.id, '0');
  // Transport-supplied, NOT the encoder's values.
  assert.equal(back!.from, 'PEER-999', 'from comes from the transport peerId, not the wire');
  assert.equal(back!.ts, 42, 'ts is the receive clock, not the sender wire value');
});

test('decode: ts defaults to now when the transport omits it', () => {
  const wire = encodeUserChatWire(msg());
  const before = Date.now();
  const back = decodeUserChatWire(wire, { from: 'P' });
  assert.ok(back!.ts >= before);
});

test('encode/decode: carries an optional safety verdict', () => {
  const wire = encodeUserChatWire(msg({ safety: { source: 'prefilter', category: 'pii', confidence: 1 } }));
  const back = decodeUserChatWire(wire, { from: 'P' });
  assert.deepEqual(back!.safety, { source: 'prefilter', category: 'pii', confidence: 1 });
});

test('decode: returns null on undecodable bytes', () => {
  assert.equal(decodeUserChatWire(new Uint8Array(0), { from: 'P' }), null);
  assert.equal(decodeUserChatWire(new Uint8Array([0x00, 0xff, 0xff]), { from: 'P' }), null); // identity tag, garbage msgpack
  assert.equal(decodeUserChatWire('nope' as unknown, { from: 'P' }), null);
});

test('decode: rejects a wrong-version / malformed frame shape', () => {
  // Hand-craft a valid msgpack+identity frame with a bad version.
  const raw = msgpackEncode({ v: 2, i: '0', n: 'ada', o: '', x: 'hi' });
  const framed = new Uint8Array(raw.length + 1);
  framed[0] = 0x00; // identity tag
  framed.set(raw, 1);
  assert.equal(decodeUserChatWire(framed, { from: 'P' }), null);
});

// ── Id sequencing ────────────────────────────────────────────────────────────

test('createUserChatIdSequencer: yields short, strictly-increasing, unique ids', () => {
  const next = createUserChatIdSequencer();
  const ids = Array.from({ length: 40 }, () => next());
  assert.equal(new Set(ids).size, 40, 'all unique within a session');
  assert.equal(ids[0], '0');
  assert.equal(ids[1], '1');
  assert.ok(ids.every((id) => id.length <= 2), 'short (1-2 chars) for the first tranche');
});

test('userChatDedupKey: composes the globally-unique (from, id) pair', () => {
  assert.equal(userChatDedupKey('SELF-a', '5'), 'SELF-a:5');
  // Same counter value from two different senders is NOT a collision.
  assert.notEqual(userChatDedupKey('SELF-a', '5'), userChatDedupKey('SELF-b', '5'));
});

test('newUserChatId: standalone ids are unique', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newUserChatId()));
  assert.equal(ids.size, 200);
});

// ── Dedup / replay suppression ───────────────────────────────────────────────

test('SeenSet: first sighting passes, every repeat is suppressed', () => {
  const seen = new SeenSet();
  assert.equal(seen.check('a:1'), true, 'new id admitted');
  assert.equal(seen.check('a:1'), false, 'replay dropped');
  assert.equal(seen.check('a:1'), false);
  assert.equal(seen.check('a:2'), true, 'a different id admitted');
  assert.equal(seen.has('a:1'), true);
  assert.equal(seen.has('a:99'), false);
});

test('SeenSet: bounded FIFO eviction keeps memory flat over a long-lived room', () => {
  const seen = new SeenSet(4);
  for (const id of ['1', '2', '3', '4']) assert.equal(seen.check(id), true);
  assert.equal(seen.size, 4);
  assert.equal(seen.check('5'), true); // evicts '1'
  assert.equal(seen.size, 4, 'size capped');
  assert.equal(seen.check('1'), true, "'1' was evicted, so it reads as new again");
});

test('SeenSet: dedup works end-to-end with the composed key of a decoded message', () => {
  const seen = new SeenSet();
  const wire = encodeUserChatWire(msg({ id: '7' }));
  const a = decodeUserChatWire(wire, { from: 'PEER-1' })!;
  const b = decodeUserChatWire(wire, { from: 'PEER-1' })!; // same peer replays the same frame
  assert.equal(seen.check(userChatDedupKey(a.from, a.id)), true);
  assert.equal(seen.check(userChatDedupKey(b.from, b.id)), false, 'replay from the same peer dropped');
  // The identical id from a DIFFERENT peer is a distinct message, not a dup.
  const c = decodeUserChatWire(wire, { from: 'PEER-2' })!;
  assert.equal(seen.check(userChatDedupKey(c.from, c.id)), true);
});
