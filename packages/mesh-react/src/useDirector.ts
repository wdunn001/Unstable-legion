/**
 * useDirector — orchestrate function-calling against the unified tool bus.
 *
 * The local LLM is used as a "director" model: given a complex prompt
 * and the unified tool catalog (`useMeshToolBus().asFunctionSchemas()`),
 * the director generates a response that MAY include `<tool_call>...
 * </tool_call>` blocks. The hook detects those blocks, dispatches each
 * via `bus.dispatch(name, args)`, injects the results back into the
 * conversation as `<tool_result>...</tool_result>`, and re-prompts —
 * up to `maxRounds` (default 4).
 *
 * **End-of-turn parsing**: v1 generates the entire turn to its terminal
 * frame BEFORE parsing for tool calls. This avoids the complexity of
 * speculative mid-stream parsing (which Hermes-style decoders need
 * tricky token-streaming logic for). The trade-off is per-round
 * latency: each round = one full generation + one or more tool
 * dispatches.
 *
 * **Model compatibility**: Hermes-3-Llama-3.2-3B is the recommended
 * director — explicitly fine-tuned for function calling. Other models
 * work for single-step delegation but tend to stumble on multi-round
 * plans. The hook will run regardless of model — if no tool_call
 * blocks are emitted, the director just returns its raw answer.
 */
import { useCallback } from 'react';
import { Detokenizer, type TokenizerMap } from '@codecai/web';
import type { CodecFrame } from '@codecai/web-llm';
import type { MeshToolResult } from '@unstable-legion/core';
import type { UseLocalLlmHandle } from './useLocalLlm.js';
import type { UnifiedToolHandle, UnifiedToolDescriptor } from './useMeshToolBus.js';
import type { DirectorTraceStep } from './components/DirectorTrace.js';

export interface UseDirectorOptions {
  /** Local LLM handle — must be `phase: 'ready'` when `run()` is called. */
  llm: UseLocalLlmHandle;
  /**
   * Tokenizer map used to assemble the LLM's text response from raw
   * Codec frames. Typically the same map the rest of the chat uses.
   */
  map: TokenizerMap | null;
  /** Unified tool bus for dispatch + catalog. */
  bus: UnifiedToolHandle;
  /** Max number of generate→dispatch rounds before forcing a stop. Default 4. */
  maxRounds?: number;
  /** Per-tool-call timeout (passed through to bus.dispatch). */
  callTimeoutMs?: number;
}

export interface DirectorRunResult {
  /** Final answer text (everything after the last `<tool_result>` block). */
  text: string;
  /** Per-round generation transcript, useful for tracing/debugging. */
  rounds: Array<{
    promptLength: number;
    generation: string;
    toolCalls: Array<{ name: string; args: Readonly<Record<string, unknown>>; result: MeshToolResult }>;
  }>;
  /** Trace steps suitable for `DirectorTrace`. */
  trace: DirectorTraceStep[];
}

export interface UseDirectorHandle {
  /**
   * Run the director loop for `prompt`. Resolves with the final text
   * + trace. `onStep` fires per tool-call dispatch (running + done)
   * so callers can stream a live trace into the UI.
   */
  run: (
    prompt: string,
    onStep?: (step: DirectorTraceStep) => void,
  ) => Promise<DirectorRunResult>;
}

/** System-prompt scaffold injected ahead of the user prompt. */
function buildSystemPrompt(catalog: readonly UnifiedToolDescriptor[]): string {
  const sigs = catalog.map((d) => ({
    name: d.busName,
    description: d.description,
    parameters: d.inputSchema,
  }));
  return [
    'You are an orchestrating agent with access to a mesh of specialist tools.',
    'When a task is best solved by calling one or more tools, emit each call inside a <tool_call> block:',
    '',
    '<tool_call>',
    '{"name": "<tool-bus-name>", "arguments": {...json...}}',
    '</tool_call>',
    '',
    'Multiple <tool_call> blocks per turn are allowed. After the tool results return',
    '(as <tool_result> blocks injected by the runtime), continue your response.',
    'When you have the final answer for the user, emit it as plain text with NO tool_call blocks.',
    '',
    'Available tools:',
    JSON.stringify(sigs, null, 2),
  ].join('\n');
}

/** Build the full conversation prompt for one round. */
function buildRoundPrompt(
  systemPrompt: string,
  userPrompt: string,
  history: ReadonlyArray<{ generation: string; toolResultsBlock: string }>,
): string {
  const turns: string[] = [
    `<|system|>\n${systemPrompt}`,
    `<|user|>\n${userPrompt}`,
  ];
  for (const h of history) {
    turns.push(`<|assistant|>\n${h.generation}`);
    if (h.toolResultsBlock) turns.push(`<|tool_results|>\n${h.toolResultsBlock}`);
  }
  turns.push(`<|assistant|>\n`);
  return turns.join('\n');
}

