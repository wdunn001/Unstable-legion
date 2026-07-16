/**
 * chatPrompt — turns this thread's message history into the single
 * prompt string `useCommunalChat.start(prompt)` expects.
 *
 * `useCommunalChat` is deliberately single-turn at the protocol level
 * (one `start()` call = one tokenize -> prefill -> decode run against a
 * fresh KV state — see that hook's doc comment; it has no history
 * parameter, and threading real multi-turn KV state through the
 * communal pipeline is a mesh-core protocol change, out of scope for
 * this app per the M5 brief's "reuse the proven hooks, don't reinvent
 * the mesh logic"). This module's job is narrower and entirely
 * app-level: fold prior turns into the text of the NEXT prompt so the
 * model has conversational context.
 *
 * Format: Qwen3 ChatML. The chat target is a Qwen3 instruct model (see
 * chatModelSource.ts), and feeding it a bare "User:/Assistant:"
 * transcript makes it pattern-continue the transcript instead of
 * answering (observed in production: greedy decode looped "User: hello
 * User: why ..." forever). The special-token strings below tokenize to
 * REAL special tokens, not text: skippy_tokenize passes
 * parse_special=true to llama_tokenize (legion-stage-runtime patch
 * 0001), and useCommunalChat calls tokenize(text, addSpecial=true).
 * `<|im_end|>` is the model's EOG token, so the decode loop's
 * tokenIsEog check stops generation cleanly at end of turn.
 *
 * The assistant cue ends with an EMPTY `<think>` block — Qwen3's own
 * chat template emits exactly this for enable_thinking=false. Without
 * it Qwen3 defaults to thinking mode, which would silently burn the
 * whole maxDecodeTokens budget (256, see App.tsx) on reasoning the UI
 * never renders.
 *
 * Bounded to the last `maxTurns` user/assistant pairs so the prompt
 * (and therefore the prefill cost) doesn't grow unboundedly over a long
 * conversation.
 */
import type { ChatMessage } from './db/threadStore.js';

const DEFAULT_MAX_TURNS = 6;

const SYSTEM_PROMPT =
  'You are a helpful assistant running on Legion, a communal mesh of browser peers. ' +
  'Answer the user directly and concisely.';

/**
 * Drops `<think>...</think>` blocks from a prior assistant turn before
 * folding it back into context — Qwen3's own template strips reasoning
 * from history the same way (and a stray unclosed block would poison
 * every later turn).
 */
function stripThink(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^<think>[\s\S]*/g, '').trim();
}

export function buildPrompt(history: readonly ChatMessage[], newUserText: string, maxTurns = DEFAULT_MAX_TURNS): string {
  // Only completed turns (a message with actual content) count toward
  // the transcript — an empty in-flight assistant placeholder from a
  // still-streaming prior turn would otherwise inject a blank
  // assistant turn into the model's own context.
  const completed = history.filter((m) => m.content.trim().length > 0);
  const recent = completed.slice(-maxTurns * 2);

  const parts: string[] = [`<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>`];
  for (const m of recent) {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const content = role === 'assistant' ? stripThink(m.content) : m.content;
    if (content.length === 0) continue;
    parts.push(`<|im_start|>${role}\n${content}<|im_end|>`);
  }
  parts.push(`<|im_start|>user\n${newUserText}<|im_end|>`);
  parts.push('<|im_start|>assistant\n<think>\n\n</think>\n\n');
  return parts.join('\n');
}
