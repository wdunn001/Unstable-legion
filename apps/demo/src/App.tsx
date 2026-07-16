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
  registerRouteSkillTool,
  useAudioKeepalive,
  useDeviceCompat,
  useMeshRoster,
  AudioKeepaliveToggle,
  LlmStatusPanel,
  McpStatusRow,
  MOBILE_MODEL_CATALOG,
  MeshChatPanel,
  MeshProvider,
  MeshRosterPanel,
  PersonaForm,
  ToolRegistry,
  defaultTurnConfig,
  detectMobileLikelyNeedsFp32,
  findModelEntry,
  mergeRelayUrls,
  registerBuiltinTools,
  useCodecMap,
  useLocalLlm,
  useMcpAttachments,
  useMeshContext,
  useMeshTools,
  useMeshToolBus,
  usePersona,
  type ModelCatalogEntry,
  type MeshProviderProps,
  type MeshPeerCap,
  type MeshToolDescriptor,
  type UseMcpAttachmentsHandle,
  type UseLocalLlmHandle,
  type CodecMapHandle,
} from '@unstable-legion/react';
import { StagePipelinePanel } from './components/StagePipelinePanel.js';
import { CommunalHostPanel } from './components/CommunalHostPanel.js';

// `?room=` override lets e2e runs (and anyone testing against a live
// deploy) use an isolated room instead of the shared public one —
// Trystero's MQTT strategy uses public relays by default, so without
// this every Playwright run would cross-talk with real demo users on
// `legion-demo`. Mirrors legion-stage-runtime's harness `roomSuffix`
// query param (H:\dev\legion-stage-runtime\harness\e2e\*.spec.ts).
const ROOM_ID =
  (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('room') : null) ?? 'legion-demo';

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
// Build-time TURN config — see apps/demo/Dockerfile. STUN-only by
// default; set VITE_TURN_URLS=turn:legion.codecai.net:3478,
// VITE_TURN_USERNAME=legion, VITE_TURN_CREDENTIAL=... at build time
// to wire in self-hosted coturn (or any other TURN provider).
const TURN_URLS_RAW = import.meta.env.VITE_TURN_URLS ?? '';
const TURN_USERNAME = import.meta.env.VITE_TURN_USERNAME || undefined;
const TURN_CREDENTIAL = import.meta.env.VITE_TURN_CREDENTIAL || undefined;
const TURN_USE_DEFAULT = import.meta.env.VITE_TURN_USE_DEFAULT === '1';
const TURN_EXTRAS = TURN_URLS_RAW
  ? TURN_URLS_RAW.split(/[\s,]+/)
      .filter(Boolean)
      .map((url) => ({
        urls: url,
        ...(TURN_USERNAME ? { username: TURN_USERNAME } : {}),
        ...(TURN_CREDENTIAL ? { credential: TURN_CREDENTIAL } : {}),
      }))
  : [];
const TURN_CONFIG = defaultTurnConfig({
  extras: TURN_EXTRAS,
  useDefault: TURN_USE_DEFAULT,
});

