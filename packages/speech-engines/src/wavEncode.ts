/**
 * `encodeWav` — pure function, mono 16-bit PCM WAV encoder.
 *
 * `TtsEngine.synthesize` returns raw `Float32Array` PCM (`[-1, 1]`); this
 * is the container the `ttsWorker.ts` host wraps that PCM in before
 * base64-ing it onto the wire as `TtsSynthesizeContent.audioBase64`
 * (`mimeType: 'audio/wav'`) — a format every browser's
 * `AudioContext.decodeAudioData` accepts natively, so
 * `useAudioPlayback.ts` on the receiving end needs no extra codec.
 *
 * No dependency on `@huggingface/transformers`'s own `RawAudio.toWav()`
 * on purpose — keeping this a standalone pure function (no engine, no
 * browser API) is what makes it unit-testable under plain `node --test`
 * (see `test/wavEncode.test.ts`), the same discipline
 * `incrementalTextStream.ts` and this package's other pure helpers
 * already follow.
 */

/** Encode mono PCM samples (`[-1, 1]`) as a 16-bit PCM WAV file. */
export function encodeWav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < pcm.length; i++) {
    const clamped = Math.max(-1, Math.min(1, pcm[i]));
    const sample = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    view.setInt16(offset, sample, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
