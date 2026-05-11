/**
 * Demo composition — wires `@unstable-legion/react` hooks + components
 * together with a chosen Trystero strategy (`@trystero-p2p/mqtt`),
 * persona persistence, and the demo's defaults.
 *
 * Everything load-bearing lives in `@unstable-legion/{core,react}`.
 * This file is the showcase: pick a strategy, configure persona
 * defaults, render the components.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { joinRoom, defaultRelayUrls, selfId } from '@trystero-p2p/mqtt';
import {
  Detokenizer,
  // engine_run handler builds its own detokenizer
} from '@codecai/web';
import {
  DEFAULT_MODEL_CATALOG,
  LlmStatusPanel,
  McpStatusRow,
  MOBILE_MODEL_CATALOG,
  MeshChatPanel,
  MeshProvider,
  MeshRosterPanel,
  PersonaForm,
  ToolRegistry,
  detectMobileLikelyNeedsFp32,
  findModelEntry,
  mergeRelayUrls,
  registerBuiltinTools,
  useCodecMap,
  useLocalLlm,
  useMcpAttachments,
  useMeshContext,
  useMeshTools,
  usePersona,
  type ModelCatalogEntry,
  type MeshProviderProps,
  type MeshToolDescriptor,
  type UseMcpAttachmentsHandle,
  type UseLocalLlmHandle,
  useMeshRoster,
  type CodecMapHandle,
} from '@unstable-legion/react';

const ROOM_ID = 'legion-demo';

/**
 * Same-origin mirror of the @mlc-ai/web-llm prebuilt model repos.
 * The deploy mounts `/storage/mzfs/webllm-mirror` into the nginx
 * container at `/webllm/`. Includes both the default (fp16) and
 * mobile (fp32) catalogs — anything outside this union falls through
 * to the Hugging Face default.
 */
const MIRROR_CONFIG = {
  modelIds: [
    ...DEFAULT_MODEL_CATALOG.map((m) => m.id),
    ...MOBILE_MODEL_CATALOG.map((m) => m.id),
  ],
  baseUrl:
    typeof window !== 'undefined' ? `${window.location.origin}/webllm` : '/webllm',
};

const RELAY_URLS = mergeRelayUrls({
  defaults: defaultRelayUrls,
  blockedHosts: ['test.mosquitto.org', 'broker-cn.emqx.io'],
  max: 6,
});
const TRYSTERO_CONFIG: MeshProviderProps['trysteroConfig'] = {
  appId: 'unstable-legion-demo-v0',
  // `relayConfig.urls` is the correct key in @trystero-p2p/* 0.24+
  // (NOT `relayUrls` — that's silently ignored and falls back to
  // the strategy's defaults).
  relayConfig: { urls: RELAY_URLS },
};

