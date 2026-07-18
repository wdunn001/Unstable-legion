/**
 * App — the chat product's top-level composition. Reuses the proven
 * mesh runtime verbatim (`useCommunalChat`/`useCommunalHost`/
 * `buildCommunalTopology`/`StandingLedger` — all @unstable-legion/{core,
 * react}, all already proven end-to-end in apps/demo's communal.spec.ts)
 * and wires it to this app's own OWUI-style shell: a conversation-list
 * sidebar (IndexedDB-backed, `useThreads`), a streaming chat pane, and a
 * mesh sidebar (capacity/topology/standing/leaderboard).
 *
 * Deliberately does NOT reuse `PersonaForm`/`MeshChatPanel`/
 * `useMeshTools`/MCP — this product has one fixed model
 * (`chatModelSource.ts`) and no legacy tool-calling surface; the join
 * flow is this app's own lightweight `JoinScreen`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { joinRoom, defaultRelayUrls, selfId } from '@trystero-p2p/mqtt';
import {
  MeshProvider,
  StandingLedger,
  bindPriorityScore,
  isThinDriverForModel,
  mergeRelayUrls,
  sanitizeWeightBudget,
  useAudioKeepalive,
  useCommunalChat,
  useCommunalHost,
  useLocalStageServe,
  useMeshContext,
  useMeshRoster,
  useMeshTools,
  usePersona,
  type MeshPeerCap,
  type MeshProviderProps,
} from '@unstable-legion/react';
import {
  buildCommunalTopology,
  findPeersByTool,
  firstToolCall,
  newCallId,
  runToolRoundTrip,
  type JoinRoomFn,
} from '@unstable-legion/core';
import { JoinScreen } from './components/JoinScreen.js';
import { ConversationList } from './components/ConversationList.js';
import { ChatPane } from './components/ChatPane.js';
import { MeshSidebar } from './components/MeshSidebar.js';
import { ModelChannelPicker } from './components/ModelChannelPicker.js';
import type { HopConnType } from './components/PipelineHandoff.js';
import { TrustBadge } from './components/TrustBadge.js';
import { TrustInterstitial } from './components/TrustInterstitial.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { useThreads } from './hooks/useThreads.js';
import { useHostingConsent } from './hooks/useHostingConsent.js';
import { useModelFolder } from './hooks/useModelFolder.js';
import { useToolContribution, type UseToolContributionHandle } from './hooks/useToolContribution.js';
import { MAX_TOOL_ROUNDS, buildToolResponsePayload, collectMeshTools, stripToolMarkup } from './toolChat.js';
import { useGpuDetection } from './hooks/useGpuDetection.js';
import { useModelCapability } from './hooks/useModelCapability.js';
import { useTheme, type UseThemeHandle } from './hooks/useTheme.js';
import { resolveChatModelConfig } from './chatModelSource.js';
import { formatVramLabel } from './gpuCatalog.js';
import { buildPrompt } from './chatPrompt.js';
import {
  deriveCapacityView,
  deriveCrewScale,
  deriveChatNotice,
  deriveLeaderboard,
  deriveStandingView,
  deriveTopologySegments,
  nickLookup,
} from './viewmodels/meshViewModels.js';
import { createTelemetry, telemetryConfigFromEnv } from './telemetry.js';
import {
  ACK_PENDING_ROUTE,
  hostSetKey,
  loadAckedHostSetKey,
  needsTrustAck,
  remoteHostPeerIds,
  saveAckedHostSetKey,
  type AckedHostKey,
} from './trustStatement.js';

// `?room=` e2e/isolation override — same idiom as apps/demo's App.tsx.
const ROOM_ID =
  (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('room') : null) ?? 'legion-chat';

// Self-hosted MQTT-over-WSS signaling relay, PREPENDED so peer discovery/SDP
// exchange doesn't depend on flaky/overloaded public MQTT brokers (those
// stalled discovery outright — peers never exchanged offers, which reads as
// "nobody is here" rather than an error). Set VITE_RELAY_URLS to your own;
// the public defaults remain only as a last-resort fallback.
const SELF_RELAY_URLS = (import.meta.env.VITE_RELAY_URLS ?? 'wss://signal.quasarke.net/mqtt')
  .split(/[\s,]+/)
  .filter(Boolean);

const RELAY_URLS = mergeRelayUrls({
  defaults: defaultRelayUrls,
  extras: SELF_RELAY_URLS,
  blockedHosts: ['test.mosquitto.org', 'broker-cn.emqx.io'],
  max: 6,
});
// Build-time TURN/STUN config — see apps/chat/Dockerfile.
const TURN_URLS_RAW = import.meta.env.VITE_TURN_URLS ?? '';
const TURN_USERNAME = import.meta.env.VITE_TURN_USERNAME || undefined;
const TURN_CREDENTIAL = import.meta.env.VITE_TURN_CREDENTIAL || undefined;
const TURN_EXTRAS = TURN_URLS_RAW
  ? TURN_URLS_RAW.split(/[\s,]+/)
      .filter(Boolean)
      .map((url) => ({
        urls: url,
        ...(TURN_USERNAME ? { username: TURN_USERNAME } : {}),
        ...(TURN_CREDENTIAL ? { credential: TURN_CREDENTIAL } : {}),
      }))
  : [];

// SELF-HOSTED-ONLY ICE. `rtcConfig.iceServers` REPLACES trystero's built-in
// public STUN list (Google + Cloudflare) — trystero spreads rtcConfig last.
// Point this at your OWN coturn, ideally off-ISP: a relay with a different
// public IP than the home network is reachable from a co-located desktop
// WITHOUT router hairpin (hairpin is what broke a LAN-hosted STUN), and from
// remote peers too. Prefer an IP literal in VITE_TURN_URLS so there's no DNS
// lookup at gather time — that also sidesteps networks that intercept port 53
// (which shows up as a `701 STUN host lookup` flood). coturn answers STUN on
// the same host:port as TURN, so the STUN url is derived from each `turn:`
// url. Zero third-party servers.
const SELF_STUN_URLS = [
  ...new Set(TURN_EXTRAS.map((e) => e.urls).filter((u) => u.startsWith('turn:')).map((u) => `stun:${u.slice(5).split('?')[0]}`)),
];
const ICE_SERVERS = [...SELF_STUN_URLS.map((urls) => ({ urls })), ...TURN_EXTRAS];

const TRYSTERO_CONFIG: MeshProviderProps['trysteroConfig'] = {
  appId: 'unstable-legion-chat-v1',
  relayConfig: { urls: RELAY_URLS },
  rtcConfig: { iceServers: ICE_SERVERS },
};

const PERSONA_STORAGE_KEY = 'unstable-legion-chat-persona-v1';

// Generation budget. maxDecodeTokens is a CAP, not a target — short answers
// stop at EOS well before it, so raising it only lets LONG answers (code, etc.)
// run further; it doesn't slow short chats. Was 256, which truncated real
// answers and forced a "continue" that then overran the context. The prompt is
// trimmed to `ctxSize - MAX_DECODE_TOKENS - margin` so prompt+generation can't
// exceed the KV window (an overflow traps the stage-runtime wasm mid-decode).
const MAX_DECODE_TOKENS = 1024;
const PROMPT_TOKEN_MARGIN = 128;

export function App() {
  const { persona, update: updatePersona } = usePersona(PERSONA_STORAGE_KEY);
  const [joined, setJoined] = useState(false);
  const modelConfig = useMemo(() => resolveChatModelConfig(), []);
  // Applies to every screen (join or joined) — the theme toggle needs to
  // work before a nick is even chosen, not just once inside the Dashboard.
  const theme = useTheme();
  // TOOL-NODES: registry + opt-ins live ABOVE MeshProvider because the
  // advertised descriptor list is part of the cap — the provider
  // re-broadcasts on cap change, so toggling a tool propagates live.
  const toolContribution = useToolContribution();

  const cap: (Omit<MeshPeerCap, 'ts'> & { ts?: number }) | null = useMemo(() => {
    if (!persona.nick) return null;
    return {
      v: 1,
      nick: persona.nick,
      modelId: modelConfig.modelId,
      available: true,
      skills: [],
      systemPromptSummary: 'Unstable Legion communal chat client',
      tools: [...toolContribution.descriptors],
    };
  }, [persona.nick, modelConfig.modelId, toolContribution.descriptors]);

  if (!joined || !cap) {
    return (
      <>
        <div className="theme-toggle-standalone">
          <ThemeToggle theme={theme.theme} onToggle={theme.toggle} />
        </div>
        <JoinScreen
          initialNick={persona.nick}
          onJoin={(nick) => {
            updatePersona({ nick });
            setJoined(true);
          }}
        />
      </>
    );
  }

  return (
    <MeshProvider
      /* Pre-existing type mismatch between @trystero-p2p's own JoinRoomConfig
       * (requires a statically-known `appId`) and mesh-core's looser
       * JoinRoomFn (config: Record<string, unknown>) — unrelated to the
       * wireDtype/i8 work in this pass; TRYSTERO_CONFIG always supplies
       * `appId` at runtime, so this cast changes no behavior. */
      joinRoom={joinRoom as unknown as JoinRoomFn}
      selfId={selfId}
      trysteroConfig={TRYSTERO_CONFIG}
      roomId={ROOM_ID}
      cap={cap}
    >
      <Dashboard
        nick={persona.nick}
        onChangeNick={() => setJoined(false)}
        baseCap={cap}
        modelConfig={modelConfig}
        theme={theme}
        toolContribution={toolContribution}
      />
    </MeshProvider>
  );
}

