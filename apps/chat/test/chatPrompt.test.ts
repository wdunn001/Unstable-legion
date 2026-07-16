import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/chatPrompt.ts';
import type { ChatMessage } from '../src/db/threadStore.ts';

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: `${role}-${content}`, role, content, createdAt: 0 };
}

test('buildPrompt: no history -> the new message is the whole prompt', () => {
  assert.equal(buildPrompt([], 'hello'), 'hello');
});

test('buildPrompt: folds prior turns into a User:/Assistant: transcript ending with a fresh Assistant: cue', () => {
  const history = [msg('user', 'hi'), msg('assistant', 'hello there')];
  const prompt = buildPrompt(history, 'how are you?');
  assert.equal(prompt, 'User: hi\nAssistant: hello there\nUser: how are you?\nAssistant:');
});

test('buildPrompt: skips an empty in-flight assistant placeholder', () => {
  const history = [msg('user', 'hi'), msg('assistant', '')];
  const prompt = buildPrompt(history, 'still there?');
  assert.equal(prompt, 'User: hi\nUser: still there?\nAssistant:');
});

test('buildPrompt: bounds to the last maxTurns pairs', () => {
  const history: ChatMessage[] = [];
  for (let i = 0; i < 10; i++) {
    history.push(msg('user', `q${i}`));
    history.push(msg('assistant', `a${i}`));
  }
  const prompt = buildPrompt(history, 'final', 2);
  // Only the last 2 turns (4 messages) should survive.
  assert.equal(prompt, 'User: q8\nAssistant: a8\nUser: q9\nAssistant: a9\nUser: final\nAssistant:');
});
