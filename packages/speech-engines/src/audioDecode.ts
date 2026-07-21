/**
 * `decodeToPcm` — browser-only WebAudio decode + downmix + resample.
 *
 * Whisper (and transformers.js's ASR pipeline when fed a raw `Float32Array`
 * rather than a URL) expects mono PCM already sampled at 16 kHz — see
 * transformers.js's node-audio-processing guide, which explicitly resamples
 * to 16000 Hz before calling the pipeline. Rather than push that
 * requirement onto every caller, this decodes straight to 16 kHz mono so
 * `SpeechEngine.transcribe()` can hand the samples to Whisper unmodified.
 *
 * `mimeType` isn't consulted by `decodeAudioData` (it sniffs the
 * container from the bytes themselves) — kept in the signature so the
 * contract has room for a future non-container (raw PCM) fast path
 * without a breaking change.
 *
 * Browser-only: relies on `AudioContext`/`OfflineAudioContext`, which run
 * on the main thread or inside a worker in browsers that implement the
 * "Web Audio in Workers" extension (recent Chromium). Where that's
 * unavailable, run `decodeToPcm` on the main thread and pass the decoded
 * PCM into the worker instead of the raw bytes. See this package's
 * MANUAL-TEST.md.
 */
export interface DecodedPcm {
  /** Mono PCM samples in [-1, 1], resampled to `sampleRate`. */
  pcm: Float32Array;
  /** Always 16000 for this PoC — see module doc. */
  sampleRate: number;
}

const TARGET_SAMPLE_RATE = 16_000;

export async function decodeToPcm(
  bytes: ArrayBuffer | Uint8Array,
  _mimeType: string,
): Promise<DecodedPcm> {
  const arrayBuffer: ArrayBuffer =
    bytes instanceof Uint8Array
      ? (bytes.slice().buffer as ArrayBuffer)
      : bytes;

  const AudioContextCtor: typeof AudioContext =
    (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
  if (!AudioContextCtor) {
    throw new Error('decodeToPcm: AudioContext is not available in this context');
  }

  const probeCtx = new AudioContextCtor();
  let decoded: AudioBuffer;
  try {
    decoded = await probeCtx.decodeAudioData(arrayBuffer);
  } finally {
    await probeCtx.close().catch(() => undefined);
  }

  const targetLength = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));
  const offlineCtx = new OfflineAudioContext(1, targetLength, TARGET_SAMPLE_RATE);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  // Connecting a multi-channel source into a 1-channel destination
  // triggers the Web Audio spec's default down-mix — no manual channel
  // merging needed.
  source.connect(offlineCtx.destination);
  source.start(0);
  const rendered = await offlineCtx.startRendering();

  return { pcm: rendered.getChannelData(0).slice(), sampleRate: TARGET_SAMPLE_RATE };
}
