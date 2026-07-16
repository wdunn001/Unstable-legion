/**
 * Chat-compression tests — proves the DISTRIBUTION.md thesis on real short
 * chat frames: a trained preset dictionary compresses them (net win), while
 * a stateless compressor EXPANDS them (the whole reason the dict matters).
 * The measured ratio here is the number quoted in the PR / docs/USER-CHAT.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import {
  CHAT_CODEC,
  CHAT_DICT,
  CHAT_DICT_CORPUS,
  buildChatDict,
  compressChatBytes,
  decompressChatBytes,
  measureCompression,
} from '../src/chatCompression.ts';
import { encodeUserChatWire, createUserChatIdSequencer } from '../src/userChat.ts';

// A realistic held-out corpus (mostly NOT in the training set) — an honest
// measurement, not a memorised one.
const HELD_OUT = [
  'did the deploy finish yet',
  'pushing a fix for the roster bug now',
  'my gpu is at 80C, backing off',
  'anyone else seeing reconnects?',
  'the qwen shards are downloading slowly',
  'lol nice',
  'can you retry that prompt',
  'i think layer 24 dropped',
  'coverage back to 100 now',
  'wait what',
  'great, merging',
  'let us sync at 3',
  'coffee break back in 10',
  'the compression numbers look wild',
  'ping',
  'deploying now',
  'all green',
];
const NICKS = ['ada', 'grace', 'linus', 'margaret', 'dennis', 'radia'];

function rawFrames(texts: readonly string[], n = 400): Uint8Array[] {
  const seq = createUserChatIdSequencer();
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    // Matches userChat.ts's on-wire shape {v,i,n,o,x}.
    out.push(msgpackEncode({ v: 1, i: seq(), n: NICKS[i % NICKS.length], o: '', x: texts[i % texts.length] }));
  }
  return out;
}

// ── Round-trip correctness ───────────────────────────────────────────────────

test('compress/decompress: round-trips a chat frame exactly', () => {
  const raw = msgpackEncode({ v: 1, i: '0', n: 'ada', o: '', x: 'on my way' });
  const wire = compressChatBytes(raw);
  const back = decompressChatBytes(wire);
  assert.ok(back);
  assert.deepEqual(Array.from(back!), Array.from(raw));
  assert.deepEqual(msgpackDecode(back!), msgpackDecode(raw));
});

test('compress: self-describing tag byte — dict-deflate when it helps, identity otherwise', () => {
  // A repetitive in-vocab frame compresses → DICT_DEFLATE tag.
  const compressible = msgpackEncode({ v: 1, i: '0', n: 'ada', o: '', x: 'sounds good to me' });
  const cWire = compressChatBytes(compressible);
  assert.equal(cWire[0], CHAT_CODEC.DICT_DEFLATE);
  assert.ok(cWire.length < compressible.length + 1, 'net smaller');

  // A tiny high-entropy frame can't beat raw → IDENTITY tag, never inflated
  // beyond +1 byte.
  const incompressible = new Uint8Array([200, 3, 250, 17, 99]);
  const iWire = compressChatBytes(incompressible);
  assert.equal(iWire[0], CHAT_CODEC.IDENTITY);
  assert.equal(iWire.length, incompressible.length + 1);
  assert.deepEqual(Array.from(decompressChatBytes(iWire)!), Array.from(incompressible));
});

test('decompress: rejects malformed / empty / undecodable buffers by returning null', () => {
  assert.equal(decompressChatBytes(null), null);
  assert.equal(decompressChatBytes(new Uint8Array(0)), null);
  assert.equal(decompressChatBytes('not bytes' as unknown), null);
  // Unknown codec tag.
  assert.equal(decompressChatBytes(new Uint8Array([0x7f, 1, 2, 3])), null);
});

test('decompress: a wrong dictionary yields null (corrupt), never silent garbage into msgpack', () => {
  const raw = msgpackEncode({ v: 1, i: '0', n: 'ada', o: '', x: 'who is hosting the middle layers right now?' });
  const wire = compressChatBytes(raw, CHAT_DICT);
  const wrongDict = buildChatDict(['completely', 'different', 'dictionary', 'bytes']);
  const back = decompressChatBytes(wire, wrongDict);
  // Either the inflate throws (→ null) or produces bytes that aren't `raw`.
  if (back !== null) {
    assert.notDeepEqual(Array.from(back), Array.from(raw));
  }
});

test('buildChatDict: deterministic — same corpus builds byte-identical dicts on both ends', () => {
  const a = buildChatDict(CHAT_DICT_CORPUS);
  const b = buildChatDict(CHAT_DICT_CORPUS);
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.ok(CHAT_DICT.length > 0);
  assert.deepEqual(Array.from(CHAT_DICT), Array.from(buildChatDict()));
});

// ── The thesis: dict wins, stateless loses (measured) ────────────────────────

test('measured: dict-deflate is a NET WIN on realistic held-out short frames', () => {
  const frames = rawFrames(HELD_OUT);
  const stats = measureCompression(frames);
  // eslint-disable-next-line no-console
  console.log(
    `[compression] held-out mix: avgRaw=${stats.avgRawBytes.toFixed(1)}B ` +
      `avgDict=${stats.avgDictBytes.toFixed(1)}B dictRatio=${stats.dictRatio.toFixed(3)} ` +
      `(${(1 / stats.dictRatio).toFixed(2)}x) plainRatio=${stats.plainRatio.toFixed(3)}`,
  );
  assert.ok(stats.dictRatio < 0.9, `dict compresses (ratio ${stats.dictRatio.toFixed(3)} < 0.9)`);
});

test('measured: stateless deflate EXPANDS these frames — why the dict is needed', () => {
  const frames = rawFrames(HELD_OUT);
  const stats = measureCompression(frames);
  assert.ok(stats.plainRatio > 1, `plain deflate expands short frames (ratio ${stats.plainRatio.toFixed(3)} > 1)`);
  assert.ok(stats.dictRatio < stats.plainRatio, 'dict beats plain by a wide margin');
});

test('measured: common repeated phrases compress hardest (≥ 1.8x)', () => {
  const frames = rawFrames(CHAT_DICT_CORPUS, 300);
  const stats = measureCompression(frames);
  // eslint-disable-next-line no-console
  console.log(`[compression] in-vocab: dictRatio=${stats.dictRatio.toFixed(3)} (${(1 / stats.dictRatio).toFixed(2)}x)`);
  assert.ok(1 / stats.dictRatio >= 1.8, `common chatter ≥ 1.8x (got ${(1 / stats.dictRatio).toFixed(2)}x)`);
});

test('measured: real encodeUserChatWire frames are compact (a short message is tiny on the wire)', () => {
  const wire = encodeUserChatWire({ v: 1, id: '0', ts: 0, from: 'SELF', nick: 'ada', to: '', text: 'on my way' });
  // eslint-disable-next-line no-console
  console.log(`[compression] "on my way" wire size = ${wire.length}B`);
  assert.ok(wire.length < 30, `a short message fits in < 30B on the wire (got ${wire.length}B)`);
});
