/**
 * parseMarkdown unit tests — exercises both the final-render shape AND
 * the streaming-safety property (feeding the parser a growing sequence
 * of prefixes never produces a flash of wrong output for the already-
 * settled portion of the text).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInline, parseMarkdown } from '../src/markdown/parseMarkdown.ts';

test('parseInline: plain text has no nodes beyond a single text node', () => {
  assert.deepEqual(parseInline('hello world'), [{ type: 'text', text: 'hello world' }]);
});

test('parseInline: bold, italic, code, link all parse when closed', () => {
  assert.deepEqual(parseInline('**bold**'), [{ type: 'bold', children: [{ type: 'text', text: 'bold' }] }]);
  assert.deepEqual(parseInline('*italic*'), [{ type: 'italic', children: [{ type: 'text', text: 'italic' }] }]);
  assert.deepEqual(parseInline('`code`'), [{ type: 'code', text: 'code' }]);
  assert.deepEqual(parseInline('[legion](https://example.com)'), [
    { type: 'link', text: 'legion', href: 'https://example.com' },
  ]);
});

test('parseInline: unterminated bold marker stays literal, never dropped', () => {
  const nodes = parseInline('hello **world');
  // The whole thing collapses to a single text node — the ** never opens
  // a bold span because no closing ** exists yet.
  assert.deepEqual(nodes, [{ type: 'text', text: 'hello **world' }]);
});

test('parseInline: unterminated code backtick stays literal', () => {
  const nodes = parseInline('call `foo(');
  assert.deepEqual(nodes, [{ type: 'text', text: 'call `foo(' }]);
});

test('parseMarkdown: paragraph, heading, lists, blockquote, code block', () => {
  const text = [
    '# Title',
    '',
    'A paragraph with **bold** and *italic*.',
    '',
    '- one',
    '- two',
    '',
    '1. first',
    '2. second',
    '',
    '> a quote',
    '',
    '```ts',
    'const x = 1;',
    '```',
  ].join('\n');

  const blocks = parseMarkdown(text);
  assert.equal(blocks[0]!.type, 'heading');
  assert.equal(blocks[1]!.type, 'p');
  assert.equal(blocks[2]!.type, 'ul');
  assert.deepEqual((blocks[2] as { items: unknown[] }).items.length, 2);
  assert.equal(blocks[3]!.type, 'ol');
  assert.equal(blocks[4]!.type, 'blockquote');
  const codeBlock = blocks[5] as { type: 'code-block'; lang?: string; code: string; closed: boolean };
  assert.equal(codeBlock.type, 'code-block');
  assert.equal(codeBlock.lang, 'ts');
  assert.equal(codeBlock.code, 'const x = 1;');
  assert.equal(codeBlock.closed, true);
});

test('parseMarkdown: unterminated fenced code block stays open, captures streamed lines', () => {
  const blocks = parseMarkdown('```js\nconsole.log(1)');
  assert.equal(blocks.length, 1);
  const block = blocks[0] as { type: 'code-block'; closed: boolean; code: string };
  assert.equal(block.type, 'code-block');
  assert.equal(block.closed, false);
  assert.equal(block.code, 'console.log(1)');
});

test('parseMarkdown: streaming a reply token-by-token never breaks earlier blocks', () => {
  const full = 'Here is a list:\n\n- alpha\n- beta\n- gamma\n\nAnd **bold** text after.';
  // Simulate streaming by feeding growing prefixes.
  let prevBlockCount = 0;
  let sawList = false;
  for (let end = 1; end <= full.length; end += 3) {
    const prefix = full.slice(0, end);
    const blocks = parseMarkdown(prefix);
    // Once the list block has been fully closed by a blank line, it must
    // never later change type (no flicker for settled content).
    if (blocks.length >= 2 && blocks[1]!.type === 'ul') sawList = true;
    if (sawList) {
      assert.equal(blocks[1]!.type, 'ul', `list block flickered at prefix length ${end}`);
    }
    prevBlockCount = Math.max(prevBlockCount, blocks.length);
  }
  assert.ok(sawList, 'the list block should have been observed as settled at some point');
  assert.ok(prevBlockCount >= 3);
});

test('parseMarkdown: final settled render of the full reply is well-formed', () => {
  const full = 'Here is a list:\n\n- alpha\n- beta\n- gamma\n\nAnd **bold** text after.';
  const blocks = parseMarkdown(full);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0]!.type, 'p');
  assert.equal(blocks[1]!.type, 'ul');
  assert.equal((blocks[1] as { items: unknown[] }).items.length, 3);
  assert.equal(blocks[2]!.type, 'p');
});
