/**
 * matchWakePhrase — wake-phrase gate for 💬 conversation mode (increment 3b
 * of the voice-conversation layer). Reuses the transcript the conversation
 * loop's continuous VAD→Whisper path already produces — this is NOT a
 * second ASR/wake-word model (no openWakeWord, no Moonshine), just a
 * substring match over text that already exists.
 *
 * Both sides are normalized (lowercase, punctuation stripped, whitespace
 * collapsed) before matching, and the phrase only needs to appear as a
 * SUBSTRING (not a prefix) — Whisper often prepends filler ("uh, hey
 * legion...") or mishears leading words, so anchoring to the start of the
 * transcript would drop otherwise-valid wake utterances. Everything after
 * the FIRST occurrence of the phrase becomes the command; a transcript
 * that's nothing but the wake phrase itself returns an empty command (the
 * caller opens the active-conversation window and waits for the real
 * question in the next utterance).
 */
export interface WakePhraseMatch {
  /** True if the (normalized) transcript contains the wake phrase. */
  woken: boolean;
  /** Normalized text AFTER the phrase — '' when the phrase was the whole
   * utterance (or the phrase wasn't found at all). */
  command: string;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // strip punctuation (keep letters/numbers/space)
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchWakePhrase(transcript: string, phrase: string): WakePhraseMatch {
  const normTranscript = normalize(transcript);
  const normPhrase = normalize(phrase);
  // A blank configured phrase can't ever match — treat every utterance as
  // already-woken (whole transcript is the command) rather than locking the
  // gate shut forever on a bad/empty setting.
  if (!normPhrase) return { woken: true, command: normTranscript };
  const idx = normTranscript.indexOf(normPhrase);
  if (idx === -1) return { woken: false, command: '' };
  const command = normTranscript.slice(idx + normPhrase.length).trim();
  return { woken: true, command };
}
