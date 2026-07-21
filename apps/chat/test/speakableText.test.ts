import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSpeakableText } from '../src/speakableText.ts';

test('drops fenced code blocks, keeps surrounding prose', () => {
  const md = 'Here is the fix:\n\n```js\nconst x = 1;\nconsole.log(x);\n```\n\nThat should work.';
  const out = toSpeakableText(md);
  assert.ok(!out.includes('const x'), 'code content must not be read');
  assert.ok(!out.includes('```'), 'fence markers gone');
  assert.match(out, /Here is the fix/);
  assert.match(out, /That should work/);
});

test('strips <think> reasoning blocks', () => {
  const out = toSpeakableText('<think>let me reason about this</think>The answer is 42.');
  assert.ok(!/reason about/.test(out));
  assert.match(out, /The answer is 42/);
});

test('unwraps inline code and link labels, drops URLs', () => {
  const out = toSpeakableText('Call `useState` and see the [docs](https://example.com/x) here.');
  assert.match(out, /Call useState and see the docs here/);
  assert.ok(!out.includes('https://'), 'raw URL dropped');
  assert.ok(!out.includes('`'));
});

test('removes heading/list/emphasis markup', () => {
  const out = toSpeakableText('# Title\n\n- **first** item\n- second item');
  assert.ok(!out.includes('#'));
  assert.ok(!out.includes('*'));
  assert.ok(!out.includes('- '));
  assert.match(out, /Title/);
  assert.match(out, /first item/);
});

test('returns empty for a code-only reply (caller substitutes a note)', () => {
  const out = toSpeakableText('```python\nprint("hi")\n```');
  assert.equal(out, '');
});

test('handles an unterminated (streaming) fence', () => {
  const out = toSpeakableText('Sure, here it is:\n\n```ts\nconst a =');
  assert.match(out, /Sure, here it is/);
  assert.ok(!out.includes('const a'));
});
