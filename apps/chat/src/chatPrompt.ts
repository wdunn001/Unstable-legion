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
 * model has conversational context, using a plain transcript format —
 * no special tokens, since the stage worker's `tokenize()` has no
 * chat-template awareness (it tokenizes raw text).
 *
 * Bounded to the last `maxTurns` user/assistant pairs so the prompt
 * (and therefore the prefill cost) doesn't grow unboundedly over a long
 * conversation.
 */
import type { ChatMessage } from './db/threadStore.js';

const DEFAULT_MAX_TURNS = 6;

export function buildPrompt(history: readonly ChatMessage[], newUserText: string, maxTurns = DEFAULT_MAX_TURNS): string {
  // Only completed turns (a message with actual content) count toward
  // the transcript — an empty in-flight assistant placeholder from a
  // still-streaming prior turn would otherwise inject a blank
  // "Assistant:" line into the model's own context.
  const completed = history.filter((m) => m.content.trim().length > 0);
  const recent = completed.slice(-maxTurns * 2);

  if (recent.length === 0) return newUserText;

  const lines: string[] = [];
  for (const m of recent) {
    lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`);
  }
  lines.push(`User: ${newUserText}`);
  lines.push('Assistant:');
  return lines.join('\n');
}
