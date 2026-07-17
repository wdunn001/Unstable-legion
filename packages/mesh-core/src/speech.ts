/**
 * Speech mesh-capability contract — PoC (browser mic → ASR → transcript,
 * exposed as a `tc` tool-call job rather than an activation pipeline).
 *
 * A peer that can transcribe audio advertises `ASR_SKILL` in
 * `cap.skills[]` and a `transcribe` tool descriptor (name `ASR_TOOL_NAME`)
 * in `cap.tools[]` — same shape as any other opt-in tool (see `tools.ts`).
 * An asker finds such a peer via the roster, ships an `AsrTranscribeArgs`
 * payload over `tc`, and gets back `AsrTranscribeContent` on the matching
 * `MeshToolResult`.
 *
 * Wire framing: audio rides `tc` (JSON) as a base64 string for this PoC.
 * That's simple and interoperable with the existing tool-call bus, but
 * it's not the long-term shape — base64-in-JSON has ~33% overhead and no
 * streaming. The phase-2 upgrade is to carry raw PCM/opus bytes as a
 * binary Codec `LatentFrame` (see `wire.ts` / `webrtc-codec.ts`), the way
 * the mesh already ships token/activation frames, instead of stuffing
 * bytes into a JSON string. Not implemented here — this PoC intentionally
 * keeps the transport dumb so the ASR engine + tool-call plumbing can be
 * proven first.
 *
 * `TTS_SKILL` / `TTS_TOOL_NAME` are reserved now so a future
 * text-to-speech capability slots into the same cap-advertisement +
 * tool-call pattern without a name collision. No TTS implementation
 * ships in this PoC.
 */

/** Skill name an ASR-capable peer puts in `cap.skills[]`. */
export const ASR_SKILL = 'asr.transcribe';

/** Tool name an ASR-capable peer registers + advertises in `cap.tools[]`. */
export const ASR_TOOL_NAME = 'transcribe';

/** Reserved for a future text-to-speech capability — no impl yet. */
export const TTS_SKILL = 'tts.synthesize';

/** Reserved for a future text-to-speech capability — no impl yet. */
export const TTS_TOOL_NAME = 'synthesize';

/**
 * Args for the `transcribe` tool call. `audioBase64` is a base64-encoded
 * clip (whatever container `mimeType` names — `audio/webm` from
 * `MediaRecorder` in this PoC). `language` is an optional ISO-639-1 hint;
 * omit to let the engine auto-detect.
 */
export interface AsrTranscribeArgs {
  /** Base64-encoded audio clip bytes. */
  audioBase64: string;
  /** Container/codec mime type of the encoded clip, e.g. `audio/webm`. */
  mimeType: string;
  /** Optional ISO-639-1 language hint (e.g. `en`). Omit to auto-detect. */
  language?: string;
}

/** One recognized segment within a transcript, when the engine reports timing. */
export interface AsrTranscribeSegment {
  text: string;
  /** Start offset in seconds. */
  start: number;
  /** End offset in seconds. */
  end: number;
}

/** Result content shipped back on `MeshToolResult.result.content`. */
export interface AsrTranscribeContent {
  /** Full transcript text. */
  text: string;
  /** Detected or requested language, if the engine reports one. */
  language?: string;
  /** Wall-clock milliseconds the engine spent transcribing, if measured. */
  durationMs?: number;
  /** Engine identifier, e.g. `whisper-base/webgpu`. */
  engine: string;
  /** Optional per-segment breakdown with timestamps. */
  segments?: AsrTranscribeSegment[];
}
