/**
 * toSpeakableText — turn an assistant reply (Qwen3 markdown, possibly with
 * a `<think>` block) into text worth reading ALOUD, before it goes to TTS.
 *
 * The model writes for the eye: fenced code, inline back-ticks, markdown
 * syntax, bare URLs, tables. Handing that straight to Kokoro means it
 * literally reads "backtick", spells out code, and drones through URLs. A
 * chat-template nudge can't reliably prevent this (and wastes tokens), so
 * we strip the non-speakable parts deterministically here instead — the
 * listener hears the explanation, not the code.
 *
 * Intentionally lossy: the goal is natural prose, not a faithful
 * round-trip. Fenced code blocks are dropped entirely (that's the whole
 * point — you asked to hear the answer, not the snippet); inline code
 * keeps its text (a var/flag name reads fine); links keep their label and
 * drop the URL. Returns '' when nothing speakable remains (e.g. a
 * code-only reply) so the caller can say so instead of synthesizing junk.
 */
export function toSpeakableText(markdown: string): string {
  let t = markdown;

  // 1. Reasoning blocks — never read the model's scratchpad.
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  // 2. Fenced code blocks (``` or ~~~) — dropped wholesale.
  t = t.replace(/(^|\n)\s*(```|~~~)[^\n]*\n[\s\S]*?\2[^\n]*(?=\n|$)/g, '\n');
  // Any unterminated fence (streaming) — drop from the fence to the end.
  t = t.replace(/(^|\n)\s*(```|~~~)[\s\S]*$/g, '\n');
  // 3. Images: drop; links: keep the label, drop the URL.
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // 4. Inline code — keep the contents, drop the back-ticks.
  t = t.replace(/`([^`]+)`/g, '$1');
  // 5. Bare URLs — unpleasant to hear; drop.
  t = t.replace(/\bhttps?:\/\/\S+/gi, ' ');
  // 6. Line-leading markdown: headings, blockquotes, list markers, rules.
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s{0,3}>\s?/gm, '');
  t = t.replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, ''); // hr: ---, ***, ___
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\d+\.\s+/gm, '');
  // 7. Tables: drop separator rows, turn cell pipes into pauses.
  t = t.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, '');
  t = t.replace(/\|/g, ', ');
  // 8. Remaining emphasis/marker punctuation (safe for speech).
  t = t.replace(/[*_~#]+/g, '');
  // 9. Whitespace → prose: paragraph breaks become sentence pauses.
  t = t.replace(/\r/g, '');
  t = t.replace(/\n{2,}/g, '. ');
  t = t.replace(/\n/g, ' ');
  t = t.replace(/[ \t]{2,}/g, ' ');
  // Tidy the artefacts of the above (". ." / ".." / stray leading punctuation).
  t = t.replace(/\s+([.,!?;:])/g, '$1');
  t = t.replace(/([.!?])(?:\s*[.,;:])+/g, '$1');
  t = t.replace(/(^|\s)[.,;:]+(\s|$)/g, '$1$2');

  return t.trim();
}
