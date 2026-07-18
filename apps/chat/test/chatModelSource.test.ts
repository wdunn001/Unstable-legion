import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_CHANNELS,
  CHAT_MODEL_DISPLAY_NAME,
  CHAT_MODEL_QUANT,
  DEFAULT_CHANNEL_ID,
  chatModelLabel,
  getStoredChannelId,
  resolveChatModelConfig,
  setStoredChannelId,
} from '../src/chatModelSource.ts';

test('chatModelLabel: joins display name + quant with the product\'s "·" separator', () => {
  assert.equal(chatModelLabel('Qwen3-8B', 'Q4_K_M'), 'Qwen3-8B · Q4_K_M');
});

test('CHAT_CHANNELS: includes 8B (default) and 14B, each a distinct own mesh (unique modelId)', () => {
  const ids = CHAT_CHANNELS.map((c) => c.id);
  assert.ok(ids.includes('qwen3-8b-q4'));
  assert.ok(ids.includes('qwen3-14b-q4'));
  assert.equal(new Set(ids).size, ids.length, 'modelIds must be unique — they key the mesh');
  assert.equal(DEFAULT_CHANNEL_ID, 'qwen3-8b-q4', 'default stays 8B (proven, phone-verified)');
});

test('resolveChatModelConfig: default channel names the real 8B target, not a test model', () => {
  const config = resolveChatModelConfig('qwen3-8b-q4');
  assert.equal(config.isTestModel, false);
  assert.equal(config.displayName, CHAT_MODEL_DISPLAY_NAME);
  assert.equal(config.modelLabel, chatModelLabel(CHAT_MODEL_DISPLAY_NAME, CHAT_MODEL_QUANT));
  assert.ok(config.modelLabel.length > 0);
  assert.doesNotMatch(config.modelLabel, /test model/i);
  assert.equal(config.modelId, 'qwen3-8b-q4');
  assert.equal(config.totalLayers, 36);
  assert.equal(config.nEmbd, 4096);
});

test('resolveChatModelConfig: 14B channel resolves the 14B architecture + label', () => {
  const config = resolveChatModelConfig('qwen3-14b-q4');
  assert.equal(config.modelId, 'qwen3-14b-q4');
  assert.equal(config.displayName, 'Qwen3-14B');
  assert.equal(config.modelLabel, 'Qwen3-14B · Q4_K_M');
  assert.equal(config.totalLayers, 40);
  assert.equal(config.nEmbd, 5120);
  assert.equal(config.driverLayers, 2);
  assert.equal(config.isTestModel, false);
});

test('resolveChatModelConfig: an unknown channel id falls back to the default (never throws/empties)', () => {
  const config = resolveChatModelConfig('qwen3-does-not-exist');
  assert.equal(config.modelId, DEFAULT_CHANNEL_ID);
  assert.equal(config.totalLayers, 36);
});

test("resolveChatModelConfig: manifestUrl is [HF, local-mirror], every entry an ABSOLUTE new URL() base", () => {
  // Regression (absolute-url): a site-relative "/webllm/…" base makes
  // fragmentsForRange's `new URL(fragment.path, manifestUrl)` throw
  // "Invalid base URL" — this broke live layer loading once. Now per-channel.
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'location');
  try {
    Object.defineProperty(globalThis, 'location', { value: { origin: 'https://legion.codecai.net' }, configurable: true });
    for (const id of ['qwen3-8b-q4', 'qwen3-14b-q4']) {
      const urls = resolveChatModelConfig(id).manifestUrl as readonly string[];
      assert.equal(urls.length, 2, `${id}: HF + local mirror`);
      assert.match(urls[0]!, /^https:\/\/huggingface\.co\/wdunn001\/legion-model-/, `${id}: primary = HF`);
      assert.match(urls[1]!, /^https:\/\/legion\.codecai\.net\/webllm\/stages\//, `${id}: fallback = local mirror`);
      for (const url of urls) {
        assert.ok(/^https?:\/\//.test(url), `expected absolute url, got ${url}`);
        assert.doesNotThrow(() => new URL('layers/layer-002.gguf', url));
      }
    }
  } finally {
    if (saved) Object.defineProperty(globalThis, 'location', saved);
    else delete (globalThis as { location?: unknown }).location;
  }
});

test('getStoredChannelId / setStoredChannelId: round-trip a valid id, reject unknown, default when unset', () => {
  const store = new Map<string, string>();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
      configurable: true,
    });
    assert.equal(getStoredChannelId(), DEFAULT_CHANNEL_ID, 'unset -> default');
    setStoredChannelId('qwen3-14b-q4');
    assert.equal(getStoredChannelId(), 'qwen3-14b-q4', 'persists a valid channel');
    setStoredChannelId('bogus-model');
    assert.equal(getStoredChannelId(), 'qwen3-14b-q4', 'unknown id is a no-op, prior value stands');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