export function App() {
  const { persona, update: updatePersona } = usePersona();
  const [joined, setJoined] = useState(false);

  // Tool registry — one per session.
  const registryRef = useRef<ToolRegistry | null>(null);
  if (registryRef.current === null) {
    const reg = new ToolRegistry();
    registerBuiltinTools(reg);
    registryRef.current = reg;
  }
  const registry = registryRef.current;

  // MCP endpoints get attached at App level (survives room reconnects).
  const mcp = useMcpAttachments({
    registry,
    urls: persona.mcpEndpoints,
  });

  // Tool names available to the persona form (registry + MCP-discovered).
  const availableToolNames = useMemo(
    () => registry.list().map((r) => r.descriptor.name),
    [registry, mcp.attachedTools],
  );

  // Catalog selection: bootMode + UA → fp16 or fp32 catalog.
  //   - 'auto': UA-detect; mobile → fp32, desktop → fp16
  //   - 'fp16': force fp16 (faster, needs shader-f16)
  //   - 'fp32': force fp32 (mobile-safe, ~2× download)
  const activeCatalog: readonly ModelCatalogEntry[] = useMemo(() => {
    if (persona.bootMode === 'fp16') return DEFAULT_MODEL_CATALOG;
    if (persona.bootMode === 'fp32') return MOBILE_MODEL_CATALOG;
    return detectMobileLikelyNeedsFp32() ? MOBILE_MODEL_CATALOG : DEFAULT_MODEL_CATALOG;
  }, [persona.bootMode]);

  // If the persona's modelId isn't in the active catalog, auto-pick the
  // first entry — keeps "auto" sane when the user lands on mobile with
  // a stored Qwen2.5-q4f16_1 modelId from a prior desktop session.
  useEffect(() => {
    const inCatalog = activeCatalog.some((m) => m.id === persona.modelId);
    if (!inCatalog && activeCatalog.length > 0) {
      updatePersona({ modelId: activeCatalog[0]!.id });
    }
  }, [activeCatalog, persona.modelId, updatePersona]);

  // Auto-opt-in newly-attached MCP tools.
  useEffect(() => {
    const newOnes = mcp.attachedTools
      .map((t) => t.toolName)
      .filter((name) => !persona.availableTools.includes(name));
    if (newOnes.length > 0) {
      updatePersona({ availableTools: [...persona.availableTools, ...newOnes] });
    }
  }, [mcp.attachedTools, persona.availableTools, updatePersona]);

  const cap = useMemo(() => {
    if (!persona.nick) return null;
    const tools: MeshToolDescriptor[] = registry.descriptorsFor(persona.availableTools);
    const summary =
      persona.systemPrompt.length > 120
        ? persona.systemPrompt.slice(0, 117) + '…'
        : persona.systemPrompt;
    return {
      v: 1 as const,
      nick: persona.nick,
      modelId: persona.modelId,
      available: persona.available,
      skills: persona.skills,
      systemPromptSummary: summary,
      tools,
    };
  }, [persona, registry, mcp.attachedTools]);

  // Resolve the persona's modelId to its tokenizer-map family so the
  // local detokenizer renders this peer's frames correctly. The
  // active catalog (fp16 OR fp32) decides; both catalogs share the
  // same `mapId` per family so the resolution is stable across modes.
  const modelEntry = findModelEntry(activeCatalog, persona.modelId);
  const mapId = modelEntry?.mapId ?? 'qwen/qwen2';

  if (!joined || !cap) {
    return (
      <PersonaForm
        persona={persona}
        onUpdate={updatePersona}
        onSubmit={() => setJoined(true)}
        availableToolNames={availableToolNames}
        modelCatalog={activeCatalog}
        title="Unstable Legion"
        tagline="peer-to-peer browser-AI mesh on the Codec wire"
        footer={
          <footer>
            <p>
              MQTT-based serverless WebRTC discovery via{' '}
              <a href="https://github.com/dmotz/trystero">Trystero</a>. your browser
              becomes a node in a public p2p mesh — no accounts, no servers.
            </p>
            <p>
              local LLM is <strong>Qwen2.5-0.5B-Instruct</strong> via the patched{' '}
              <code>wdunn001/web-llm</code> fork. ships raw Codec frames over the
              mesh — no host-side tokenize/detokenize.
            </p>
          </footer>
        }
      />
    );
  }

  return (
    <MeshProvider
      joinRoom={joinRoom}
      selfId={selfId}
      trysteroConfig={TRYSTERO_CONFIG}
      roomId={ROOM_ID}
      cap={cap}
    >
      <Dashboard
        nick={persona.nick}
        modelId={persona.modelId}
        mapId={mapId}
        onChangeNick={() => setJoined(false)}
        toolRegistry={registry}
        optedInTools={persona.availableTools}
        mcp={mcp}
      />
    </MeshProvider>
  );
}

/**
 * Dashboard — composition of the library's panels + the demo-specific
 * `engine_run` tool registration that bridges the local LLM to the
 * tool-call surface.
 */