function Dashboard(props: {
  nick: string;
  onChangeNick: () => void;
  baseCap: Omit<MeshPeerCap, 'ts'> & { ts?: number };
  modelConfig: ReturnType<typeof resolveChatModelConfig>;
  theme: UseThemeHandle;
  toolContribution: UseToolContributionHandle;
}) {
  const { modelConfig } = props;
  const { peer } = useMeshContext();
  const roster = useMeshRoster();

  // Trim the assembled prompt to leave room for the model's own generation
  // within the KV window — see MAX_DECODE_TOKENS. Floored so a small ctx never
  // yields an absurdly tiny (or negative) budget.
  const maxPromptTokens = Math.max(512, modelConfig.ctxSize - MAX_DECODE_TOKENS - PROMPT_TOKEN_MARGIN);

  // One contribution-economy ledger per Dashboard mount (== per
  // MeshProvider subtree) — same "one ledger, shared across every role"
  // convention as apps/demo's App.tsx.
  const standingLedgerRef = useRef<StandingLedger | null>(null);
  if (standingLedgerRef.current === null) standingLedgerRef.current = new StandingLedger();
  const standingLedger = standingLedgerRef.current;
  const priorityScore = useMemo(() => bindPriorityScore(standingLedger, () => Date.now()), [standingLedger]);

  // One OpenPanel telemetry handle per Dashboard mount — the ONLY analytics
  // stack (self-hosted). A hard no-op unless VITE_OPENPANEL_CLIENT_ID
  // is set at build time, so the app never depends on analytics being up.
  const telemetryRef = useRef<ReturnType<typeof createTelemetry> | null>(null);
  if (telemetryRef.current === null) telemetryRef.current = createTelemetry(telemetryConfigFromEnv(import.meta.env));
  const telemetry = telemetryRef.current;
  const trackEvent = useCallback((event: Parameters<typeof telemetry.trackEvent>[0]) => telemetry.trackEvent(event), [telemetry]);

  const createStageWorker = useCallback(
    () => new Worker(new URL('./workers/stageWorker.ts', import.meta.url), { type: 'module' }),
    [],
  );
  const log = useCallback((line: string) => console.info('[chat]', line), []);

  // Periodic re-render so standing/leaderboard/priority (all functions
  // of "now") stay visually fresh even with no roster/chat churn.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 2000);
    return () => clearInterval(id);
  }, []);

  const audioKeepalive = useAudioKeepalive();
  const hostingConsent = useHostingConsent();
  // LOCAL-MODEL-FOLDER — "Load layers from a local folder" (see
  // ModelFolderPanel / useModelFolder.ts). `handle` feeds BOTH this
  // driver's own stage-0 load (`chat` below) and this peer's communal
  // hosting load (`communal` below) — a picked folder benefits either
  // role, independent of the hosting-consent decision.
  const modelFolder = useModelFolder();
  // Session-local live on/off — distinct from the persisted `consent`
  // decision (see useHostingConsent's doc comment: "leaving" for this
  // session shouldn't erase a standing "yes").
  const [hostingEnabled, setHostingEnabled] = useState(hostingConsent.consent === 'accepted');
  useEffect(() => {
    setHostingEnabled(hostingConsent.consent === 'accepted');
  }, [hostingConsent.consent]);

  // Independent local probe for the "Contribute more" panel's detected-GPU
  // pre-selection + live capacity math — deliberately NOT the same probe
  // `useCommunalHost` runs internally (that one only starts once hosting
  // is actually enabled; this one needs to be available before that, and
  // apps/chat wants the GPU NAME, which `useCommunalHost` never surfaces).
  const gpuDetection = useGpuDetection();

  // OPTIONAL-STAGE0 Phase 2 — per-model (not flat-128MB) thin/text-relay
  // classification: this channel's manifest-derived stage-0 storage-buffer
  // requirement, weighed against THIS device's adapter limit. `undefined`
  // while the very first manifest resolution is in flight — treated as
  // "not yet decided, assume capable" so a fast desktop's first render
  // isn't spuriously flagged thin; `chat.start()` only runs on user
  // interaction, well after both probes resolve in practice.
  const modelCapability = useModelCapability(modelConfig.manifestUrl);
  const isThinDevice =
    modelCapability.requiredStorageBufferBytes !== undefined &&
    isThinDriverForModel(gpuDetection, modelCapability.requiredStorageBufferBytes);

  // OPTIONAL-STAGE0 Phase 2 — a device that fails the per-model capability
  // check (`isThinDevice`) routes text-relay: no local stage-0 worker AND no
  // local tokenizer worker (none is constructed anywhere in this component —
  // `thinTokenizer` is deliberately never wired here). A capable device
  // (the common case, `isThinDevice: false`) gets `thinDriver: false,
  // textRelay: false` — byte-for-byte today's behavior, since those are
  // `useCommunalChat`'s own defaults.
  const chat = useCommunalChat({
    peer,
    createStageWorker,
    modelId: modelConfig.modelId,
    totalLayers: modelConfig.totalLayers,
    driverLayers: modelConfig.driverLayers,
    manifestUrl: modelConfig.manifestUrl,
    localFolderHandle: modelFolder.handle,
    nEmbd: modelConfig.nEmbd,
    ctxSize: modelConfig.ctxSize,
    wireDtype: modelConfig.wireDtype,
    thinDriver: isThinDevice,
    textRelay: isThinDevice,
    // REUSE-STAGE0 — opt-in (see ContributionPanel's "Serve the first
    // stage" toggle / useHostingConsent's serveFirstStage). Only meaningful
    // for a CAPABLE device (isThinDevice: false already implies no local
    // stage-0 worker exists to serve from); off by default, byte-identical
    // to today's per-turn load+dispose when unset.
    serveFirstStage: hostingConsent.serveFirstStage,
    priorityScore,
    standingLedger,
    telemetry: trackEvent,
    log,
  });

  // REUSE-STAGE0 — serve `chat`'s resident stage-0 worker (when
  // `serveFirstStage` loaded one) to thin/text-relay clients as an isFirst
  // communal stage. Gated the same way (`hostingConsent.serveFirstStage`);
  // this hook itself no-ops (no engine, no wire subscriptions) whenever the
  // resident worker hasn't loaded yet or the toggle is off.
  const localServe = useLocalStageServe({
    // PAUSE while a remembered local folder is awaiting a re-grant click: a
    // reload drops the folder's read permission, and without this the serve/
    // host loads would silently DOWNLOAD the whole model instead of reading
    // from the folder the user picked. Resolving the folder (re-grant, or
    // "download instead") clears needsPermission and resumes. See
    // useModelFolder.ts + ModelFolderPanel.
    enabled: hostingConsent.serveFirstStage && !modelFolder.needsPermission,
    peer,
    residentStageZeroRef: chat.residentStageZeroRef,
    priorityScore,
    standingLedger,
    log,
  });

  const communal = useCommunalHost({
    // Paused while a remembered local folder awaits a re-grant click — see the
    // localServe `enabled` comment above (don't silently download the whole
    // body stage when the user meant to load it from their folder).
    enabled: hostingEnabled && !modelFolder.needsPermission,
    peer,
    baseCap: props.baseCap,
    createStageWorker,
    // The dead-end `supportThinDrivers` path (a SEPARATE isFirst communal
    // claim spun up by this hook's own assembly loop) stays off — it hit
    // `missing token_embd.weight` (this model ties input/output embeddings;
    // the fragment resolver doesn't include them unless the stage is also
    // isFirst) and is superseded by REUSE-STAGE0 above: `localServe` reuses
    // the driver's own ALREADY-loaded, ALREADY-embeddings-including
    // `[0, driverLayers)` worker instead of loading a second one.
    supportThinDrivers: false,
    modelId: modelConfig.modelId,
    totalLayers: modelConfig.totalLayers,
    driverLayers: modelConfig.driverLayers,
    ctxSize: modelConfig.ctxSize,
    wireDtype: modelConfig.wireDtype,
    manifestUrl: modelConfig.manifestUrl,
    localFolderHandle: modelFolder.handle,
    fallbackShardUrls: modelConfig.shardUrls,
    avgLayerBytes: modelConfig.avgLayerBytes,
    keepaliveEnabled: audioKeepalive.enabled,
    priorityScore,
    standingLedger,
    telemetry: trackEvent,
    contributionBudgetBytes: hostingConsent.contributionBudgetBytes,
    maxLayersOverride: hostingConsent.maxLayersOverride,
    // REUSE-STAGE0 — union `localServe`'s own [0,driverLayers) ad into
    // THIS hook's cap.stageHost.loadedStages publish (see
    // `extraLoadedStages`'s doc comment for why this must be the ONE
    // `peer.setCap` call site rather than two independent callers).
    extraLoadedStages: localServe.loadedStageEntry ? [localServe.loadedStageEntry] : undefined,
    log,
  });

  // ── "Contribute more" live capacity math ────────────────────────────
  // Same formula `useCommunalHost` itself uses for claim-sizing
  // (`sanitizeWeightBudget`), so the UI never promises a number the host
  // loop wouldn't actually claim. Falls back to the safe default
  // (`maxStorageBufferBindingSize: 0` -> `sanitizeWeightBudget` treats
  // that as "unknown", same fallback path as a bad/zero adapter limit)
  // before `gpuDetection` resolves, so the panel shows a sane number
  // (~11 layers) immediately instead of a blank/zero flash.
  const weightBudgetBytes = useMemo(
    () =>
      sanitizeWeightBudget(
        {
          maxStorageBufferBindingSize: gpuDetection.limits?.maxStorageBufferBindingSize ?? 0,
          contributionBudgetBytes: hostingConsent.contributionBudgetBytes,
        },
        { minBytes: modelConfig.avgLayerBytes },
      ),
    [gpuDetection.limits?.maxStorageBufferBindingSize, hostingConsent.contributionBudgetBytes, modelConfig.avgLayerBytes],
  );
  const communalLayerCount = Math.max(0, modelConfig.totalLayers - modelConfig.driverLayers);
  const byteBudgetLayersHosted = Math.max(0, Math.min(communalLayerCount, Math.floor(weightBudgetBytes / modelConfig.avgLayerBytes)));
  // "Layers to host: N of 34" REPLACES the byte-budget-derived count when
  // set — mirrors `useCommunalHost.ts`'s own `selfCapacityLayers` derivation
  // exactly, so this label never promises a number the host loop wouldn't
  // actually claim (same discipline `weightBudgetBytes` above already follows
  // for the GB-budget path).
  const layersHosted =
    hostingConsent.maxLayersOverride !== undefined
      ? Math.max(0, Math.min(communalLayerCount, hostingConsent.maxLayersOverride))
      : byteBudgetLayersHosted;
  // GB readout follows WHICHEVER budget is actually in effect — once a
  // layers override is set it no longer tracks `weightBudgetBytes` (the
  // GB-budget path), so re-derive it from the effective layer count
  // instead of showing a stale/mismatched GB figure.
  const effectiveApproxBytes =
    hostingConsent.maxLayersOverride !== undefined ? layersHosted * modelConfig.avgLayerBytes : weightBudgetBytes;
  const capacitySummaryLabel = `Hosting up to ${layersHosted} of ${communalLayerCount} layers (~${formatVramLabel(effectiveApproxBytes)})`;

  // ── Pipeline-handoff connection-type polling ────────────────────────
  // `peer.peerConnectionType` is best-effort/optional (mesh-core's Peer
  // interface — see peer.ts) and only meaningful for the CURRENT route's
  // remote hops. Poll gently (every 4s, matching the sidebar's own 2s
  // "stay fresh" tick's order of magnitude but slower — this hits
  // getStats() per hop, not free) and stop entirely once there's no plan
  // or no remote hop to ask about. Connection type can change mid-session
  // (ICE renegotiation), so a one-shot read on planCreated isn't enough.
  const [hopConnTypes, setHopConnTypes] = useState<Readonly<Record<string, HopConnType>>>({});
  useEffect(() => {
    const remoteHopPeerIds = chat.plan ? chat.plan.stages.filter((s) => s.stageIndex > 0).map((s) => s.peerId) : [];
    if (!peer || remoteHopPeerIds.length === 0) {
      setHopConnTypes({});
      return;
    }
    let cancelled = false;
    const poll = () => {
      for (const peerId of remoteHopPeerIds) {
        if (typeof peer.peerConnectionType !== 'function') continue;
        void peer.peerConnectionType(peerId).then((type) => {
          if (cancelled) return;
          setHopConnTypes((prev) => (prev[peerId] === type ? prev : { ...prev, [peerId]: type }));
        });
      }
    };
    poll();
    const id = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [peer, chat.plan]);

  const threads = useThreads();

  // ── TOOL-NODES wiring ─────────────────────────────────────────────
  // Serve inbound tool calls this tab opted in to (docs/TOOL-NODES.md).
  const { toolContribution } = props;
  useMeshTools({ registry: toolContribution.registry, optedIn: toolContribution.optedIn });
  // Tools the MODEL may call: the union advertised across the live
  // roster (self included — a solo tab can consume its own contribution).
  const meshTools = useMemo(() => collectMeshTools(roster), [roster]);

  // ── Mesh sidebar view-models ──────────────────────────────────────
  const topology = useMemo(
    () =>
      buildCommunalTopology(roster, {
        modelId: modelConfig.modelId,
        totalLayers: modelConfig.totalLayers,
        driverLayers: modelConfig.driverLayers,
      }),
    [roster, modelConfig],
  );
  const capacity = useMemo(() => deriveCapacityView(topology, modelConfig.modelLabel), [topology, modelConfig.modelLabel]);
  const nickOf = useMemo(() => nickLookup(roster), [roster]);
  const selfId2 = peer?.selfId ?? '';
  const segments = useMemo(
    () => deriveTopologySegments(topology, { selfId: selfId2, nickOf }),
    [topology, selfId2, nickOf],
  );
  const crewScale = useMemo(() => deriveCrewScale(topology), [topology]);
  const now = Date.now();
  const topStandings = useMemo(() => standingLedger.topContributors(20, now), [standingLedger, now]);
  const standingView = useMemo(
    () => deriveStandingView(standingLedger, selfId2, now, topStandings, communal.claim),
    [standingLedger, selfId2, now, topStandings, communal.claim],
  );
  const leaderboard = useMemo(
    () => deriveLeaderboard(topStandings.slice(0, 10), { selfId: selfId2, nickOf }),
    [topStandings, selfId2, nickOf],
  );

  // ── communal_coverage telemetry — fire only when the coverage picture
  // actually CHANGES (deduped), not every 2s re-render. Whole-mesh metric
  // (coverage %, seats, distinct host count), no PII. ───────────────────
  const coverageKeyRef = useRef<string>('');
  useEffect(() => {
    const hostCount = new Set(topology.segments.map((s) => s.candidates[0]?.peerId).filter(Boolean)).size;
    const key = `${capacity.coveragePercent}|${topology.seats}|${hostCount}`;
    if (key === coverageKeyRef.current) return;
    coverageKeyRef.current = key;
    telemetry.trackEvent({
      name: 'communal_coverage',
      props: { coveragePct: capacity.coveragePercent, seats: topology.seats, hostCount },
    });
  }, [topology, capacity.coveragePercent, telemetry]);

  // ── Driver-side chat notice — honest failure/reconnect copy, never a
  // silent hang (see deriveChatNotice). ────────────────────────────────
  const chatNotice = useMemo(
    () => deriveChatNotice(chat.status, chat.restartCount, capacity, isThinDevice),
    [chat.status, chat.restartCount, capacity, isThinDevice],
  );

  // ── Trust gate ─────────────────────────────────────────────────────
  const [ackedHostKey, setAckedHostKey] = useState<AckedHostKey>(() => loadAckedHostSetKey());
  const [trustModal, setTrustModal] = useState<{ pendingText: string } | null>(null);
  const currentPlanHostKey = chat.plan ? hostSetKey(remoteHostPeerIds(chat.plan)) : undefined;

  useEffect(() => {
    if (ackedHostKey === ACK_PENDING_ROUTE && currentPlanHostKey) {
      setAckedHostKey(currentPlanHostKey);
      saveAckedHostSetKey(currentPlanHostKey);
    }
  }, [ackedHostKey, currentPlanHostKey]);

  // ── Streaming wiring ───────────────────────────────────────────────
  const [streamingMessageId, setStreamingMessageId] = useState<string | undefined>(undefined);

  // TOOL-NODES: per-exchange multi-round state. One "exchange" = one user
  // message; each round is generate → (tool call detected) → mesh
  // round-trip → re-prefill-and-continue via a fresh chat.start() carrying
  // the completed rounds (see chatPrompt's `rounds`). Ref, not state — the
  // status effect below mutates it mid-flight without re-render churn.
  const exchangeRef = useRef<{
    userText: string;
    baseMessages: readonly import('./db/threadStore.js').ChatMessage[];
    rounds: { assistantText: string; toolResponse: string }[];
    assistantId: string;
    trace: string[];
    toolLoopBusy: boolean;
    cancelled: boolean;
  } | null>(null);

  const doSend = useCallback(
    (text: string) => {
      const baseMessages = threads.activeThread?.messages ?? [];
      const prompt = buildPrompt(baseMessages, text, { tools: meshTools, maxPromptTokens });
      threads.appendMessage('user', text);
      const assistantId = threads.appendMessage('assistant', '');
      exchangeRef.current = {
        userText: text,
        baseMessages,
        rounds: [],
        assistantId,
        trace: [],
        toolLoopBusy: false,
        cancelled: false,
      };
      setStreamingMessageId(assistantId);
      void chat.start(prompt, { maxDecodeTokens: MAX_DECODE_TOKENS });
    },
    [threads, chat, meshTools, maxPromptTokens],
  );

  useEffect(() => {
    if (!streamingMessageId) return;
    threads.updateMessageContent(streamingMessageId, stripToolMarkup(chat.text));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.text, streamingMessageId]);

  /** One tool round: route the call (mesh peer, or self-serve when this
   * tab is the only advertiser), fold the response, resume generation. */
  const runToolRound = useCallback(
    async (call: { name: string; args: Readonly<Record<string, unknown>>; raw: string }, assistantText: string) => {
      const ex = exchangeRef.current;
      if (!ex || !peer) return;
      const traceIdx = ex.trace.push(`${call.name} → calling…`) - 1;
      threads.setMessageToolTrace(ex.assistantId, ex.trace);
      try {
        const rosterSnapshot = peer.roster.snapshot();
        const remoteProviders = findPeersByTool(rosterSnapshot, call.name, { excludePeerId: peer.selfId });
        let payload: string;
        if (remoteProviders.length > 0) {
          const rt = await runToolRoundTrip({
            peer,
            roster: rosterSnapshot,
            call: { name: call.name, args: call.args },
            timeoutMs: 20_000,
            priorityScore,
            standingLedger,
            });
          payload = buildToolResponsePayload(call.name, rt.result, rt.error);
          const nick = rt.providerPeerId ? (nickOf(rt.providerPeerId) ?? rt.providerPeerId.slice(0, 6)) : undefined;
          ex.trace[traceIdx] = `${call.name} → ${rt.status}${nick ? ` · served by @${nick}` : ''}`;
          telemetry.trackEvent({ name: 'tool_round_trip', props: { tool: call.name, status: rt.status, tried: rt.triedPeerIds.length } });
        } else if (toolContribution.optedIn.includes(call.name)) {
          // Self-serve: no other peer advertises it but this tab does —
          // dispatch locally through the same registry the mesh path uses.
          const result = await toolContribution.registry.dispatch(
            { v: 1, ts: Date.now(), callId: newCallId(), toolName: call.name, args: call.args },
            toolContribution.optedIn,
          );
          payload = buildToolResponsePayload(call.name, result);
          ex.trace[traceIdx] = `${call.name} → ${result.status} · served locally`;
          telemetry.trackEvent({ name: 'tool_round_trip', props: { tool: call.name, status: result.status, tried: 0 } });
        } else {
          payload = buildToolResponsePayload(call.name, undefined, `no peer currently advertises tool "${call.name}"`);
          ex.trace[traceIdx] = `${call.name} → no provider`;
        }
        threads.setMessageToolTrace(ex.assistantId, ex.trace);
        ex.rounds.push({ assistantText, toolResponse: payload });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        ex.trace[traceIdx] = `${call.name} → error`;
        threads.setMessageToolTrace(ex.assistantId, ex.trace);
        ex.rounds.push({ assistantText, toolResponse: buildToolResponsePayload(call.name, undefined, reason) });
      }
      // NOTE: ex.toolLoopBusy stays TRUE here — through the resume wait and
      // the chat.start() below — and is released by the status effect only
      // once the NEW session's phase lands. Releasing it any earlier
      // re-opens the door for the effect (which re-runs on every render)
      // to re-detect the SAME finished-text tool call and serve it again:
      // the live-test symptom was one call served 3× (burning the whole
      // round budget) while the first resume was still waiting.
      if (ex.cancelled) {
        finalizeExchange();
        return;
      }
      // RESUME RACE: `status` flips to finished BEFORE the previous
      // session's teardown clears the run guard (see isRunning's doc in
      // useCommunalChat) — a start() fired straight from the status effect
      // is silently refused and the reply would stay blank forever (first
      // live-test symptom of this loop). Wait out the teardown, bounded.
      const prompt = buildPrompt(ex.baseMessages, ex.userText, { tools: meshTools, rounds: ex.rounds, maxPromptTokens });
      const deadline = Date.now() + 15_000;
      while (chat.isRunning() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
      }
      if (ex.cancelled || exchangeRef.current !== ex) {
        if (exchangeRef.current === ex) finalizeExchange();
        return;
      }
      if (chat.isRunning()) {
        ex.trace.push('tool loop: could not resume generation (session never released)');
        threads.setMessageToolTrace(ex.assistantId, ex.trace);
        finalizeExchange();
        return;
      }
      void chat.start(prompt, { maxDecodeTokens: MAX_DECODE_TOKENS });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [peer, threads, chat, meshTools, priorityScore, standingLedger, toolContribution, telemetry, maxPromptTokens],
  );

  const finalizeExchange = useCallback(() => {
    const ex = exchangeRef.current;
    if (ex) {
      threads.updateMessageContent(ex.assistantId, stripToolMarkup(chat.text));
      if (ex.trace.length > 0) threads.setMessageToolTrace(ex.assistantId, ex.trace);
      // Decode-speed badge (tok/s) — only when the generation was long
      // enough to measure an inter-token rate (see ChatGenTiming).
      if (chat.lastTiming?.tokPerSec !== undefined) {
        threads.setMessageTokPerSec(ex.assistantId, chat.lastTiming.tokPerSec);
      }
    }
    if (streamingMessageId && chat.restartCount > 0) threads.markReconnected(streamingMessageId);
    void threads.flushActiveThread();
    exchangeRef.current = null;
    setStreamingMessageId(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, chat.text, chat.restartCount, chat.lastTiming, streamingMessageId]);

  useEffect(() => {
    if (!streamingMessageId) return;
    const ex = exchangeRef.current;
    const phase = chat.status.phase;
    // A non-terminal phase means the resumed session is genuinely underway
    // — THIS is where a round's busy flag releases (see runToolRound's
    // trailing note), so the next 'finished' can start the next round.
    if (phase === 'planning' || phase === 'starting' || phase === 'running') {
      if (ex?.toolLoopBusy) ex.toolLoopBusy = false;
      return;
    }
    // Abort/error finalizes even mid-round: runToolRound's own post-wait
    // guards (`exchangeRef.current !== ex`) make it bail out cleanly after
    // this clears the exchange, so there's no double-finalize.
    if (phase === 'aborted' || phase === 'error') {
      finalizeExchange();
      return;
    }
    if (ex?.toolLoopBusy) return; // a round-trip/resume owns the lifecycle right now
    if (chat.status.phase === 'finished') {
      // Tool round? Only when the mesh (or self) can actually serve it,
      // the round budget isn't spent, and the user hasn't stopped us.
      const call = ex && !ex.cancelled && ex.rounds.length < MAX_TOOL_ROUNDS ? firstToolCall(chat.text) : null;
      if (call && ex) {
        ex.toolLoopBusy = true;
        void runToolRound(call, chat.text);
        return;
      }
      // TEXT-SETTLE RACE: `chat.text` comes from an ASYNC detokenize that
      // lands AFTER status flips to finished — finalizing on first look
      // ran before a trailing <tool_call> block was complete, silently
      // skipping the round (live-test symptom #2 of this loop: blank
      // reply, no trace chip). Finalize only after the text has been
      // stable for a beat; any text update re-runs this effect, clears
      // the timer via cleanup, and re-checks for a tool call above.
      const timer = setTimeout(() => finalizeExchange(), 400);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.status, chat.text, streamingMessageId, runToolRound, finalizeExchange]);

  function handleSend(text: string) {
    if (needsTrustAck(ackedHostKey, currentPlanHostKey)) {
      setTrustModal({ pendingText: text });
      return;
    }
    doSend(text);
  }

  function handleAcknowledge() {
    const key = currentPlanHostKey ?? ACK_PENDING_ROUTE;
    setAckedHostKey(key);
    if (key !== ACK_PENDING_ROUTE) saveAckedHostSetKey(key);
    const pending = trustModal?.pendingText;
    setTrustModal(null);
    if (pending) doSend(pending);
  }

  const busy = chat.status.phase === 'planning' || chat.status.phase === 'starting' || chat.status.phase === 'running';
  const remoteCount = peer ? roster.filter((r) => r.peerId !== peer.selfId).length : 0;
  // ICE observability (mesh-core's iceDiagnostics, installed by joinMesh):
  // distinguishes "nobody else is here" from "someone is TRYING to reach us
  // and ICE can't complete" — the silent face of a broken TURN path. Read
  // fresh each render; the 2s dashboard tick keeps it live.
  const iceSummary = (globalThis as { __legionIce?: { snapshot: () => { connecting: number; failed: number; lastError?: string } } })
    .__legionIce?.snapshot();
  const iceConnecting = remoteCount === 0 && (iceSummary?.connecting ?? 0) > 0 ? iceSummary!.connecting : 0;

  useEffect(() => {
    (window as unknown as { __legionChat?: unknown }).__legionChat = {
      selfId: peer?.selfId,
      capacityPercent: capacity.coveragePercent,
      capacityReady: capacity.ready,
      chatStatus: chat.status,
      chatText: chat.text,
      // Raw generated token-id sequence (prompt tokens excluded — see
      // useCommunalChat.ts's `tokens` state doc) — exposed for the
      // wire-dtype A/B exactness e2e (wire-dtype.spec.ts), which needs the
      // exact greedy-decode token stream, not just its detokenized text
      // (two runs can render identical text from different byte-level
      // rounding if detokenization ever normalizes whitespace/casing).
      chatTokens: chat.tokens,
      chatRestartCount: chat.restartCount,
      threadCount: threads.threads.length,
      activeThreadId: threads.activeThreadId,
      trustModalOpen: trustModal !== null,
      hostingConsent: hostingConsent.consent,
      hostingActive: communal.active,
      hostingPhase: communal.phase,
      hostingError: communal.errorMessage,
      hostingRetrying: communal.retrying,
      hostingRetryAttempt: communal.retryAttempt,
      chatNotice: chatNotice?.message,
      telemetryEnabled: telemetry.enabled,
      remoteCount,
      ice: iceSummary,
    };
  }, [
    peer,
    capacity,
    chat.status,
    chat.text,
    chat.tokens,
    chat.restartCount,
    threads.threads,
    threads.activeThreadId,
    trustModal,
    hostingConsent.consent,
    communal.active,
    communal.phase,
    communal.errorMessage,
    communal.retrying,
    communal.retryAttempt,
    chatNotice,
    telemetry,
  ]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-brand">Unstable Legion</span>
        <span className="app-header-sep">·</span>
        {/* Product requirement: the model this mesh is assembling/serving
         * is always named, never buried behind a status number — read
         * from chatModelSource.ts's single source of truth, not hardcoded
         * here. Now also the channel switcher (each channel = its own mesh). */}
        <ModelChannelPicker
          currentModelId={modelConfig.modelId}
          currentLabel={modelConfig.modelLabel}
          isTestModel={modelConfig.isTestModel}
        />
        <span className="app-header-sep">·</span>
        <span className="app-nick">@{props.nick}</span>
        <span className="app-header-sep">·</span>
        <span
          className={`app-mesh-pill ${remoteCount > 0 ? 'app-mesh-ok' : 'app-mesh-cold'}`}
          title={iceConnecting > 0 ? 'A peer is trying to connect but WebRTC has not completed — often a TURN/firewall issue.' : undefined}
        >
          {iceConnecting > 0 ? `mesh: connecting (${iceConnecting})…` : `mesh: ${remoteCount} remote`}
        </span>
        <span className="app-header-spacer" />
        <TrustBadge />
        <ThemeToggle theme={props.theme.theme} onToggle={props.theme.toggle} />
        <button type="button" className="btn-link app-change-nick" onClick={props.onChangeNick}>
          change nick
        </button>
      </header>
      <div className="app-body">
        <aside className="conversation-sidebar">
          <ConversationList
            threads={threads.threads}
            activeThreadId={threads.activeThreadId}
            onSelect={threads.selectThread}
            onNew={threads.newThread}
            onDelete={(id) => void threads.deleteThread(id)}
          />
        </aside>
        <ChatPane
          messages={threads.activeThread?.messages ?? []}
          streamingMessageId={streamingMessageId}
          busy={busy}
          capacity={capacity}
          notice={chatNotice}
          onSend={handleSend}
          onStop={() => {
            // A stop during a tool round-trip must also stop the loop from
            // resuming generation once the round-trip settles.
            if (exchangeRef.current) exchangeRef.current.cancelled = true;
            chat.abort('user stopped');
          }}
        />
        <MeshSidebar
          capacity={capacity}
          segments={segments}
          crewScale={crewScale}
          totalLayers={modelConfig.totalLayers}
          standing={standingView}
          leaderboard={leaderboard}
          consentBanner={{
            consent: hostingConsent.consent,
            capable: communal.supported,
            unsupportedReason: communal.unsupportedReason,
            onAccept: hostingConsent.accept,
            onDecline: hostingConsent.decline,
            onReconsider: hostingConsent.reconsider,
            hostingEnabled,
            onToggleHosting: setHostingEnabled,
            phase: communal.phase,
            claim: communal.claim,
            approxDownloadLabel: approxDownloadLabel(modelConfig),
            layerRangeLabel: `${modelConfig.driverLayers}–${modelConfig.totalLayers}`,
            errorMessage: communal.errorMessage,
            retrying: communal.retrying,
            downloadProgress: communal.downloadProgress,
            capacitySummaryLabel,
            contribution: {
              detectedGpuName: gpuDetection.limits?.gpuName,
              contributionBudgetBytes: hostingConsent.contributionBudgetBytes,
              onChangeBudget: hostingConsent.setContributionBudgetBytes,
              layersHosted,
              totalLayers: communalLayerCount,
              approxGbLabel: formatVramLabel(effectiveApproxBytes),
              // Clamp to the CURRENT model's communal layer count so a stored
              // override from a bigger model (e.g. 38 set on 14B) doesn't
              // render "38 of 34" after switching back to 8B. The stored value
              // is left intact (so switching back to 14B restores 38); only
              // the displayed/slider value is clamped to what this model allows.
              maxLayersOverride:
                hostingConsent.maxLayersOverride !== undefined
                  ? Math.min(communalLayerCount, hostingConsent.maxLayersOverride)
                  : undefined,
              onChangeMaxLayers: hostingConsent.setMaxLayersOverride,
              serveFirstStage: hostingConsent.serveFirstStage,
              onChangeServeFirstStage: hostingConsent.setServeFirstStage,
            },
          }}
          audioKeepalive={audioKeepalive}
          showAudioKeepalive={hostingConsent.consent === 'accepted'}
          toolContribution={toolContribution}
          modelFolder={modelFolder}
          modelFolderDownloadUrl={modelConfig.downloadUrl}
          pipelineHandoff={{
            stages: chat.plan?.stages ?? [],
            hopBytes: chat.hopBytes ?? {},
            nEmbd: modelConfig.nEmbd,
            connTypes: hopConnTypes,
            selfId: selfId2,
            nickOf,
          }}
        />
      </div>
      {trustModal && (
        <TrustInterstitial
          isHostSetChange={ackedHostKey !== null}
          thinDriver={isThinDevice}
          textRelay={isThinDevice}
          onAcknowledge={handleAcknowledge}
        />
      )}
    </div>
  );
}

function approxDownloadLabel(modelConfig: ReturnType<typeof resolveChatModelConfig>): string {
  const layers = modelConfig.totalLayers - modelConfig.driverLayers;
  const bytes = layers * modelConfig.avgLayerBytes;
  const gb = bytes / 1_000_000_000;
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${Math.round(bytes / 1_000_000)}MB`;
}
