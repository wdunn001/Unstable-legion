import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_MODEL_DISPLAY_NAME,
  CHAT_MODEL_QUANT,
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