function Dashboard(props: {
  nick: string;
  modelId: string;
  mapId: string;
  onChangeNick: () => void;
  toolRegistry: ToolRegistry;
  optedInTools: readonly string[];
  mcp: UseMcpAttachmentsHandle;
}) {
  const llm = useLocalLlm({
    modelId: props.modelId,
    mapId: props.mapId,
    mirror: MIRROR_CONFIG,
  });
  const codecMap: CodecMapHandle = useCodecMap({ family: props.mapId });
  const tools = useMeshTools({
    registry: props.toolRegistry,
    optedIn: props.optedInTools,
  });

  // engine_run — turns the local LLM into a remote-callable tool.
  useEffect(() => {
    if (llm.status.phase !== 'ready' || !codecMap.map) return;
    const map = codecMap.map;
    props.toolRegistry.register({
      descriptor: {
        name: 'engine_run',
        description:
          "Route a (system, user) prompt through this peer's local LLM and return the rendered text.",
        inputSchema: {
          type: 'object',
          required: ['user'],
          properties: {
            system: { type: 'string', description: 'Optional system prompt.' },
            user: { type: 'string', description: 'User prompt content.' },
          },
          additionalProperties: false,
        },
      },
      validate: (args) => {
        if (typeof args.user !== 'string' || !args.user) return 'user must be a non-empty string';
        if (args.system !== undefined && typeof args.system !== 'string') return 'system must be a string';
        return null;
      },
      handler: async (args) => {
        const detok = new Detokenizer(map);
        let out = '';
        await llm.streamFrames(args.user as string, (frame) => {
          if (frame.ids?.length) {
            out += detok.render(frame.ids, { partial: !frame.done });
          }
        });
        return { content: { text: out } };
      },
    });
    return () => {
      props.toolRegistry.unregister('engine_run');
    };
  }, [llm.status, codecMap.map, props.toolRegistry, llm]);

  return (
    <div className="ul-app">
      <Header
        nick={props.nick}
        onChangeNick={props.onChangeNick}
        llmStatus={llm.status}
      />
      <LlmStatusPanel
        llm={llm}
        bootDisabled={codecMap.map === null}
        bootLabel={`boot ${props.modelId.replace(/-q[0-9].*-MLC$/i, '').replace(/-MLC$/i, '')}`}
        bootDisabledLabel="loading tokenizer map…"
        selectedModelId={props.modelId}
      />
      <McpStatusRow
        mcp={props.mcp}
        emptyMessage="no MCP endpoints attached. add via the persona form (change nick → MCP list)."
      />
      <div className="ul-cols">
        <MeshRosterPanel />
        <MeshChatPanel
          llm={llm}
          map={codecMap.map}
          mapError={codecMap.error}
          tools={tools}
        />
      </div>
    </div>
  );
}

function Header(props: {
  nick: string;
  onChangeNick: () => void;
  llmStatus: UseLocalLlmHandle['status'];
}) {
  const { peer } = useMeshContext();
  const roster = useMeshRoster();
  const remotes = peer
    ? roster.filter((r) => r.peerId !== peer.selfId).length
    : 0;
  const llmLabel =
    props.llmStatus.phase === 'loading'
      ? `${Math.round(props.llmStatus.pct * 100)}%`
      : props.llmStatus.phase;
  return (
    <header className="ul-header">
      <span className="ul-brand">Unstable Legion</span>
      <span className="ul-sep">·</span>
      <span className="ul-nick">@{props.nick}</span>
      <span className="ul-sep">·</span>
      <span className="ul-selfid">
        {peer ? truncate(peer.selfId, 10) : 'connecting…'}
      </span>
      <span className="ul-sep">·</span>
      <span className={`ul-mesh-pill ${remotes > 0 ? 'ul-mesh-ok' : 'ul-mesh-cold'}`}>
        mesh: {remotes} remote
      </span>
      <span className="ul-sep">·</span>
      <span className={`ul-llm-pill ul-llm-${props.llmStatus.phase}`}>llm: {llmLabel}</span>
      <button className="ul-link" onClick={props.onChangeNick}>
        change nick
      </button>
    </header>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
