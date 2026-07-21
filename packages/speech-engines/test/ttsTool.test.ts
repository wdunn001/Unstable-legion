/**
 * `createTtsSynthesizeTool` unit tests — descriptor shape + `validate`,
 * against a fake `TtsSynthesizeClient`. Mirrors `asrTool.test.ts`
 * exactly: no real engine/worker involved. kokoro-js + transformers.js +
 * onnxruntime-web are browser-only and out of scope for a node `--test`
 * run (see this package's README).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TTS_TOOL_NAME } from '@unstable-legion/core';
import { createTtsSynthesizeTool, type TtsSynthesizeClient } from '../src/ttsTool.ts';

function fakeClient(): TtsSynthesizeClient {
  return {
    synthesize: async (args) => ({
      audioBase64: `base64:${args.text}`,
      mimeType: 'audio/wav',
      sampleRate: 24000,
      voice: args.voice ?? 'af_heart',
      engine: 'fake/test',
    }),
  };
}

test('descriptor: name matches TTS_TOOL_NAME and requires text', () => {
  const reg = createTtsSynthesizeTool(fakeClient());
  assert.equal(reg.descriptor.name, TTS_TOOL_NAME);
  const schema = reg.descriptor.inputSchema as { required?: string[] };
  assert.deepEqual(schema.required, ['text']);
});

test('validate: rejects missing text', () => {
  const reg = createTtsSynthesizeTool(fakeClient());
  const err = reg.validate({ voice: 'af_heart' });
  assert.ok(err && /text/.test(err));
});

test('validate: rejects empty-string text', () => {
  const reg = createTtsSynthesizeTool(fakeClient());
  const err = reg.validate({ text: '' });
  assert.ok(err && /text/.test(err));
});

test('validate: rejects whitespace-only text', () => {
  const reg = createTtsSynthesizeTool(fakeClient());
  const err = reg.validate({ text: '   ' });
  assert.ok(err && /text/.test(err));
});

test('validate: rejects non-string voice', () => {
  const reg = createTtsSynthesizeTool(fakeClient());
  const err = reg.validate({ text: 'hello', voice: 7 });
  assert.ok(err && /voice/.test(err));
});

test('validate: rejects non-string language', () => {
  const reg = createTtsSynthesizeTool(fakeClient());
  const err = reg.validate({ text: 'hello', language: 7 });
  assert.ok(err && /language/.test(err));
});

test('validate: accepts a well-formed call', () => {
  const reg = createTtsSynthesizeTool(fakeClient());
  const err = reg.validate({ text: 'hello', voice: 'af_heart', language: 'en' });
  assert.equal(err, null);
});

test('handler: forwards args to the client and wraps content', async () => {
  const reg = createTtsSynthesizeTool(fakeClient());
  const result = await reg.handler({ text: 'hello', voice: 'af_heart' });
  assert.deepEqual(result.content, {
    audioBase64: 'base64:hello',
    mimeType: 'audio/wav',
    sampleRate: 24000,
    voice: 'af_heart',
    engine: 'fake/test',
  });
});
