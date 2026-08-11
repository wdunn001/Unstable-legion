/**
 * Speech mesh-capability contract — PoC (browser mic → ASR → transcript,
 * text → TTS → audio clip, each exposed as a `tc` tool-call job rather
 * than an activation pipeline).
 *
 * A peer that can transcribe audio advertises `ASR_SKILL` in
 * `cap.skills[]` and a `transcribe` tool descriptor (name `ASR_TOOL_NAME`)
 * in `cap.tools[]` — same shape as any other opt-in tool (see `tools.ts`).
 * An asker finds such a peer via the roster, ships an `AsrTranscribeArgs`
 * payload over `tc`, and gets back `AsrTranscribeContent` on the matching
 * `MeshToolResult`. A peer that can synthesize speech advertises
 * `TTS_SKILL` and a `synthesize` tool descriptor (name `TTS_TOOL_NAME`)
 * the same way — an asker ships a `TtsSynthesizeArgs` payload and gets
 * back `TtsSynthesizeContent`.
 *
 * Wire framing: audio rides `tc` (JSON) as a base64 string for this PoC,
 * both directions (mic clip in on the ASR side, synthesized clip out on
 * the TTS side). That's simple and interoperable with the existing
 * tool-call bus, but it's not the long-term shape — base64-in-JSON has
 * ~33% overhead and no streaming. The phase-2 upgrade is to carry raw
 * PCM/opus bytes as a binary Codec `LatentFrame` (see `wire.ts` /
 * `webrtc-codec.ts`), the way the mesh already ships token/activation
 * frames, instead of stuffing bytes into a JSON string. Not implemented
 * here — this PoC intentionally keeps the transport dumb so the ASR/TTS
 * engines + tool-call plumbing can be proven first.
 */

/** Skill name an ASR-capable peer puts in `cap.skills[]`. */
export const ASR_SKILL = 'asr.transcribe';

/** Tool name an ASR-capable peer registers + advertises in `cap.tools[]`. */
export const ASR_TOOL_NAME = 'transcribe';

/** Skill name a TTS-capable peer puts in `cap.skills[]`. */
export const TTS_SKILL = 'tts.synthesize';

/** Tool name a TTS-capable peer registers + advertises in `cap.tools[]`. */
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

/**
 * Args for the `synthesize` tool call. `voice`/`speed` are engine-specific
 * hints (e.g. Kokoro's `af_heart` voice id, a 1.0-centered speed
 * multiplier) — omit either to let the serving engine apply its own
 * default.
 */
export interface TtsSynthesizeArgs {
  /** Text to synthesize. */
  text: string;
  /** Optional engine-specific voice id. Omit for the engine's default. */
  voice?: string;
  /** Optional speaking-speed multiplier (1.0 = normal). Omit for the engine's default. */
  speed?: number;
}

/** Result content shipped back on `MeshToolResult.result.content`. */
export interface TtsSynthesizeContent {
  /** Base64-encoded audio clip bytes, container/codec named by `mimeType`. */
  audioBase64: string;
  /** Container/codec mime type of the encoded clip, e.g. `audio/wav`. */
  mimeType: string;
  /** Sample rate of the encoded clip, in Hz. */
  sampleRate: number;
  /** Wall-clock milliseconds the engine spent synthesizing, if measured. */
  durationMs?: number;
  /** Engine identifier, e.g. `kokoro-82m/webgpu`. */
  engine: string;
}