const TRYSTERO_CONFIG: MeshProviderProps['trysteroConfig'] = {
  appId: 'unstable-legion-demo-v0',
  // `relayConfig.urls` is the correct key in @trystero-p2p/* 0.24+
  // (NOT `relayUrls` — that's silently ignored and falls back to
  // the strategy's defaults).
  relayConfig: { urls: RELAY_URLS },
  turnConfig: TURN_CONFIG,
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
  // Public MCP servers rarely include CORS headers, so a direct browser
  // fetch fails with "Failed to fetch". Route everything through nginx
  // at /mcp-proxy/ — see apps/demo/nginx.conf for the matching upstream
  // regex. Same-origin requests bypass CORS entirely.
  const mcp = useMcpAttachments({
    registry,
    urls: persona.mcpEndpoints,
    proxyBaseUrl:
      typeof window !== 'undefined' ? `${window.location.origin}/mcp-proxy/` : undefined,
  });

  // Tool names available to the persona form (registry + MCP-discovered).
  const availableToolNames = useMemo(
    () => registry.list().map((r) => r.descriptor.name),
    [registry, mcp.attachedTools],
  );

  // GPU/adapter-driven device compatibility probe. Layered ON TOP of
  // the bootMode + UA logic — if the device's GPU is in the thin-client
  // tier (e.g. Adreno), the catalog collapses to empty no matter what
  // the persona says, and the LlmStatusPanel surfaces a warning instead
  // of a boot button.
  const deviceCompat = useDeviceCompat();

  // Catalog selection: bootMode + UA → fp16 or fp32 catalog, then
  // filter by deviceCompat tier.
  //   - 'auto': UA-detect; mobile → fp32, desktop → fp16
  //   - 'fp16': force fp16 (faster, needs shader-f16)
  //   - 'fp32': force fp32 (mobile-safe, ~2× download)
  const activeCatalog: readonly ModelCatalogEntry[] = useMemo(() => {
    // If the GPU is known-broken-for-ML, no model in the catalog will
    // produce correct output. Collapse to empty so the picker can't
    // mislead the operator.
    if (deviceCompat?.tier === 'thinclient') return [];
    const requestedCatalog =
      persona.bootMode === 'fp16'
        ? DEFAULT_MODEL_CATALOG
        : persona.bootMode === 'fp32'
          ? MOBILE_MODEL_CATALOG
          : detectMobileLikelyNeedsFp32()
            ? MOBILE_MODEL_CATALOG
            : DEFAULT_MODEL_CATALOG;
    // Mali / Xclipse / Imagination — small-only tier: even when the
    // persona requests fp16, force the fp32 catalog (smaller models
    // are the only ones that have a chance).
    if (deviceCompat?.tier === 'small-only') return MOBILE_MODEL_CATALOG;
    return requestedCatalog;
  }, [persona.bootMode, deviceCompat?.tier]);

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

  // Thin-client devices (Adreno) cannot service prompts. Flip
  // available=false automatically so the peer's cap honestly says
  // "I'm here for routing but won't run /ai prompts."
  useEffect(() => {
    if (deviceCompat?.tier === 'thinclient' && persona.available) {
      updatePersona({ available: false });
    }
  }, [deviceCompat?.tier, persona.available, updatePersona]);

  // Effective opt-in list — auto-add `route_skill` when the persona
  // has any delegating zones; otherwise the dispatcher would reject
  // inbound route_skill calls even though the tool is registered.
  const effectiveOptedIn = useMemo(() => {
    const delegating = persona.delegating ?? [];
    if (delegating.length === 0) return persona.availableTools;
    if (persona.availableTools.includes('route_skill')) return persona.availableTools;
    return [...persona.availableTools, 'route_skill'];
  }, [persona.availableTools, persona.delegating]);

  const cap = useMemo(() => {
    if (!persona.nick) return null;
    const tools: MeshToolDescriptor[] = registry.descriptorsFor(effectiveOptedIn);
    const summary =
      persona.systemPrompt.length > 120
        ? persona.systemPrompt.slice(0, 117) + '…'
        : persona.systemPrompt;
    const baseCap = {
      v: 1 as const,
      nick: persona.nick,
      modelId: persona.modelId,
      available: persona.available,
      skills: persona.skills,
      systemPromptSummary: summary,
      tools,
    };
    // Layer-4 fields — only include when set so peers without
    // hierarchical routing stay byte-identical to v1 caps.
    const authoritative = persona.authoritative ?? [];
    const delegating = persona.delegating ?? [];
    return {
      ...baseCap,
      ...(authoritative.length > 0 ? { authoritative } : {}),
      ...(delegating.length > 0 ? { delegating } : {}),
    };
  }, [persona, registry, effectiveOptedIn, mcp.attachedTools]);

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
        canHostModel={deviceCompat?.tier !== 'thinclient'}
        thinClientReason={
          deviceCompat?.tier === 'thinclient' ? deviceCompat.reason : undefined
        }
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
        optedInTools={effectiveOptedIn}
        delegating={persona.delegating ?? []}
        mcp={mcp}
        compatTier={deviceCompat?.tier}
        compatReason={deviceCompat?.reason}
        baseCap={cap}
      />
    </MeshProvider>
  );
}

/**
 * Dashboard — composition of the library's panels + the demo-specific
 * `engine_run` tool registration that bridges the local LLM to the
 * tool-call surface.
 */
const THIN_CLIENT_DISMISSED_KEY = 'unstable-legion-thinclient-dismissed-v1';

function readThinClientDismissed(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(THIN_CLIENT_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}
function writeThinClientDismissed(v: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (v) localStorage.setItem(THIN_CLIENT_DISMISSED_KEY, '1');
    else localStorage.removeItem(THIN_CLIENT_DISMISSED_KEY);
  } catch {
    /* quota / privacy — silent */
  }
}

