/**
 * splitForTts — split a speakable-text reply into chunks small enough for
 * one `tts.synthesize` call each.
 *
 * Kokoro-82M has a ~510-phoneme-token max context; a long assistant reply
 * handed to `synthesize()` in one call overflows it (truncated/garbled
 * audio, or a worker error). Rather than teach the engine to stream
 * multiple results out of one call (kokoro-js's `tts.stream` /
 * `TextSplitterStream` — engine-side, doesn't fit the mesh `tc`
 * request/response model where one tool call = one result, see this
 * package's README), split on the CLIENT into several ordinary
 * `synthesize()`-sized chunks. Each chunk is a ~200-char (default)
 * budget, conservatively under the ~510-token limit even for
 * verbose/multi-syllable text.
 *
 * Splitting strategy, in order of preference (never cut mid-word):
 *   1. Sentence boundaries (`.`/`!`/`?` followed by whitespace or EOL,
 *      punctuation kept with the sentence it ends) — then greedily pack
 *      whole sentences into chunks up to `maxChars`.
 *   2. A single sentence that's still over `maxChars` on its own: split
 *      further on clause boundaries (`,`/`;`/`:`/newline, punctuation kept
 *      with the clause it ends).
 *   3. A clause still over `maxChars`: split on word boundaries as a last
 *      resort.
 *
 * Used by `useTtsSpeaker` (`@unstable-legion/react`), which synthesizes
 * the returned chunks ONE AT A TIME (Kokoro's worker/engine isn't safe to
 * call re-entrantly) but pipelines synth against playback for low
 * latency-to-first-audio — see that hook's module doc.
 */

const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+/;
const CLAUSE_SPLIT_RE = /(?<=[,;:])\s+|\n+/;

/** Greedily pack `pieces` (already each ≤ maxChars) into chunks ≤ maxChars, joined by a single space. */
function pack(pieces: readonly string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current === '') {
      current = piece;
      continue;
    }
    if (current.length + 1 + piece.length <= maxChars) {
      current += ' ' + piece;
    } else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

/** Split `text` on word boundaries into pieces each ≤ maxChars, never mid-word. */
function splitByWords(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    // A single word longer than maxChars can't be split without cutting
    // mid-word — keep it whole as its own (oversized) chunk rather than
    // ever slicing inside it.
    if (current === '') {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= maxChars) {
      current += ' ' + word;
    } else {
      out.push(current);
      current = word;
    }
  }
  if (current !== '') out.push(current);
  return out;
}

/** Split one oversized sentence on clause boundaries, then words, never exceeding maxChars (barring a single unsplittable word). */
function splitOversizedSentence(sentence: string, maxChars: number): string[] {
  const clauses = sentence
    .split(CLAUSE_SPLIT_RE)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const pieces: string[] = [];
  for (const clause of clauses) {
    if (clause.length <= maxChars) {
      pieces.push(clause);
    } else {
      pieces.push(...splitByWords(clause, maxChars));
    }
  }
  return pack(pieces, maxChars);
}

export function splitForTts(text: string, maxChars = 200): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];

  const sentences = trimmed
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const pieces: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      pieces.push(sentence);
    } else {
      pieces.push(...splitOversizedSentence(sentence, maxChars));
    }
  }
  return pack(pieces, maxChars);
}
