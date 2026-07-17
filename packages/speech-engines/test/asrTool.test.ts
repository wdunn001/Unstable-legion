/**
 * `createAsrTranscribeTool` unit tests — descriptor shape + `validate`,
 * against a fake `AsrTranscribeClient`. No real engine/worker involved:
 * transformers.js + onnxruntime-web are browser-only and out of scope
 * for a node `--test` run (see this package's README).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ASR_TOOL_NAME } from '@unstable-legion/core';
import { createAsrTranscribeTool, type AsrTranscribeClient } from '../src/asrTool.ts';

function fakeClient(): AsrTranscribeClient {
  return {
    transcribe: async (args) => ({
      text: `echo:${args.mimeType}`,
      engine: 'fake/test',
    }),
  };
}

test('descriptor: name matches ASR_TOOL_NAME and requires audioBase64 + mimeType', () => {
  const reg = createAsrTranscribeTool(fakeClient());
  assert.equal(reg.descriptor.name, ASR_TOOL_NAME);
  const schema = reg.descriptor.inputSchema as { required?: string[] };
  assert.deepEqual(schema.required, ['audioBase64', 'mimeType']);
});

test('validate: rejects missing audioBase64', () => {
  const reg = createAsrTranscribeTool(fakeClient());
  const err = reg.validate({ mimeType: 'audio/webm' });
  assert.ok(err && /audioBase64/.test(err));
});

test('validate: rejects empty-string audioBase64', () => {
  const reg = createAsrTranscribeTool(fakeClient());
  const err = reg.validate({ audioBase64: '', mimeType: 'audio/webm' });
  assert.ok(err && /audioBase64/.test(err));
});

test('validate: rejects missing mimeType', () => {
  const reg = createAsrTranscribeTool(fakeClient());
  const err = reg.validate({ audioBase64: 'abc' });
  assert.ok(err && /mimeType/.test(err));
});

test('validate: rejects non-string language', () => {
  const reg = createAsrTranscribeTool(fakeClient());
  const err = reg.validate({ audioBase64: 'abc', mimeType: 'audio/webm', language: 7 });
  assert.ok(err && /language/.test(err));
});

test('validate: accepts a well-formed call', () => {
  const reg = createAsrTranscribeTool(fakeClient());
  const err = reg.validate({ audioBase64: 'abc', mimeType: 'audio/webm', language: 'en' });
  assert.equal(err, null);
});

test('handler: forwards args to the client and wraps content', async () => {
  const reg = createAsrTranscribeTool(fakeClient());
  const result = await reg.handler({ audioBase64: 'abc', mimeType: 'audio/webm' });
  assert.deepEqual(result.content, { text: 'echo:audio/webm', engine: 'fake/test' });
});