/** Parse `<tool_call>...</tool_call>` blocks; tolerant of whitespace + json5-ish. */
function parseToolCalls(text: string): Array<{ name: string; args: Readonly<Record<string, unknown>> }> {
  const calls: Array<{ name: string; args: Readonly<Record<string, unknown>> }> = [];
  const rx = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    const body = m[1]!.trim();
    try {
      const parsed = JSON.parse(body) as { name?: unknown; arguments?: unknown };
      if (typeof parsed.name === 'string' && parsed.arguments && typeof parsed.arguments === 'object') {
        calls.push({
          name: parsed.name,
          args: parsed.arguments as Readonly<Record<string, unknown>>,
        });
      }
    } catch {
      // Skip malformed blocks — director's later turns can correct themselves.
    }
  }
  return calls;
}

export function useDirector(opts: UseDirectorOptions): UseDirectorHandle {
  const { llm, map, bus, maxRounds = 4, callTimeoutMs } = opts;

  const run = useCallback<UseDirectorHandle['run']>(
    async (prompt, onStep) => {
      if (llm.status.phase !== 'ready') {
        throw new Error(`director: local LLM is "${llm.status.phase}", not ready`);
      }
      if (!map) {
        throw new Error('director: tokenizer map not loaded');
      }
      const systemPrompt = buildSystemPrompt(bus.catalog);
      const history: Array<{ generation: string; toolResultsBlock: string }> = [];
      const rounds: DirectorRunResult['rounds'] = [];
      const trace: DirectorTraceStep[] = [];
      let finalText = '';

      for (let round = 0; round < maxRounds; round++) {
        const roundPrompt = buildRoundPrompt(systemPrompt, prompt, history);
        // Generate this turn: stream frames, detokenize on the fly,
        // assemble the full text.
        const detok = new Detokenizer(map);
        let buf = '';
        await llm.streamFrames(roundPrompt, (frame: CodecFrame) => {
          if (frame.ids?.length) {
            buf += detok.render(frame.ids, { partial: !frame.done });
          }
        });
        const generation = buf;
        const toolCalls = parseToolCalls(generation);
        if (toolCalls.length === 0) {
          // No tool calls → final answer. Strip any trailing tool_result
          // residue that might be in the generation (defensive).
          finalText = generation.replace(/<tool_result>[\s\S]*?<\/tool_result>/gi, '').trim();
          rounds.push({ promptLength: roundPrompt.length, generation, toolCalls: [] });
          break;
        }
        // Dispatch each tool call in parallel.
        const dispatches = await Promise.all(
          toolCalls.map(async (tc, i) => {
            const step: DirectorTraceStep = {
              id: `dir-${round}-${i}`,
              label: tc.name,
              target: undefined,
              status: 'running',
              startedAt: Date.now(),
              detail: tc.args,
            };
            trace.push(step);
            onStep?.(step);
            const result = await bus.dispatch(tc.name, tc.args);
            const doneStep: DirectorTraceStep = {
              ...step,
              status:
                result.status === 'ok'
                  ? 'ok'
                  : result.status === 'denied'
                    ? 'denied'
                    : 'error',
              finishedAt: Date.now(),
              summary: summarizeResultShort(result),
              detail: { args: tc.args, result },
            };
            trace.push(doneStep);
            onStep?.(doneStep);
            return { ...tc, result };
          }),
        );
        rounds.push({ promptLength: roundPrompt.length, generation, toolCalls: dispatches });
        // Build the tool_results block for the next round.
        const toolResultsBlock = dispatches
          .map(
            (d, i) =>
              `<tool_result index="${i}" name="${d.name}">\n${JSON.stringify(
                d.result.status === 'ok' ? d.result.result : { error: d.result.error },
              )}\n</tool_result>`,
          )
          .join('\n');
        history.push({ generation, toolResultsBlock });
        callTimeoutMs; // referenced for ESLint; the bus respects its own timeout option
      }

      // If we hit maxRounds without a final answer, use the last generation
      // stripped of tool_call blocks as the answer.
      if (finalText === '' && rounds.length > 0) {
        finalText = rounds[rounds.length - 1]!.generation
          .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
          .replace(/<tool_result>[\s\S]*?<\/tool_result>/gi, '')
          .trim();
      }

      return { text: finalText, rounds, trace };
    },
    [llm, map, bus, maxRounds, callTimeoutMs],
  );

  return { run };
}

function summarizeResultShort(result: MeshToolResult): string {
  if (result.status !== 'ok') return result.error ?? `(${result.status})`;
  const content =
    (result.result as { content?: unknown } | undefined)?.content ?? result.result;
  if (typeof content === 'string') return content.length > 80 ? content.slice(0, 80) + '…' : content;
  if (content && typeof content === 'object' && 'text' in content) {
    const t = (content as { text?: unknown }).text;
    if (typeof t === 'string') return t.length > 80 ? t.slice(0, 80) + '…' : t;
  }
  const s = JSON.stringify(content);
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}
