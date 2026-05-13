/**
 * meshWorker — single DedicatedWorker hosting the whole Unstable
 * Legion peer: Trystero room + cap heartbeat + roster + tool registry
 * + MCP attachments + WebGPU LLM engine + the distributed-/ai
 * auto-responder.
 *
 * Why one big worker instead of two: every piece of mesh state has to
 * agree on selfId, the roster, and the tool catalog. Splitting into
 * multiple workers means duplicating that synchronization across
 * MessageChannels with no real isolation benefit. One worker keeps
 * the protocol surface small and the throttling behavior uniform.
 *
 * Main → Worker / Worker → Main message types live in
 * @unstable-legion/react's workerMeshProtocol module; see there for
 * the full discriminated union.
 *
 * The worker imports its Trystero strategy directly
 * (@trystero-p2p/mqtt) — strategy choice is a build-time concern for
 * the consumer app, not something we negotiate over postMessage. If a
 * different deploy wants nostr / ipfs / torrent, swap the import here.
 */
import { joinRoom, selfId, defaultRelayUrls } from '@trystero-p2p/mqtt';
import {
  joinMesh,
  registerBuiltinTools,
  ToolRegistry,
  discoverMcpEndpoint,
  detachMcpEndpoint,
  registerRouteSkillTool,
  isMirroredModelId,
  mirroredModelUrl,
  type MeshPeerCap,
  type MeshToolDescriptor,
  type Peer,
} from '@unstable-legion/core';
import {
  CreateMLCEngine,
  wrapEngine,
  prebuiltAppConfig,
  type CodecEngine,
  type MLCEngineInterface,
} from '@codecai/web-llm';
import type {
  WorkerRequest,
  WorkerEvent,
  ToolCatalogEntry,
} from '@unstable-legion/react';

void defaultRelayUrls; // re-export hint; not used directly here

let peer: Peer | null = null;
let registry: ToolRegistry | null = null;
let codec: CodecEngine | null = null;
let defaultMaxTokens = 256;
let mcpProxyBaseUrl: string | undefined;
let llmConfig: {
  modelId: string;
  mapId: string;
  mirror?: Parameters<typeof CreateMLCEngine>[1] extends infer _ ? Record<string, unknown> : never;
  defaultMaxTokens?: number;
} | null = null;
let llmLoading = false;

// Active llmStreamFrames in flight, keyed by streamId.
const activeStreams = new Map<string, AbortController>();
// MCP attachments by URL — keep the full attachment record so
// detachMcpEndpoint has the registered names to remove.
const mcpAttachments = new Map<
  string,
  Awaited<ReturnType<typeof discoverMcpEndpoint>>
>();

const w = self as unknown as Worker;
function post(evt: WorkerEvent): void {
  w.postMessage(evt);
}

function emitToolCatalog(): void {
  if (!registry) return;
  const catalog: ToolCatalogEntry[] = registry.list().map((r) => ({
    name: r.descriptor.name,
    description: r.descriptor.description,
    inputSchema: r.descriptor.inputSchema as Record<string, unknown> | undefined,
    source: r.descriptor.name.startsWith('mcp:') ? 'mcp' : 'local',
  }));
  post({ kind: 'toolCatalog', catalog });
}

