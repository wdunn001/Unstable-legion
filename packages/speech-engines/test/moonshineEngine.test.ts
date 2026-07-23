/**
 * `createMoonshineEngine` shape/constant tests — NOT a real model run:
 * transformers.js + onnxruntime-web are browser-only (WebGPU/wasm), same
 * constraint documented in this package's README/MANUAL-TEST.md, so there's
 * no `whisperEngine.test.ts` either. This just locks down the exported
 * surface (model host constants, function shape) so a future edit that
 * accidentally renames/removes an export fails fast in CI instead of only
 * in a browser manual pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMoonshineEngine,
  HF_MODEL_HOST,
  LEGION_MODEL_FALLBACK_HOST,
} from '../src/moonshineEngine.ts';

test('HF_MODEL_HOST points at the Hugging Face Hub', () => {
  assert.equal(HF_MODEL_HOST, 'https://huggingface.co/');
});

test('LEGION_MODEL_FALLBACK_HOST points at the Legion CDN mirror', () => {
  assert.equal(LEGION_MODEL_FALLBACK_HOST, 'https://cdn.codecai.net/webllm/hf/');
});

test('createMoonshineEngine is an async factory function', () => {
  assert.equal(typeof createMoonshineEngine, 'function');
  // Calling it returns a Promise (the actual init runs lazily inside and
  // needs a browser — see module doc — so this only checks the shape).
  const result = createMoonshineEngine({ device: 'wasm' });
  assert.ok(result instanceof Promise);
  // Avoid an unhandled-rejection warning in the test run — the promise
  // WILL reject in Node (no navigator/WebGPU, and transformers.js' wasm
  // path still expects browser-ish globals for this pipeline), which is
  // expected and not what this test is checking.
  result.catch(() => {});
});
