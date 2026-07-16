import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_MODEL_DISPLAY_NAME,
  CHAT_MODEL_ID,
  CHAT_MODEL_QUANT,
  chatManifestFallbackUrl,
  chatManifestUrl,
  chatModelLabel,
  resolveChatModelConfig,
} from '../src/chatModelSource.ts';

test('chatModelLabel: joins display name + quant with the product\'s "·" separator', () => {
  assert.equal(chatModelLabel('Qwen3-8B', 'Q4_K_M'), 'Qwen3-8B · Q4_K_M');
});

test('resolveChatModelConfig: production (no query param) names the real target model', () => {
  const config = resolveChatModelConfig();
  assert.equal(config.isTestModel, false);
  assert.equal(config.displayName, CHAT_MODEL_DISPLAY_NAME);
  assert.equal(config.modelLabel, chatModelLabel(CHAT_MODEL_DISPLAY_NAME, CHAT_MODEL_QUANT));
  // Never a bare id or empty string — the whole point of this milestone's
  // requirement is that the model identity is never hidden.
  assert.ok(config.modelLabel.length > 0);
  assert.doesNotMatch(config.modelLabel, /test model/i);
});

// ── CDN primary + .198 origin fallback ─────────────────────────────────

test('chatManifestUrl: points at the jsDelivr/GitHub CDN mirror, not the .198 origin', () => {
  const url = chatManifestUrl();
  assert.ok(url?.startsWith('https://cdn.jsdelivr.net/gh/wdunn001/legion-model-qwen3-8b@'));
  assert.ok(url?.endsWith('/model-package.json'));
});

test('chatManifestFallbackUrl: unchanged from the pre-CDN-migration .198 same-origin path', () => {
  assert.equal(chatManifestFallbackUrl(), `/webllm/stages/${CHAT_MODEL_ID}/model-package.json`);
});

test('resolveChatModelConfig: production config carries BOTH the CDN manifestUrl and the .198 manifestFallbackUrl', () => {
  const config = resolveChatModelConfig();
  assert.equal(config.manifestUrl, chatManifestUrl());
  assert.equal(config.manifestFallbackUrl, chatManifestFallbackUrl());
  assert.notEqual(config.manifestUrl, config.manifestFallbackUrl);
});

test('resolveChatModelConfig: the ?testModel=1 swap has neither a manifestUrl nor a manifestFallbackUrl (unaffected by the CDN migration)', () => {
  const priorLocation = (globalThis as { location?: unknown }).location;
  (globalThis as { location?: unknown }).location = { search: '?testModel=1' } as Location;
  try {
    const config = resolveChatModelConfig();
    assert.equal(config.isTestModel, true);
    assert.equal(config.manifestUrl, undefined);
    assert.equal(config.manifestFallbackUrl, undefined);
  } finally {
    (globalThis as { location?: unknown }).location = priorLocation;
  }
});
