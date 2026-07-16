/**
 * parseMarkdown — a small, dependency-free, streaming-tolerant Markdown
 * parser. No Markdown dependency existed anywhere in this repo; a full
 * CommonMark implementation is overkill for chat replies and (more
 * importantly) most aren't designed for "the input grows one token at a
 * time and every intermediate prefix must render sanely" — the actual
 * requirement here (`useCommunalChat.text` streams in-place as tokens
 * detokenize).
 *
 * Streaming-safety strategy: every construct (bold, italic, code span,
 * link, fenced code block) only turns into its formatted form once BOTH
 * delimiters have arrived. An unterminated `**bold` mid-stream stays
 * literal asterisks — never partially consumed, never a flash of wrong
 * formatting — until the closing `**` streams in on a later token, at
 * which point (this function is a pure re-parse of the whole string on
 * every call, not an incremental patcher) it snaps directly to the
 * formatted form. Combined with block-level parsing that only ever
 * mutates the LAST block as new text arrives (every earlier block is
 * byte-identical on every subsequent re-parse), a caller that re-renders
 * block-by-block with stable keys only ever repaints the tail — no
 * flicker across the already-settled prefix.
 *
 * Deliberately covers exactly what product chat replies use: paragraphs,
 * headings, fenced code blocks (language-tagged), ordered/unordered
 * lists, blockquotes, and inline code/bold/italic/links. No tables, no
 * nested lists, no HTML passthrough — none of those have shown up in
 * this app's actual assistant output, and guessing at unneeded generality
 * is how a "small" parser stops being small.
 */

export interface TextNode {
  type: 'text';
  text: string;
}
export interface CodeSpanNode {
  type: 'code';
  text: string;
}
export interface BoldNode {
  type: 'bold';
  children: InlineNode[];
}
export interface ItalicNode {
  type: 'italic';
  children: InlineNode[];
}
export interface LinkNode {
  type: 'link';
  text: string;
  href: string;
}
export type InlineNode = TextNode | CodeSpanNode | BoldNode | ItalicNode | LinkNode;

export interface ParagraphBlock {
  type: 'p';
  children: InlineNode[];
}
export interface HeadingBlock {
  type: 'heading';
  level: number;
  children: InlineNode[];
}
export interface CodeBlockBlock {
  type: 'code-block';
  lang?: string;
  code: string;
  /** False while the fence is still open (streaming) — a caller may
   * render this with a subtle "still writing" affordance. */
  closed: boolean;
}
export interface ListBlock {
  type: 'ul' | 'ol';
  items: InlineNode[][];
}
export interface BlockquoteBlock {
  type: 'blockquote';
  children: InlineNode[];
}
export type Block = ParagraphBlock | HeadingBlock | CodeBlockBlock | ListBlock | BlockquoteBlock;

/** Parse inline spans within one logical line/paragraph of text. Scans
 * left-to-right; any delimiter without a matching close falls through to
 * plain text (see module doc's streaming-safety strategy). */
export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) {
      nodes.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;

    // Inline code span: `...`
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        flush();
        nodes.push({ type: 'code', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // Link: [text](href)
    if (ch === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          flush();
          nodes.push({
            type: 'link',
            text: text.slice(i + 1, closeBracket),
            href: text.slice(closeBracket + 2, closeParen),
          });
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Bold: **...** or __...__
    if ((ch === '*' || ch === '_') && text[i + 1] === ch) {
      const marker = ch + ch;
      const end = text.indexOf(marker, i + 2);
      if (end !== -1 && end > i + 2) {
        flush();
        nodes.push({ type: 'bold', children: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    // Italic: *...* or _..._
    if (ch === '*' || ch === '_') {
      const end = text.indexOf(ch, i + 1);
      if (end !== -1 && end > i + 1) {
        flush();
        nodes.push({ type: 'italic', children: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    buffer += ch;
    i += 1;
  }
  flush();
  return nodes;
}

const FENCE_OPEN_RE = /^```\s*(\S*)\s*$/;
const FENCE_CLOSE_RE = /^```\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_ITEM_RE = /^[-*]\s+(.*)$/;
const OL_ITEM_RE = /^\d+\.\s+(.*)$/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/;

/** Parse a full Markdown string into block nodes. Pure function of its
 * input — call it fresh on every render with the growing streamed text
 * (see module doc: this is what makes it "streaming-tolerant" rather
 * than needing an incremental/patch API). */
export function parseMarkdown(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fenceMatch = line.match(FENCE_OPEN_RE);
    if (fenceMatch) {
      const lang = fenceMatch[1] || undefined;
      const codeLines: string[] = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        if (FENCE_CLOSE_RE.test(lines[i]!)) {
          closed = true;
          i += 1;
          break;
        }
        codeLines.push(lines[i]!);
        i += 1;
      }
      blocks.push({ type: 'code-block', lang, code: codeLines.join('\n'), closed });
      continue;
    }

    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1]!.length, children: parseInline(headingMatch[2]!) });
      i += 1;
      continue;
    }

    if (UL_ITEM_RE.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && UL_ITEM_RE.test(lines[i]!)) {
        items.push(parseInline(lines[i]!.match(UL_ITEM_RE)![1]!));
        i += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    if (OL_ITEM_RE.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && OL_ITEM_RE.test(lines[i]!)) {
        items.push(parseInline(lines[i]!.match(OL_ITEM_RE)![1]!));
        i += 1;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    if (BLOCKQUOTE_RE.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && BLOCKQUOTE_RE.test(lines[i]!)) {
        quoteLines.push(lines[i]!.match(BLOCKQUOTE_RE)![1]!);
        i += 1;
      }
      blocks.push({ type: 'blockquote', children: parseInline(quoteLines.join(' ')) });
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !FENCE_OPEN_RE.test(lines[i]!) &&
      !HEADING_RE.test(lines[i]!) &&
      !UL_ITEM_RE.test(lines[i]!) &&
      !OL_ITEM_RE.test(lines[i]!) &&
      !BLOCKQUOTE_RE.test(lines[i]!)
    ) {
      paraLines.push(lines[i]!);
      i += 1;
    }
    blocks.push({ type: 'p', children: parseInline(paraLines.join(' ')) });
  }

  return blocks;
}
