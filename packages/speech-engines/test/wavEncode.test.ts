/**
 * `encodeWav`/`encodeWavBase64` unit tests — pure container-building
 * logic, no WebAudio/engine involved (mirrors `splitForTts.test.ts`'s
 * "no real engine" scope note).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, encodeWavBase64 } from '../src/wavEncode.ts';

function readAscii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

test('encodeWav: byte length is 44-byte header + 16-bit samples', () => {
  const pcm = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const wav = encodeWav(pcm, 16000);
  assert.equal(wav.byteLength, 44 + pcm.length * 2);
});

test('encodeWav: RIFF/WAVE/fmt /data header fields are well-formed', () => {
  const pcm = new Float32Array(100).fill(0);
  const sampleRate = 16000;
  const wav = encodeWav(pcm, sampleRate);
  const view = new DataView(wav);

  assert.equal(readAscii(view, 0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), 36 + pcm.length * 2);
  assert.equal(readAscii(view, 8, 4), 'WAVE');
  assert.equal(readAscii(view, 12, 4), 'fmt ');
  assert.equal(view.getUint32(16, true), 16); // PCM fmt chunk size
  assert.equal(view.getUint16(20, true), 1); // audio format = PCM
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), sampleRate);
  assert.equal(view.getUint32(28, true), sampleRate * 2); // byteRate
  assert.equal(view.getUint16(32, true), 2); // blockAlign
  assert.equal(view.getUint16(34, true), 16); // bits per sample
  assert.equal(readAscii(view, 36, 4), 'data');
  assert.equal(view.getUint32(40, true), pcm.length * 2);
});

test('encodeWav: samples round-trip through 16-bit PCM (clamped to [-1, 1])', () => {
  const pcm = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
  const wav = encodeWav(pcm, 16000);
  const view = new DataView(wav);
  let offset = 44;
  for (let i = 0; i < pcm.length; i++, offset += 2) {
    const sample = view.getInt16(offset, true);
    const clamped = Math.max(-1, Math.min(1, pcm[i]));
    const expected = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    assert.ok(Math.abs(sample - expected) <= 1, `sample ${i}: got ${sample}, expected ~${expected}`);
  }
});

test('encodeWavBase64: decodes back to the same bytes encodeWav produces', () => {
  const pcm = new Float32Array([0, 0.25, -0.25, 0.75]);
  const wav = encodeWav(pcm, 24000);
  const base64 = encodeWavBase64(pcm, 24000);
  const decoded = Buffer.from(base64, 'base64');
  assert.deepEqual(new Uint8Array(decoded), new Uint8Array(wav));
});
