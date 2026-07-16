/**
 * StreamingMarkdown — renders `parseMarkdown`'s block tree as React
 * elements. Thin on purpose: all the streaming-safety logic lives in the
 * pure parser (unit-testable without React); this component just maps
 * data to JSX with stable `key`s per block/inline index so React's own
 * reconciliation avoids re-mounting settled (already-closed) blocks as
 * new text streams in.
 */
import type { ReactNode } from 'react';
import type { Block, InlineNode } from './parseMarkdown.js';
import { parseMarkdown } from './parseMarkdown.js';

function renderInline(nodes: InlineNode[], keyPrefix: string): ReactNode {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (node.type) {
      case 'text':
        return node.text;
      case 'code':
        return (
          <code className="md-code-span" key={key}>
            {node.text}
          </code>
        );
      case 'bold':
        return <strong key={key}>{renderInline(node.children, key)}</strong>;
      case 'italic':
        return <em key={key}>{renderInline(node.children, key)}</em>;
      case 'link':
        return (
          <a key={key} href={node.href} target="_blank" rel="noreferrer noopener">
            {node.text}
          </a>
        );
      default:
        return null;
    }
  });
}

function renderBlock(block: Block, key: string): ReactNode {
  switch (block.type) {
    case 'p':
      return <p key={key}>{renderInline(block.children, key)}</p>;
    case 'heading': {
      const Tag = `h${Math.min(6, Math.max(1, block.level))}` as keyof JSX.IntrinsicElements;
      return <Tag key={key}>{renderInline(block.children, key)}</Tag>;
    }
    case 'code-block':
      return (
        <pre className="md-code-block" key={key} data-open={!block.closed || undefined}>
          <code className={block.lang ? `language-${block.lang}` : undefined}>{block.code}</code>
        </pre>
      );
    case 'ul':
      return (
        <ul key={key}>
          {block.items.map((item, i) => (
            <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
          ))}
        </ul>
      );
    case 'ol':
      return (
        <ol key={key}>
          {block.items.map((item, i) => (
            <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
          ))}
        </ol>
      );
    case 'blockquote':
      return <blockquote key={key}>{renderInline(block.children, key)}</blockquote>;
    default:
      return null;
  }
}

export interface StreamingMarkdownProps {
  text: string;
  className?: string;
}

export function StreamingMarkdown(props: StreamingMarkdownProps) {
  const blocks = parseMarkdown(props.text);
  return (
    <div className={props.className}>
      {blocks.map((block, i) => renderBlock(block, `b${i}`))}
    </div>
  );
}
