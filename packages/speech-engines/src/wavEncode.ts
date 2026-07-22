/**
 * `encodeWav`/`encodeWavBase64` — minimal 16-bit PCM WAV container, raw
 * bytes and base64-encoded respectively.
 *
 * Kokoro's `generate()` (via `kokoroEngine.ts`) hands back raw Float32
 * PCM samples with no container — good for a worker (no WebAudio
 * involved, see `ttsWorker.ts`'s module doc) but not shippable over `tc`
 * as-is: the consuming peer needs a self-describing clip it can hand
 * straight to `AudioContext.decodeAudioData` without knowing the
 * engine's native sample rate out of band. A 44-byte canonical WAV
 * header does exactly that.
 *
 * `encodeWav` builds the container (shared by both exports below);
 * `encodeWavBase64` is just `encodeWav` + a base64 pass, kept for
 * existing `tc`-framed callers (`ttsWorkerClient.ts`, after receiving raw
 * PCM back from the TTS worker). `encodeWav`'s raw-`ArrayBuffer` form
 * exists for `useVadListen.ts` (mesh-react): a Silero VAD utterance is
 * already Float32 PCM @16kHz same as Kokoro's output, and
 * `useSpeechClient.transcribe()` takes a `{ bytes: ArrayBuffer; mimeType
 * }` clip directly — no need to round-trip through base64 just to hand
 * it to `fetch`/`tc` framing that only happens later, one layer up.
 *
 * Main-thread utility: encoding happens on the main thread same as
 * `audioDecode.ts`'s decode does, though WAV-writing itself needs no
 * WebAudio API — it's kept alongside the other main-thread audio glue
 * for symmetry with the ASR decode step.
 */

const BYTES_PER_SAMPLE = 2; // 16-bit PCM
const NUM_CHANNELS = 1; // mono

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}

/** Encode mono Float32 PCM in [-1, 1] as a 16-bit PCM WAV file — raw container bytes. */
export function encodeWav(pcm: Float32Array, sampleRate: number): ArrayBuffer {
  const dataSize = pcm.length * BYTES_PER_SAMPLE;
  const blockAlign = NUM_CHANNELS * BYTES_PER_SAMPLE;
  const byteRate = sampleRate * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size (PCM)
  view.setUint16(20, 1, true); // audio format = 1 (PCM)
  view.setUint16(22, NUM_CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < pcm.length; i++, offset += 2) {
    const clamped = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }

  return buffer;
}

/** `encodeWav` + base64 — the `tc`-framed-clip form existing callers use. */
export function encodeWavBase64(pcm: Float32Array, sampleRate: number): string {
  return bytesToBase64(new Uint8Array(encodeWav(pcm, sampleRate)));
}
