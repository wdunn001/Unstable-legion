/**
 * TOOL-NODES — agentic tool use inside the communal chat loop.
 *
 * A no-GPU peer can contribute TOOL CALLS instead of model layers and still
 * earn standing (`docs/TOOL-NODES.md`). This module is the pure, unit-tested
 * core of that path:
 *
 *   1. `parseToolCalls` / `firstToolCall` — detect a tool call in a span of
 *      GENERATED text (the driver detokenizes its own token stream and scans
 *      it). Reuses the exact `<tool_call>{"name","arguments"}</tool_call>`
 *      convention `mesh-react`'s `useDirector` already emits, so a model
 *      prompted for either surface interoperates.
 *   2. `runToolRoundTrip` — route ONE detected call to a peer advertising
 *      that tool (`routing.findPeersByTool`), send it over `tc`, await the
 *      correlated `MeshToolResult` on a `PendingToolCallTracker`, and hand
 *      back a `<tool_result>` block the driver re-prefills to continue
 *      generation. Robust to the tool peer vanishing: each candidate is
 *      tried in ranked order with a bounded timeout; exhausting them all is
 *      a graceful `no-provider`/`timeout`, never a hang.
 *   3. Economy: on a served call it credits the provider and debits the
 *      consumer in the caller's `StandingLedger` (see `standing.ts`'s
 *      `recordToolService`/`recordToolConsumption`).
 *
 * SCOPE (read before extending — matches the PR's "single round-trip"
 * landing): this proves ONE call → one result → one re-prefill. The full
 * multi-round / nested agentic loop (generate → detect → serve → re-prefill →
 * generate again, N times, with parallel calls per turn) is documented as
 * follow-up in `docs/TOOL-NODES.md`; the building blocks here compose into
 * it, but the multi-round driver is not wired in this pass.
 */
import type { MeshRosterEntry, MeshToolCall, MeshToolFrame, MeshToolResult } from './types.js';
import { MESH_PROTOCOL_VERSION } from './types.js';
import { PendingToolCallTracker, newCallId } from './tools.js';
import { findPeersByTool } from './routing.js';
import type { StandingLedger } from './standing.js';

// ── Detection ────────────────────────────────────────────────────────────

export interface ParsedToolCall {
  name: string;
  args: Readonly<Record<string, unknown>>;
  /** The exact `<tool_call>…</tool_call>` substring this was parsed from —
   * lets the caller know how much of the generated span to treat as
   * "consumed by the tool call" vs. keep as visible text. */
  raw: string;
}

const TOOL_CALL_RX = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;

/**
 * Parse every `<tool_call>{"name": "...", "arguments": {...}}</tool_call>`
 * block in `text`. Tolerant of surrounding whitespace; silently skips
 * malformed blocks (a partial/garbled block from mid-stream detokenization
 * self-corrects on the next chunk) rather than throwing — same discipline as
 * `decodeStageControl`.
 */
export function parseToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  TOOL_CALL_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOOL_CALL_RX.exec(text)) !== null) {
    const body = m[1]!.trim();
    try {
      const parsed = JSON.parse(body) as { name?: unknown; arguments?: unknown };
      if (
        typeof parsed.name === 'string' &&
        parsed.name.length > 0 &&
        parsed.arguments &&
        typeof parsed.arguments === 'object' &&
        !Array.isArray(parsed.arguments)
      ) {
        calls.push({ name: parsed.name, args: parsed.arguments as Readonly<Record<string, unknown>>, raw: m[0]! });
      }
    } catch {
      // malformed block — skip, the next detokenized chunk may complete it
    }
  }
  return calls;
}

/** The first well-formed tool call in `text`, or `null`. Convenience for the
 * single-round-trip driver path (this PR's scope). */
export function firstToolCall(text: string): ParsedToolCall | null {
  return parseToolCalls(text)[0] ?? null;
}

/** Format a `MeshToolResult` (or an error) as a `<tool_result>` block for the
 * driver to re-prefill into the model's context. Mirrors `useDirector`'s
 * `<tool_result>` convention so a model prompted for either interoperates. */
export function buildToolResultBlock(toolName: string, result: MeshToolResult): string {
  const payload =
    result.status === 'ok'
      ? { name: toolName, result: result.result?.content ?? result.result ?? null }
      : { name: toolName, error: result.error ?? `tool ${result.status}` };
  return `<tool_result>\n${JSON.stringify(payload)}\n</tool_result>`;
}

// ── Routing + round-trip ───────────────────────────────────────────────────

/** The narrow `Peer` surface a tool round-trip needs — same shape
 * `stageOrchestrator.ts` uses, so a mock transport can drive it. */
export interface ToolRoundTripPeer {
  readonly selfId: string;
  sendTool(frame: MeshToolFrame, peers?: string | string[]): Promise<void>;
  onTool(cb: (frame: MeshToolFrame, peerId: string) => void): () => void;
}

export type ToolRoundTripStatus = 'ok' | 'error' | 'denied' | 'no-provider' | 'timeout';

