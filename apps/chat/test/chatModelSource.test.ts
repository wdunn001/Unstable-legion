import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_MODEL_DISPLAY_NAME,
  CHAT_MODEL_QUANT,
  chatManifestUrls,
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

test('chatManifestUrls: ordered HF -> jsDelivr(GitHub) -> local mirror, every entry an ABSOLUTE `new URL()` base', () => {
  // Regression (absolute-url half): a site-relative "/webllm/…" base makes
  // resolveCommunalShardPlan -> fragmentsForRange's
  // `new URL(fragment.path, manifestUrl)` throw "Invalid base URL" — this
  // broke live layer loading once (hotfix/manifest-abs-url).
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'location');
  try {
    Object.defineProperty(globalThis, 'location', {
      value: { origin: 'https://legion.codecai.net' },
      configurable: true,
    });
    const urls = chatManifestUrls();
    assert.equal(urls.length, 3);
    assert.match(urls[0]!, /^https:\/\/huggingface\.co\//, 'primary = Hugging Face');
    assert.match(urls[1]!, /^https:\/\/cdn\.jsdelivr\.net\/gh\//, 'fallback = GitHub via jsDelivr');
    assert.match(urls[2]!, /^https:\/\/legion\.codecai\.net\/webllm\//, 'last resort = local mirror');
    for (const url of urls) {
      assert.ok(/^https?:\/\//.test(url), `expected absolute url, got ${url}`);
      assert.doesNotThrow(() => new URL('layers/layer-002.gguf', url));
    }
  } finally {
    if (saved) Object.defineProperty(globalThis, 'location', saved);
    else delete (globalThis as { location?: unknown }).location;
  }
});
