/**
 * Worker mesh protocol — typed messages exchanged between the main
 * thread (React app) and the mesh worker.
 *
 * Direction conventions:
 *   - `WorkerRequest`: main → worker. Some carry a `requestId` when
 *     they expect an ack; one-shot requests don't.
 *   - `WorkerEvent`: worker → main. Either responses to requests
 *     (matched via `requestId`) or push events (chat received,
 *     roster updated, LLM frame, etc.).
 *
 * Streaming responses (e.g. `llmStreamFrames`) correlate via
 * `streamId` — multiple in-flight streams are disambiguated by it.
 *
 * Cross-thread payloads must be structured-cloneable. CodecFrames,
 * cap records, chat messages, tool frames, and envelopes are plain
 * JSON-ish objects (verified at the wire layer) so postMessage
 * handles them transparently. Uint8Array is cloneable too. ArrayBuffer
 * transfer (zero-copy) is left for a follow-up optimization — not
 * needed for the current message-rate floor.
 *
 * Why this protocol shape (and not e.g. Comlink / promise-based RPC):
 * the mesh has streaming semantics (frame fan-out, roster snapshots,
 * cap broadcasts) that aren't naturally RPC. Hand-rolled discriminated
 * unions keep the streaming events first-class and make every
 * direction's surface visible in one file.
 */
import type {
  CodecMsgpackFrame,
  MeshChatMessage,
  MeshPeerCap,
  MeshRosterEntry,
  MeshToolFrame,
  WebRtcEnvelope,
} from '@unstable-legion/core';

import type { LlmStatus } from './useLocalLlm.js';
import type { McpAttachmentStatus } from './useMcp.js';

/* ── Trystero strategy config the worker needs to bootstrap ──────── */

export interface WorkerInitConfig {
  /** The chosen Trystero strategy's joinRoom — passed by ref source: */
  /** Trystero room id. */
  roomId: string;
  /**
   * Strategy-agnostic Trystero config — `appId`, `relayConfig`,
   * `turnConfig`, etc. Same shape MeshProvider currently consumes.
   */
  trysteroConfig: Record<string, unknown>;
  /** Initial cap to broadcast on join. */
  cap: MeshPeerCap;
  /**
   * MLC web-llm config the worker uses to instantiate its engine.
   * Provided up-front so the worker can boot the LLM in parallel with
   * the Trystero room.
   */
  llm?: {
    modelId: string;
    mapId: string;
    mirror?: import('@unstable-legion/core').MirroredModelConfig;
    defaultMaxTokens?: number;
  };
  /** Same-origin proxy base for MCP fetches (CORS workaround). */
  mcpProxyBaseUrl?: string;
  /** Trystero heartbeat ms — defaults to 30s when omitted. */
  heartbeatMs?: number;
}

/* ── Main → Worker requests ──────────────────────────────────────── */

export type WorkerRequest =
  | { kind: 'init'; requestId: string; config: WorkerInitConfig }
  | { kind: 'setCap'; cap: MeshPeerCap }
  | {
      kind: 'sendChat';
      msg: Omit<MeshChatMessage, 'v' | 'ts' | 'from'>;
      peers?: string | readonly string[];
    }
  | {
      kind: 'sendFrame';
      frame: CodecMsgpackFrame;
      peers?: string | readonly string[];
    }
  | {
      kind: 'sendTool';
      frame: MeshToolFrame;
      peers?: string | readonly string[];
    }
  | {
      kind: 'sendEnvelope';
      env: WebRtcEnvelope;
      peers?: string | readonly string[];
    }
  | { kind: 'mcpAttach'; requestId: string; url: string }
  | { kind: 'mcpDetach'; url: string }
  | { kind: 'llmLoad'; requestId: string }
  | {
      kind: 'llmStreamFrames';
      streamId: string;
      prompt: string;
      maxTokens?: number;
    }
  | { kind: 'llmAbortStream'; streamId: string }
  | { kind: 'leave' };

/* ── Worker → Main events ────────────────────────────────────────── */

export interface ToolCatalogEntry {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** 'local' = registered on this peer; 'mcp' = via MCP attachment. */
  source: 'local' | 'mcp';
  /** When `source: 'mcp'`, the originating MCP endpoint URL. */
  mcpUrl?: string;
}

export type WorkerEvent =
  /** Response to a requestId-bearing WorkerRequest. */
  | {
      kind: 'response';
      requestId: string;
      ok: boolean;
      /** Free-form payload — varies per request kind. */
      result?: unknown;
      error?: string;
    }
  /** Initial 'I'm up' once the Trystero room joins. */
  | { kind: 'ready'; selfId: string; cap: MeshPeerCap }
  /** Full roster snapshot — sent on every change. */
  | { kind: 'rosterUpdate'; snapshot: readonly MeshRosterEntry[] }
  /** Inbound chat from any peer (or self via echo if we chose to echo). */
  | { kind: 'chatRecv'; msg: MeshChatMessage; peerId: string }
  /** Inbound Codec frame. */
  | { kind: 'frameRecv'; frame: CodecMsgpackFrame; peerId: string }
  /** Inbound tool call or result. */
  | { kind: 'toolRecv'; frame: MeshToolFrame; peerId: string }
  /** Inbound WebRTC envelope (HELLO / READY / DATA / END). */
  | { kind: 'envelopeRecv'; env: WebRtcEnvelope; peerId: string }
  /** Local tool registry catalog snapshot — for useMeshToolBus. */
  | { kind: 'toolCatalog'; catalog: readonly ToolCatalogEntry[] }
  /** MCP endpoint status change. */
  | { kind: 'mcpStatus'; url: string; status: McpAttachmentStatus }
  /** LLM lifecycle. */
  | { kind: 'llmStatus'; status: LlmStatus }
  /** One frame from an in-flight llmStreamFrames. */
  | {
      kind: 'llmFrame';
      streamId: string;
      frame: import('@codecai/web-llm').CodecFrame;
    }
  /** Terminal of llmStreamFrames. */
  | {
      kind: 'llmStreamDone';
      streamId: string;
      ok: boolean;
      error?: string;
    }
  /** Out-of-band error not tied to a specific request. */
  | { kind: 'error'; detail: string };

/* ── Helpers to narrow the message-event payload ─────────────────── */

export function isWorkerEvent(v: unknown): v is WorkerEvent {
  return (
    typeof v === 'object' &&
    v !== null &&
    'kind' in v &&
    typeof (v as { kind: unknown }).kind === 'string'
  );
}
