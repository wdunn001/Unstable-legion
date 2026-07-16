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

/** The subset of `MeshToolDescriptor` the prompt needs — kept structural so
 * chatPrompt stays dependency-free of @unstable-legion/core. */
export interface PromptToolSpec {
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}

/** One completed tool round inside the CURRENT exchange: the assistant turn
 * that emitted the `<tool_call>` (kept raw — Qwen3's template folds prior
 * tool-calling assistant turns verbatim) and the tool response JSON to fold
 * back as a `<tool_response>` user turn. */
export interface ToolRound {
  assistantText: string;
  /** JSON payload string (NOT wrapped) — buildPrompt adds the
   * `<tool_response>` envelope per Qwen3's template. */
  toolResponse: string;
}

export interface BuildPromptOptions {
  maxTurns?: number;
  /** Advertise these functions in the system turn (Qwen3 `<tools>` block).
   * Omit/empty -> no tools section, the model never emits `<tool_call>`. */
  tools?: readonly PromptToolSpec[];
  /** Completed tool rounds of the exchange being continued — folded after
   * the new user turn as assistant `<tool_call>` + user `<tool_response>`
   * pairs, so the model resumes exactly where the tool call paused it. */
  rounds?: readonly ToolRound[];
}

/** Qwen3's own chat-template wording for function declarations — the model
 * was trained on THIS exact framing, so we reproduce it rather than invent
 * our own (see Qwen/Qwen3-8B tokenizer_config.json chat_template). */
function toolsSection(tools: readonly PromptToolSpec[]): string {
  const lines = tools.map((t) =>
    JSON.stringify({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }),
  );
  return (
    '\n\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\n' +
    'You are provided with function signatures within <tools></tools> XML tags:\n' +
    `<tools>\n${lines.join('\n')}\n</tools>\n\n` +
    'For each function call, return a json object with function name and arguments within ' +
    '<tool_call></tool_call> XML tags:\n<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>'
  );
}

/**
 * Drops `<think>...</think>` blocks from a prior assistant turn before
 * folding it back into context — Qwen3's own template strips reasoning
 * from history the same way (and a stray unclosed block would poison
 * every later turn).
 */
function stripThink(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^<think>[\s\S]*/g, '').trim();
}

export function buildPrompt(
  history: readonly ChatMessage[],
  newUserText: string,
  opts: BuildPromptOptions = {},
): string {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  // Only completed turns (a message with actual content) count toward
  // the transcript — an empty in-flight assistant placeholder from a
  // still-streaming prior turn would otherwise inject a blank
  // assistant turn into the model's own context.
  const completed = history.filter((m) => m.content.trim().length > 0);
  const recent = completed.slice(-maxTurns * 2);

  const system = SYSTEM_PROMPT + (opts.tools && opts.tools.length > 0 ? toolsSection(opts.tools) : '');
  const parts: string[] = [`<|im_start|>system\n${system}<|im_end|>`];
  for (const m of recent) {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const content = role === 'assistant' ? stripThink(m.content) : m.content;
    if (content.length === 0) continue;
    parts.push(`<|im_start|>${role}\n${content}<|im_end|>`);
  }
  parts.push(`<|im_start|>user\n${newUserText}<|im_end|>`);
  // Completed tool rounds of THIS exchange: assistant turn (raw — includes
  // its <tool_call> block) then the tool result as a `<tool_response>` user
  // turn, exactly how Qwen3's template renders role:"tool" messages.
  for (const round of opts.rounds ?? []) {
    const assistantText = round.assistantText.trim();
    if (assistantText.length > 0) parts.push(`<|im_start|>assistant\n${assistantText}<|im_end|>`);
    parts.push(`<|im_start|>user\n<tool_response>\n${round.toolResponse}\n</tool_response><|im_end|>`);
  }
  parts.push('<|im_start|>assistant\n<think>\n\n</think>\n\n');
  return parts.join('\n');
}
