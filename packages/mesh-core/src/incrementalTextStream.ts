/**
 * TEXT-RELAY (Phase 2 of OPTIONAL-STAGE0) — incremental UTF-8-safe text
 * streaming for a detokenizer that can only produce a FULL redecode of the
 * growing token sequence, not raw per-token bytes.
 *
 * `@unstable-legion/stage-runtime`'s `StageHandle.detokenize()` concatenates
 * every requested token's raw byte piece INSIDE the native call, then runs
 * ONE `new TextDecoder().decode(...)` over the whole concatenated buffer —
 * a non-fatal decode, so a buffer that ends mid multi-byte UTF-8 sequence
 * (a real, common case: one token can be a partial UTF-8 byte, or a
 * grapheme can split across two tokens) gets a trailing U+FFFD replacement
 * character instead of throwing. There is no raw-bytes escape hatch
 * exposed (and adding one would mean touching stage-runtime/native code,
 * out of scope here) — so per-TOKEN-in-isolation detokenize is unsound: an
 * incomplete piece decoded alone already loses its true bytes to a
 * standalone U+FFFD before this module ever sees it.
 *
 * The sound approach — the one `useStageHost.ts`'s final-stage token loop
 * uses — is to redecode the WHOLE growing token sequence sampled so far on
 * every step (`detokenize(sampledTokensSoFar)`), which correctly
 * concatenates every token's bytes BEFORE the single lossy decode pass, and
 * hand the result here. This module then does the actual "streaming" part:
 * diff against what was already emitted, and hold back any trailing run of
 * U+FFFD (an incomplete tail that a LATER call — once the completing
 * token(s) arrive — will resolve into real text, never retroactively
 * changing anything emitted before it). This mirrors llama.cpp's own
 * streaming-detokenize strategy.
 *
 * A genuine U+FFFD in real model output (rare, but not impossible) is
 * indistinguishable from an in-flight incomplete tail by this heuristic —
 * it would be held back one extra step and then flushed on the next call
 * (or at `flush: true`). Accepted, documented limitation; not a correctness
 * issue for the common case this exists to solve (never splitting a
 * genuine multi-byte character across two emitted deltas).
 */

/** Opaque incremental-streaming cursor — carry the RETURNED value into the
 * next call for the same session; start a fresh session at `INITIAL_TEXT_CURSOR`. */
export interface IncrementalTextCursor {
  /** UTF-16 code units of the (safe-trimmed) full text already emitted. */
  readonly emittedLength: number;
}

export const INITIAL_TEXT_CURSOR: IncrementalTextCursor = { emittedLength: 0 };

/** A trailing run of the UTF-8 replacement char a non-fatal `TextDecoder`
 * leaves at the very end of a buffer whose last bytes don't form a
 * complete character — see this module's doc comment. */
const TRAILING_REPLACEMENT_RUN = /[�]+$/;

export interface IncrementalTextDeltaResult {
  /** Safe-to-show text beyond what was already emitted for this cursor —
   * "" when nothing new is safely emittable yet (e.g. the growing decode
   * still ends mid multi-byte character). Never splits a multi-byte
   * character or a completed earlier delta. */
  delta: string;
  /** Pass this into the next call for the same session. */
  cursor: IncrementalTextCursor;
}

/**
 * Given the FULL redecoded text for every token sampled so far this
 * session and the cursor returned by the previous call, returns the
 * safe-to-emit delta and the advanced cursor.
 *
 * Nothing is emitted for a still-incomplete trailing multi-byte sequence —
 * it's held back for a future call once the completing token(s) arrive.
 * Pass `flush: true` on the FINAL call (generation done/aborted) to force
 * out whatever's left, lossy tail included, so nothing already sampled is
 * silently dropped just because generation ended mid-sequence.
 */
export function extractIncrementalTextDelta(
  fullText: string,
  cursor: IncrementalTextCursor,
  opts: { flush?: boolean } = {},
): IncrementalTextDeltaResult {
  const safeText = opts.flush ? fullText : fullText.replace(TRAILING_REPLACEMENT_RUN, '');
  if (safeText.length <= cursor.emittedLength) {
    return { delta: '', cursor };
  }
  const delta = safeText.slice(cursor.emittedLength);
  return { delta, cursor: { emittedLength: safeText.length } };
}