function Dashboard(props: {
  nick: string;
  modelId: string;
  mapId: string;
  onChangeNick: () => void;
  toolRegistry: ToolRegistry;
  optedInTools: readonly string[];
  delegating: readonly string[];
  mcp: UseMcpAttachmentsHandle;
  compatTier?: 'full' | 'small-only' | 'thinclient' | 'unknown';
  compatReason?: string;
  baseCap: Omit<MeshPeerCap, 'ts'> & { ts?: number };
}) {
  // Thin-client notice dismissal — persisted to localStorage so it
  // doesn't reappear on every reload on the same device.
  const [thinClientDismissed, setThinClientDismissed] = useState<boolean>(
    () => readThinClientDismissed(),
  );
  // Silent-audio keepalive — opt-in toggle that defeats browser
  // tab-throttling so this peer keeps responding when the user
  // backgrounds the tab. See useAudioKeepalive for details.
  const audioKeepalive = useAudioKeepalive();
  // DedicatedWorker hosting the WebGPU engine. Built once per Dashboard
  // mount; lives for the dashboard's lifetime. The url+import.meta.import
  // pattern lets Vite bundle the worker as a separate chunk and emit a
  // worker-classification flag at build time.
  const llmWorkerRef = useRef<Worker | null>(null);
  // `?nochat=1` (e2e / dedicated-stage-host mode) skips the chat engine
  // worker entirely — a page that only hosts pipeline stages has no use for
  // it, and every live worker in the renderer eats into the same budget the
  // stage worker's model load needs.
  const noChat = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nochat');
  if (llmWorkerRef.current === null && typeof Worker !== 'undefined' && !noChat) {
    llmWorkerRef.current = new Worker(
      new URL('./workers/llmWorker.ts', import.meta.url),
      { type: 'module' },
    );
  }
  useEffect(() => {
    return () => {
      llmWorkerRef.current?.terminate();
      llmWorkerRef.current = null;
    };
  }, []);
  const llm = useLocalLlm({
    modelId: props.modelId,
    mapId: props.mapId,
    mirror: MIRROR_CONFIG,
    worker: llmWorkerRef.current ?? undefined,
  });
  const codecMap: CodecMapHandle = useCodecMap({ family: props.mapId });
  const tools = useMeshTools({
    registry: props.toolRegistry,
    optedIn: props.optedInTools,
  });
  // Unified tool bus — what /skill, /ensemble, /maps dispatch against.
  // Surfaces local tools + remote peers' tools + skill abstractions
  // (all roster-advertised authoritative/delegating zones).
  const bus = useMeshToolBus({
    registry: props.toolRegistry,
    callTool: tools.callTool,
    optedInLocal: props.optedInTools,
  });

  // Register `route_skill` on this peer when the operator declared any
  // delegating zones. The tool gives this peer the ability to forward
  // skill queries deeper into the DNS-style tree on behalf of askers.
  const { peer } = useMeshContext();
  const rosterRef = useMeshRoster();
  const rosterSnapshotRef = useRef(rosterRef);
  useEffect(() => {
    rosterSnapshotRef.current = rosterRef;
  }, [rosterRef]);
  useEffect(() => {
    if (!peer) return;
    if (props.delegating.length === 0) return;
    registerRouteSkillTool(props.toolRegistry, {
      peer,
      rosterSnapshot: () => rosterSnapshotRef.current,
    });
    return () => {
      // No reg.unregister API needed — the tool is harmless to leave
      // registered; if the operator removes all zones later, the
      // dispatcher gates on `optedIn`. Keeping registration idempotent.
    };
  }, [peer, props.toolRegistry, props.delegating]);

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
        compatTier={props.compatTier}
        compatReason={props.compatReason}
        thinClientDismissed={thinClientDismissed}
        onDismissThinClient={() => {
          setThinClientDismissed(true);
          writeThinClientDismissed(true);
        }}
      />
      <McpStatusRow
        mcp={props.mcp}
        emptyMessage="no MCP endpoints attached. add via the persona form (change nick → MCP list)."
      />
      <AudioKeepaliveToggle handle={audioKeepalive} />
      <StagePipelinePanel baseCap={props.baseCap} keepaliveEnabled={audioKeepalive.enabled} />
      <CommunalHostPanel baseCap={props.baseCap} keepaliveEnabled={audioKeepalive.enabled} />
      <div className="ul-cols">
        <MeshRosterPanel />
        <MeshChatPanel
          llm={llm}
          map={codecMap.map}
          mapError={codecMap.error}
          tools={tools}
          bus={bus}
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
