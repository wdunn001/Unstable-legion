/**
 * toolChat — pure helpers for the chat app's multi-round tool loop.
 *
 * The loop itself lives in App.tsx (it needs the live peer/roster/chat
 * handle); everything decision-shaped and testable lives here:
 *
 *   - `collectMeshTools` — which tools the system prompt should declare
 *     (union of tools advertised across the roster, self included so a
 *     solo tab can consume its own contribution, deduped by name).
 *   - `buildToolResponsePayload` — the JSON payload a mesh
 *     `MeshToolResult` (or terminal failure) folds back into the model's
 *     context. chatPrompt.ts wraps it in Qwen3's `<tool_response>`
 *     envelope; this stays envelope-free.
 *   - `stripToolMarkup` — what the USER sees: generated text minus the
 *     `<tool_call>` blocks (the trace chips carry that story instead).
 *
 * Round policy: `MAX_TOOL_ROUNDS` bounds the generate → call → re-prefill
 * loop per user message, so a model that keeps asking for tools can never
 * spin the mesh forever — the last round's text stands as the answer.
 */
import type { MeshRosterEntry } from '@unstable-legion/core';
import type { PromptToolSpec } from './chatPrompt.js';

/** Structural slice of `MeshToolResult` the payload builder needs — also
 * matches `ToolRegistry.dispatch`'s return (the kind-less result), so the
 * self-serve path needs no cast. */
export interface ToolOutcome {
  status: string;
  result?: { content?: unknown } | undefined;
  error?: string | undefined;
}

/** Upper bound on tool rounds per user message (generate → serve →
 * re-prefill counts as one round). */
export const MAX_TOOL_ROUNDS = 3;

/**
 * Union of tools advertised by live roster peers, deduped by name (first
 * advertiser wins — descriptors for the same name are expected to agree).
 * Self's tools are INCLUDED: a solo tab that opted in to `current_time`
 * should be able to answer "what time is it" without a second peer (the
 * loop self-serves when no other provider advertises the tool).
 */
export function collectMeshTools(roster: readonly MeshRosterEntry[]): PromptToolSpec[] {
  const byName = new Map<string, PromptToolSpec>();
  for (const entry of roster) {
    if (!entry.available) continue;
    for (const tool of entry.tools) {
      if (!byName.has(tool.name)) {
        byName.set(tool.name, {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }
  }
  return [...byName.values()];
}

/** JSON payload for a served result — mirrors the shape Qwen3 sees from
 * OpenAI-style tool execution: the bare result content on success, a
 * `{"error": ...}` object on failure so the model can recover in prose. */
export function buildToolResponsePayload(toolName: string, result: ToolOutcome | undefined, error?: string): string {
  if (result && result.status === 'ok') {
    return JSON.stringify(result.result?.content ?? null);
  }
  const reason = error ?? result?.error ?? (result ? `tool ${result.status}` : 'tool call failed');
  return JSON.stringify({ error: `${toolName}: ${reason}` });
}

/** Remove `<tool_call>…</tool_call>` blocks (and any dangling unterminated
 * one at the tail of a stream) from generated text for DISPLAY — the tool
 * trace chips tell that part of the story. Collapses the whitespace the
 * removal leaves behind. */
export function stripToolMarkup(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<tool_call>[\s\S]*$/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
