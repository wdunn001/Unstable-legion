/**
 * `createTtsSynthesizeTool` unit tests — descriptor shape + `validate`,
 * against a fake `TtsSynthesizeClient`. No real engine/worker involved:
 * kokoro-js + onnxruntime-web are browser-only and out of scope for a
 * node `--test` run (mirrors `test/asrTool.test.ts`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TTS_TOOL_NAME } from '@unstable-legion/core';
import { createTtsSynthesizeTool, type TtsSynthesizeClient } from '../src/ttsTool.ts';

function fakeClient(): TtsSynthesizeClient {
  return {
    synthesize: async (args) => ({
      audioBase64: `echo:${args.text}`,
      mimeType: 'audio/wav',
      sampleRate: 24000,
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
  const err = reg.validate({});
  assert.ok(err && /text/.test(err));
});

test('validate: rejects empty-string text', () => {
  const reg = createTtsSynthesizeTool(fakeClient());
  const err = reg.validate({ text: '' });
  assert.ok(err && /text/.test(err));
});

test('validate: rejects non-string voice', () => {
  const reg = createTtsSynthesizeTool(fakeClient());
  const err = reg.validate({ text: 'hi', voice: 7 });
  assert.ok(err && /voice/.test(err));
});

test('validate: rejects non-number speed', () => {
  const reg = createTtsSynthesizeTool(fakeClient());
  const err = reg.validate({ text: 'hi', speed: 'fast' });
  assert.ok(err && /speed/.test(err));
});

test('validate: accepts a well-formed call', () => {
  const reg = createTtsSynthesizeTool(fakeClient());
  const err = reg.validate({ text: 'hi', voice: 'af_heart', speed: 1.2 });
  assert.equal(err, null);
});

test('handler: forwards args to the client and wraps content', async () => {
  const reg = createTtsSynthesizeTool(fakeClient());
  const result = await reg.handler({ text: 'hello mesh' });
  assert.deepEqual(result.content, {
    audioBase64: 'echo:hello mesh',
    mimeType: 'audio/wav',
    sampleRate: 24000,
    engine: 'fake/test',
  });
});