export interface ToolRoundTripResult {
  status: ToolRoundTripStatus;
  /** The peer that actually answered (any status except `no-provider`). */
  providerPeerId?: string;
  /** The raw result frame, when a provider answered. */
  result?: MeshToolResult;
  /** `<tool_result>` block ready for the driver to re-prefill — present
   * whenever a provider answered (ok OR error; the model is told about
   * failures too so it can recover). */
  resultBlock?: string;
  /** Human-readable reason on a non-ok terminal outcome. */
  error?: string;
  /** Providers tried before this outcome (for logs/telemetry). */
  triedPeerIds: readonly string[];
}

export interface RunToolRoundTripOptions {
  peer: ToolRoundTripPeer;
  /** Live roster snapshot — providers are found via `findPeersByTool`. */
  roster: readonly MeshRosterEntry[];
  /** The detected call to route (from `firstToolCall`, or hand-built). */
  call: { name: string; args: Readonly<Record<string, unknown>> };
  /** Per-candidate wait for a `MeshToolResult`. Default 30_000. */
  timeoutMs?: number;
  /** Rank providers highest-first (e.g. `bindPriorityScore(ledger, clock)`
   * — so a tool node with earned standing is preferred). Ties fall back to
   * freshest `lastSeen`. Default `() => 0`. */
  priorityScore?: (peerId: string) => number;
  /** Skip this peerId as a provider (normally `peer.selfId` — don't call
   * your own tool over the wire). */
  excludePeerId?: string;
  /** When supplied, credit the answering provider and debit self, per
   * `docs/TOOL-NODES.md`'s economy. */
  standingLedger?: StandingLedger;
  /** Injected clock for the ledger writes (default `Date.now`). */
  now?: () => number;
}

/** Rank tool providers: priorityScore desc, then freshest lastSeen, then
 * peerId asc (determinism). */
function rankProviders(
  providers: readonly MeshRosterEntry[],
  priorityScore: (peerId: string) => number,
): MeshRosterEntry[] {
  return [...providers].sort((a, b) => {
    const pa = priorityScore(a.peerId);
    const pb = priorityScore(b.peerId);
    if (pa !== pb) return pb - pa;
    if (a.lastSeen !== b.lastSeen) return b.lastSeen - a.lastSeen;
    return a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0;
  });
}

/**
 * Route ONE tool call to a live provider and return its result. Tries each
 * provider (ranked) in turn until one answers within `timeoutMs`; a
 * disappearing/silent provider simply falls through to the next, and an
 * empty/exhausted provider set is a graceful `no-provider`/`timeout`.
 *
 * Wire correlation reuses `PendingToolCallTracker` exactly as the docstring
 * on `tools.ts` prescribes — this function owns a private tracker + its own
 * `onTool` subscription for the duration of the round trip, so it composes
 * cleanly alongside a stage session's own tracker without cross-talk (result
 * frames are keyed by a freshly-minted `callId`).
 */
export async function runToolRoundTrip(opts: RunToolRoundTripOptions): Promise<ToolRoundTripResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const priorityScore = opts.priorityScore ?? (() => 0);
  const now = opts.now ?? (() => Date.now());
  const selfId = opts.excludePeerId ?? opts.peer.selfId;

  const providers = rankProviders(
    findPeersByTool(opts.roster, opts.call.name, { excludePeerId: selfId }),
    priorityScore,
  );
  const triedPeerIds: string[] = [];

  if (providers.length === 0) {
    return { status: 'no-provider', error: `no peer advertises tool "${opts.call.name}"`, triedPeerIds };
  }

  const tracker = new PendingToolCallTracker();
  const unsub = opts.peer.onTool((frame) => {
    if (frame.kind === 'result') tracker.settle(frame);
  });

  try {
    for (const provider of providers) {
      triedPeerIds.push(provider.peerId);
      const callId = newCallId();
      const callFrame: MeshToolFrame = {
        kind: 'call',
        v: MESH_PROTOCOL_VERSION,
        ts: now(),
        callId,
        toolName: opts.call.name,
        args: opts.call.args,
      } satisfies { kind: 'call' } & MeshToolCall;

      let result: MeshToolResult;
      try {
        const waiter = tracker.expect(callId, timeoutMs);
        await opts.peer.sendTool(callFrame, provider.peerId);
        result = await waiter;
      } catch {
        // timeout or send failure — this provider vanished; try the next.
        continue;
      }

      // A provider answered. Record economy: provider credited on success,
      // self debited for consuming regardless (occupied the provider's turn).
      if (opts.standingLedger) {
        const t = now();
        opts.standingLedger.recordToolService(
          { providerPeerId: provider.peerId, toolName: opts.call.name, succeeded: result.status === 'ok' },
          t,
        );
        opts.standingLedger.recordToolConsumption({ consumerPeerId: opts.peer.selfId, toolName: opts.call.name }, t);
      }

      return {
        status: result.status,
        providerPeerId: provider.peerId,
        result,
        resultBlock: buildToolResultBlock(opts.call.name, result),
        ...(result.status !== 'ok' ? { error: result.error ?? `tool ${result.status}` } : {}),
        triedPeerIds,
      };
    }
    // Every provider timed out / failed to send.
    return {
      status: 'timeout',
      error: `no provider answered tool "${opts.call.name}" within ${timeoutMs}ms (tried ${triedPeerIds.length})`,
      triedPeerIds,
    };
  } finally {
    unsub();
    tracker.abortAll('tool round-trip finished');
  }
}
