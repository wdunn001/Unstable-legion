import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_MODEL_DISPLAY_NAME,
  CHAT_MODEL_QUANT,
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

test('chatManifestUrl: returns an ABSOLUTE url usable as a `new URL()` base', () => {
  // Regression: it returned a site-relative "/webllm/…" string, and
  // resolveCommunalShardPlan -> fragmentsForRange does
  // `new URL(fragment.path, manifestUrl)`, which throws "Invalid base URL"
  // when the base is relative. This broke live layer loading; the old
  // tests missed it by only ever passing absolute manifest URLs.
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'location');
  try {
    Object.defineProperty(globalThis, 'location', {
      value: { origin: 'https://legion.codecai.net' },
      configurable: true,
    });
    const url = chatManifestUrl();
    assert.ok(url && /^https?:\/\//.test(url), `expected absolute url, got ${String(url)}`);
    // The exact failure mode fragmentsForRange hits:
    assert.doesNotThrow(() => new URL('layers/layer-002.gguf', url));
  } finally {
    if (saved) Object.defineProperty(globalThis, 'location', saved);
    else delete (globalThis as { location?: unknown }).location;
  }
});
