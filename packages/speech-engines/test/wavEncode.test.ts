/**
 * `encodeWav` unit tests — RIFF/WAVE header fields, sample count, and a
 * round-trip of a known buffer through the format's own byte layout
 * (no browser `decodeAudioData` available under node `--test`, so the
 * "round trip" here is decoding the WAV bytes back to int16 samples by
 * hand and checking they match the encoder's own quantization).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav } from '../src/wavEncode.ts';

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

test('header: RIFF/WAVE/fmt /data chunk ids and sizes', () => {
  const pcm = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const sampleRate = 16000;
  const wav = encodeWav(pcm, sampleRate);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

  assert.equal(readAscii(view, 0, 4), 'RIFF');
  assert.equal(readAscii(view, 8, 4), 'WAVE');
  assert.equal(readAscii(view, 12, 4), 'fmt ');
  assert.equal(readAscii(view, 36, 4), 'data');

  const dataSize = pcm.length * 2;
  assert.equal(view.getUint32(4, true), 36 + dataSize); // RIFF chunk size
  assert.equal(view.getUint32(16, true), 16); // fmt chunk size
  assert.equal(view.getUint16(20, true), 1); // PCM format tag
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), sampleRate);
  assert.equal(view.getUint32(28, true), sampleRate * 2); // byte rate
  assert.equal(view.getUint16(32, true), 2); // block align
  assert.equal(view.getUint16(34, true), 16); // bits per sample
  assert.equal(view.getUint32(40, true), dataSize);
});

test('sample count: total byte length matches 44-byte header + 16-bit mono samples', () => {
  const pcm = new Float32Array(100).fill(0);
  const wav = encodeWav(pcm, 24000);
  assert.equal(wav.byteLength, 44 + 100 * 2);
});

test('round trip: known samples quantize to the expected int16 values', () => {
  const pcm = new Float32Array([0, 1, -1, 0.5, -0.5]);
  const wav = encodeWav(pcm, 24000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

  const decoded: number[] = [];
  for (let i = 0; i < pcm.length; i++) decoded.push(view.getInt16(44 + i * 2, true));

  assert.equal(decoded[0], 0);
  assert.equal(decoded[1], 0x7fff);
  assert.equal(decoded[2], -0x8000);
  assert.equal(decoded[3], Math.round(0.5 * 0x7fff));
  assert.equal(decoded[4], Math.round(-0.5 * 0x8000));
});

test('clamps out-of-range samples instead of overflowing', () => {
  const pcm = new Float32Array([2, -2]);
  const wav = encodeWav(pcm, 24000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getInt16(44, true), 0x7fff);
  assert.equal(view.getInt16(46, true), -0x8000);
});
