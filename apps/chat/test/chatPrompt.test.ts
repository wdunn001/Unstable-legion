import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/chatPrompt.ts';
import type { ChatMessage } from '../src/db/threadStore.ts';

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: `${role}-${content}`, role, content, createdAt: 0 };
}

// The assistant cue Qwen3's template emits for enable_thinking=false —
// see chatPrompt.ts's doc comment.
const ASSISTANT_CUE = '<|im_start|>assistant\n<think>\n\n</think>\n\n';

test('buildPrompt: no history -> system + the new user turn + assistant cue', () => {
  const prompt = buildPrompt([], 'hello');
  assert.match(prompt, /^<\|im_start\|>system\n/);
  assert.ok(prompt.includes('<|im_start|>user\nhello<|im_end|>'));
  assert.ok(prompt.endsWith(ASSISTANT_CUE));
  // Exactly one user turn, no assistant history.
  assert.equal(prompt.match(/<\|im_start\|>user\n/g)?.length, 1);
});

test('buildPrompt: folds prior turns into ChatML ending with a fresh assistant cue', () => {
  const history = [msg('user', 'hi'), msg('assistant', 'hello there')];
  const prompt = buildPrompt(history, 'how are you?');
  const idxSystem = prompt.indexOf('<|im_start|>system\n');
  const idxHi = prompt.indexOf('<|im_start|>user\nhi<|im_end|>');
  const idxReply = prompt.indexOf('<|im_start|>assistant\nhello there<|im_end|>');
  const idxNew = prompt.indexOf('<|im_start|>user\nhow are you?<|im_end|>');
  assert.ok(idxSystem === 0, 'system turn first');
  assert.ok(idxHi > idxSystem && idxReply > idxHi && idxNew > idxReply, 'turns in order');
  assert.ok(prompt.endsWith(ASSISTANT_CUE));
});

test('buildPrompt: skips an empty in-flight assistant placeholder', () => {
  const history = [msg('user', 'hi'), msg('assistant', '')];
  const prompt = buildPrompt(history, 'still there?');
  assert.equal(prompt.match(/<\|im_start\|>assistant\n/g)?.length, 1, 'only the final cue');
  assert.ok(prompt.includes('<|im_start|>user\nhi<|im_end|>'));
  assert.ok(prompt.includes('<|im_start|>user\nstill there?<|im_end|>'));
});

test('buildPrompt: bounds to the last maxTurns pairs', () => {
  const history: ChatMessage[] = [];
  for (let i = 0; i < 10; i++) {
    history.push(msg('user', `q${i}`));
    history.push(msg('assistant', `a${i}`));
  }
  const prompt = buildPrompt(history, 'final', { maxTurns: 2 });
  // Only the last 2 turns (4 messages) should survive.
  assert.ok(!prompt.includes('q7'));
  assert.ok(prompt.includes('<|im_start|>user\nq8<|im_end|>'));
  assert.ok(prompt.includes('<|im_start|>assistant\na8<|im_end|>'));
  assert.ok(prompt.includes('<|im_start|>user\nq9<|im_end|>'));
  assert.ok(prompt.includes('<|im_start|>assistant\na9<|im_end|>'));
  assert.ok(prompt.includes('<|im_start|>user\nfinal<|im_end|>'));
  assert.ok(prompt.endsWith(ASSISTANT_CUE));
});

test('buildPrompt: strips <think> blocks from prior assistant turns', () => {
  const history = [
    msg('user', 'hi'),
    msg('assistant', '<think>\nreasoning here\n</think>\n\nhello there'),
  ];
  const prompt = buildPrompt(history, 'next');
  assert.ok(prompt.includes('<|im_start|>assistant\nhello there<|im_end|>'));
  assert.ok(!prompt.includes('reasoning here'));
});

test('buildPrompt: an assistant turn that was ONLY a think block is dropped entirely', () => {
  const history = [msg('user', 'hi'), msg('assistant', '<think>\nonly reasoning\n</think>')];
  const prompt = buildPrompt(history, 'next');
  assert.equal(prompt.match(/<\|im_start\|>assistant\n/g)?.length, 1, 'only the final cue');
});

test('buildPrompt: tools render as a Qwen3 <tools> block in the system turn', () => {
  const tools = [
    { name: 'current_time', description: 'Wall clock.', inputSchema: { type: 'object', properties: {} } },
  ];
  const prompt = buildPrompt([], 'what time is it?', { tools });
  const systemEnd = prompt.indexOf('<|im_end|>');
  const system = prompt.slice(0, systemEnd);
  assert.ok(system.includes('<tools>'), 'tools open tag in system turn');
  assert.ok(system.includes('"name":"current_time"'), 'declares the function');
  assert.ok(system.includes('<tool_call></tool_call>'), 'instructs the call format');
});

test('buildPrompt: no tools -> no tools section at all', () => {
  const prompt = buildPrompt([], 'hello');
  assert.ok(!prompt.includes('<tools>'));
  assert.ok(!prompt.includes('# Tools'));
});

test('buildPrompt: completed rounds fold as assistant <tool_call> + user <tool_response> pairs', () => {
  const rounds = [
    {
      assistantText: '<tool_call>\n{"name": "current_time", "arguments": {}}\n</tool_call>',
      toolResponse: '{"iso":"2026-07-16T12:00:00Z"}',
    },
  ];
  const prompt = buildPrompt([], 'what time is it?', { rounds });
  const idxUser = prompt.indexOf('<|im_start|>user\nwhat time is it?<|im_end|>');
  const idxCall = prompt.indexOf('<|im_start|>assistant\n<tool_call>');
  const idxResponse = prompt.indexOf('<|im_start|>user\n<tool_response>\n{"iso":"2026-07-16T12:00:00Z"}\n</tool_response><|im_end|>');
  assert.ok(idxUser >= 0 && idxCall > idxUser && idxResponse > idxCall, 'user -> tool_call -> tool_response in order');
  assert.ok(prompt.endsWith('<|im_start|>assistant\n<think>\n\n</think>\n\n'), 'ends with a fresh assistant cue');
});