async function handleInit(req: Extract<WorkerRequest, { kind: 'init' }>): Promise<void> {
  try {
    if (peer) {
      post({ kind: 'response', requestId: req.requestId, ok: false, error: 'already initialized' });
      return;
    }
    mcpProxyBaseUrl = req.config.mcpProxyBaseUrl;
    if (req.config.llm) {
      llmConfig = {
        modelId: req.config.llm.modelId,
        mapId: req.config.llm.mapId,
        mirror: req.config.llm.mirror as unknown as Record<string, unknown> | undefined,
        defaultMaxTokens: req.config.llm.defaultMaxTokens,
      };
      defaultMaxTokens = req.config.llm.defaultMaxTokens ?? 256;
    }

    registry = new ToolRegistry();
    registerBuiltinTools(registry);

    peer = await Promise.resolve(
      joinMesh({
        // Trystero's JoinRoom has a stricter type than our generic
        // JoinRoomFn; the runtime shape matches, cast through unknown.
        joinRoom: joinRoom as unknown as Parameters<typeof joinMesh>[0]['joinRoom'],
        selfId,
        trysteroConfig: req.config.trysteroConfig,
        roomId: req.config.roomId,
        cap: req.config.cap,
        heartbeatMs: req.config.heartbeatMs,
      }),
    );

    // Wire forward every Peer event to main.
    peer.onChat((msg, peerId) => {
      post({ kind: 'chatRecv', msg, peerId });
      void maybeAutoRespondToAi(msg, peerId);
    });
    peer.onFrame((frame, peerId) => {
      post({ kind: 'frameRecv', frame, peerId });
    });
    peer.onTool((frame, peerId) => {
      post({ kind: 'toolRecv', frame, peerId });
    });
    peer.onEnvelope((env, peerId) => {
      post({ kind: 'envelopeRecv', env, peerId });
    });
    peer.roster.subscribe((snapshot) => {
      post({ kind: 'rosterUpdate', snapshot });
    });

    // Wire route_skill — needs roster snapshot access.
    if (req.config.cap.delegating && req.config.cap.delegating.length > 0) {
      registerRouteSkillTool(registry, {
        peer,
        rosterSnapshot: () => peer!.roster.snapshot(),
      });
    }

    post({ kind: 'ready', selfId, cap: req.config.cap });
    post({ kind: 'rosterUpdate', snapshot: peer.roster.snapshot() });
    emitToolCatalog();
    post({ kind: 'response', requestId: req.requestId, ok: true });
  } catch (err) {
    post({
      kind: 'response',
      requestId: req.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Distributed /ai election — same shape as the original
 * MeshChatPanel + bridge.ts handlers, moved here so the worker can
 * respond even while the parent tab is throttled.
 */
async function maybeAutoRespondToAi(
  msg: { bodyKind: string; text?: string; to: string },
  peerId: string,
): Promise<void> {
  if (!peer || !codec) return;
  if (peerId === peer.selfId) return;
  if (msg.bodyKind !== 'text' || typeof msg.text !== 'string') return;
  if (!msg.text.startsWith('/ai ')) return;
  if (msg.to && msg.to !== peer.selfId) return;
  const directed = msg.to === peer.selfId;
  if (!directed) {
    const senderCap = peer.roster.get(peerId);
    if (senderCap?.available) return;
  }
  let prompt = msg.text.slice(4).trim();
  const atMatch = /^@\S+\s+(.*)$/s.exec(prompt);
  if (atMatch) prompt = atMatch[1]!;
  if (!prompt) return;
  await runLocalAiInWorker(prompt);
}

async function runLocalAiInWorker(prompt: string): Promise<void> {
  if (!peer || !codec) return;
  try {
    await codec.streamFrames(
      { prompt, max_tokens: defaultMaxTokens },
      (frame) => {
        // Broadcast frame to remote peers.
        void peer!.sendFrame(frame as never);
        // Also push to main so the local UI can show our own AI stream.
        post({ kind: 'frameRecv', frame: frame as never, peerId: peer!.selfId });
      },
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    void peer.sendChat({
      to: '',
      bodyKind: 'text',
      text: `[/ai worker error] ${errMsg}`,
    });
  }
}

async function handleLlmLoad(req: Extract<WorkerRequest, { kind: 'llmLoad' }>): Promise<void> {
  if (codec) {
    post({ kind: 'response', requestId: req.requestId, ok: true });
    post({ kind: 'llmStatus', status: { phase: 'ready', modelId: llmConfig!.modelId, mapId: llmConfig!.mapId } });
    return;
  }
  if (!llmConfig) {
    post({
      kind: 'response',
      requestId: req.requestId,
      ok: false,
      error: 'no LLM config supplied at init',
    });
    return;
  }
  if (llmLoading) return;
  llmLoading = true;
  try {
    const navAny = (self as unknown as { navigator?: { gpu?: unknown } }).navigator;
    if (!navAny?.gpu) {
      post({
        kind: 'llmStatus',
        status: {
          phase: 'unsupported',
          reason: 'this browser/worker does not expose WebGPU. Chrome 113+ desktop required.',
        },
      });
      post({
        kind: 'response',
        requestId: req.requestId,
        ok: false,
        error: 'WebGPU unavailable in worker',
      });
      return;
    }

    const appConfig = JSON.parse(JSON.stringify(prebuiltAppConfig)) as typeof prebuiltAppConfig;
    appConfig.cacheBackend = 'indexeddb';
    if (
      llmConfig.mirror &&
      isMirroredModelId(llmConfig.mirror as never, llmConfig.modelId)
    ) {
      const newBase = mirroredModelUrl(llmConfig.mirror as never, llmConfig.modelId);
      if (newBase) {
        for (const rec of appConfig.model_list) {
          if (rec.model_id === llmConfig.modelId) rec.model = newBase;
        }
      }
    }

    const storageAny = (self as unknown as {
      navigator?: { storage?: { persist?: () => Promise<boolean> } };
    }).navigator;
    if (storageAny?.storage?.persist) {
      try {
        await storageAny.storage.persist();
      } catch {
        /* ignore */
      }
    }

    post({
      kind: 'llmStatus',
      status: {
        phase: 'loading',
        pct: 0,
        text: `booting WebGPU + downloading ${llmConfig.modelId}`,
      },
    });
    const engine: MLCEngineInterface = await CreateMLCEngine(llmConfig.modelId, {
      initProgressCallback: (report) => {
        post({
          kind: 'llmStatus',
          status: {
            phase: 'loading',
            pct: Math.max(0, Math.min(1, report.progress ?? 0)),
            text: report.text ?? 'loading…',
          },
        });
      },
      appConfig,
    });
    codec = wrapEngine(engine as unknown as Parameters<typeof wrapEngine>[0], {
      mapId: llmConfig.mapId,
      defaultMaxTokens,
    });

    // Now that the engine is up, advertise engine_run as a tool so
    // peers can call it via tool dispatch — same shape the main-thread
    // demo App.tsx did previously.
    if (registry) {
      registry.register({
        descriptor: {
          name: 'engine_run',
          description: `Route a (system, user) prompt through this peer's LLM (${llmConfig.modelId}) and return rendered text.`,
          inputSchema: {
            type: 'object',
            required: ['user'],
            properties: {
              system: { type: 'string' },
              user: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        validate: (args) => {
          if (typeof args.user !== 'string' || !args.user) return 'user must be non-empty string';
          return null;
        },
        handler: async (args) => {
          if (!codec) throw new Error('engine not loaded');
          let out = '';
          await codec.streamFrames(
            { prompt: args.user as string, max_tokens: defaultMaxTokens },
            (frame) => {
              // Frames also broadcast so distant peers detokenize.
              if (peer) void peer.sendFrame(frame as never);
              if (frame.ids?.length) {
                // Server-side detokenize for the return value — best
                // effort; consumers usually rely on the broadcast.
                out += JSON.stringify(frame.ids);
              }
            },
          );
          return { content: { text: out } };
        },
      });
      emitToolCatalog();
    }

    // Re-broadcast cap with available=true now that engine is up,
    // and updated tool list.
    if (peer && registry) {
      const tools: readonly MeshToolDescriptor[] = registry
        .list()
        .map((r) => r.descriptor);
      peer.setCap({
        ...peer.roster.get(peer.selfId) ?? ({} as MeshPeerCap),
        v: 1 as const,
        ts: Date.now(),
        available: true,
        modelId: llmConfig.modelId,
        tools: [...tools],
      } as MeshPeerCap);
    }

    post({
      kind: 'llmStatus',
      status: { phase: 'ready', modelId: llmConfig.modelId, mapId: llmConfig.mapId },
    });
    post({ kind: 'response', requestId: req.requestId, ok: true });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    post({ kind: 'llmStatus', status: { phase: 'error', error } });
    post({ kind: 'response', requestId: req.requestId, ok: false, error });
  } finally {
    llmLoading = false;
  }
}

async function handleLlmStreamFrames(
  req: Extract<WorkerRequest, { kind: 'llmStreamFrames' }>,
): Promise<void> {
  if (!codec) {
    post({
      kind: 'llmStreamDone',
      streamId: req.streamId,
      ok: false,
      error: 'engine not loaded',
    });
    return;
  }
  const ac = new AbortController();
  activeStreams.set(req.streamId, ac);
  try {
    await codec.streamFrames(
      { prompt: req.prompt, max_tokens: req.maxTokens ?? defaultMaxTokens },
      (frame) => {
        if (ac.signal.aborted) return;
        post({ kind: 'llmFrame', streamId: req.streamId, frame });
      },
    );
    post({ kind: 'llmStreamDone', streamId: req.streamId, ok: ac.signal.aborted ? false : true });
  } catch (err) {
    post({
      kind: 'llmStreamDone',
      streamId: req.streamId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    activeStreams.delete(req.streamId);
  }
}

async function handleMcpAttach(
  req: Extract<WorkerRequest, { kind: 'mcpAttach' }>,
): Promise<void> {
  if (!registry) {
    post({
      kind: 'response',
      requestId: req.requestId,
      ok: false,
      error: 'registry not initialized',
    });
    return;
  }
  post({ kind: 'mcpStatus', url: req.url, status: { phase: 'connecting' } });
  try {
    const attachment = await discoverMcpEndpoint(req.url, registry, {
      proxyBaseUrl: mcpProxyBaseUrl,
    });
    mcpAttachments.set(req.url, attachment);
    post({ kind: 'mcpStatus', url: req.url, status: { phase: 'attached', attachment } });
    emitToolCatalog();
    post({ kind: 'response', requestId: req.requestId, ok: true });
  } catch (err) {
    // discoverMcpEndpoint throws McpError directly, otherwise wrap.
    const typed = err as { kind?: 'cors' | 'network' | 'protocol' | 'timeout' };
    const error =
      typed?.kind === 'cors' ||
      typed?.kind === 'network' ||
      typed?.kind === 'protocol' ||
      typed?.kind === 'timeout'
        ? (err as Parameters<typeof post>[0] extends { status: { error: infer E } } ? E : never)
        : {
            kind: 'network' as const,
            url: req.url,
            detail: err instanceof Error ? err.message : String(err),
          };
    post({ kind: 'mcpStatus', url: req.url, status: { phase: 'error', error } });
    post({
      kind: 'response',
      requestId: req.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function handleMcpDetach(req: Extract<WorkerRequest, { kind: 'mcpDetach' }>): void {
  if (!registry) return;
  const attachment = mcpAttachments.get(req.url);
  if (attachment) {
    detachMcpEndpoint(attachment, registry);
    mcpAttachments.delete(req.url);
  }
  emitToolCatalog();
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const m = event.data;
  switch (m.kind) {
    case 'init':
      void handleInit(m);
      break;
    case 'setCap':
      peer?.setCap(m.cap);
      break;
    case 'sendChat':
      // Don't synthetically fire the auto-responder for our own
      // outbound /ai — the main thread still owns the "user typed
      // /ai locally → stream from local engine" path via the
      // worker-proxied useLocalLlm.streamFrames. Doing both would
      // double-respond. The worker's auto-responder is for INCOMING
      // chat from other peers (Trystero doesn't echo our own).
      void peer?.sendChat(m.msg, m.peers as string | string[] | undefined);
      break;
    case 'sendFrame':
      void peer?.sendFrame(m.frame, m.peers as string | string[] | undefined);
      break;
    case 'sendTool':
      void peer?.sendTool(m.frame, m.peers as string | string[] | undefined);
      break;
    case 'sendEnvelope':
      void peer?.sendEnvelope(m.env, m.peers as string | string[] | undefined);
      break;
    case 'mcpAttach':
      void handleMcpAttach(m);
      break;
    case 'mcpDetach':
      handleMcpDetach(m);
      break;
    case 'llmLoad':
      void handleLlmLoad(m);
      break;
    case 'llmStreamFrames':
      void handleLlmStreamFrames(m);
      break;
    case 'llmAbortStream': {
      const ac = activeStreams.get(m.streamId);
      if (ac) ac.abort();
      break;
    }
    case 'leave':
      peer?.leave();
      peer = null;
      break;
  }
};
