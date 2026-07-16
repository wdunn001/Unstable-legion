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
  defaultTurnConfig,
  mergeRelayUrls,
  useAudioKeepalive,
  useCommunalChat,
  useCommunalHost,
  useMeshContext,
  useMeshRoster,
  usePersona,
  useUserChat,
  type MeshPeerCap,
  type MeshProviderProps,
} from '@unstable-legion/react';
import { buildCommunalTopology } from '@unstable-legion/core';
import { JoinScreen } from './components/JoinScreen.js';
import { ConversationList } from './components/ConversationList.js';
import { ChatPane } from './components/ChatPane.js';
import { RoomChatPanel } from './components/RoomChatPanel.js';
import { MeshSidebar } from './components/MeshSidebar.js';
import { TrustBadge } from './components/TrustBadge.js';
import { TrustInterstitial } from './components/TrustInterstitial.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { useThreads } from './hooks/useThreads.js';
import { useHostingConsent } from './hooks/useHostingConsent.js';
import { useTheme, type UseThemeHandle } from './hooks/useTheme.js';
import { resolveChatModelConfig } from './chatModelSource.js';
import { buildPrompt } from './chatPrompt.js';
import {
  deriveCapacityView,
  deriveLeaderboard,
  deriveStandingView,
  deriveTopologySegments,
  nickLookup,
} from './viewmodels/meshViewModels.js';
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

const RELAY_URLS = mergeRelayUrls({
  defaults: defaultRelayUrls,
  blockedHosts: ['test.mosquitto.org', 'broker-cn.emqx.io'],
  max: 6,
});
// Build-time TURN config — see apps/chat/Dockerfile. STUN-only by
// default; mirrors apps/demo's VITE_TURN_* convention exactly.
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
const TURN_CONFIG = defaultTurnConfig({ extras: TURN_EXTRAS, useDefault: TURN_USE_DEFAULT });

const TRYSTERO_CONFIG: MeshProviderProps['trysteroConfig'] = {
  appId: 'unstable-legion-chat-v1',
  relayConfig: { urls: RELAY_URLS },
  turnConfig: TURN_CONFIG,
};

const PERSONA_STORAGE_KEY = 'unstable-legion-chat-persona-v1';

export function App() {
  const { persona, update: updatePersona } = usePersona(PERSONA_STORAGE_KEY);
  const [joined, setJoined] = useState(false);
  const modelConfig = useMemo(() => resolveChatModelConfig(), []);
  // Applies to every screen (join or joined) — the theme toggle needs to
  // work before a nick is even chosen, not just once inside the Dashboard.
  const theme = useTheme();

  const cap: (Omit<MeshPeerCap, 'ts'> & { ts?: number }) | null = useMemo(() => {
    if (!persona.nick) return null;
    return {
      v: 1,
      nick: persona.nick,
      modelId: modelConfig.modelId,
      available: true,
      skills: [],
      systemPromptSummary: 'Unstable Legion communal chat client',
      tools: [],
    };
  }, [persona.nick, modelConfig.modelId]);

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
    <MeshProvider joinRoom={joinRoom} selfId={selfId} trysteroConfig={TRYSTERO_CONFIG} roomId={ROOM_ID} cap={cap}>
      <Dashboard nick={persona.nick} onChangeNick={() => setJoined(false)} baseCap={cap} modelConfig={modelConfig} theme={theme} />
    </MeshProvider>
  );
}

function Dashboard(props: {
  nick: string;
  onChangeNick: () => void;
  baseCap: Omit<MeshPeerCap, 'ts'> & { ts?: number };
  modelConfig: ReturnType<typeof resolveChatModelConfig>;
  theme: UseThemeHandle;
}) {
  const { modelConfig } = props;
  const { peer } = useMeshContext();
  const roster = useMeshRoster();

  // One contribution-economy ledger per Dashboard mount (== per
  // MeshProvider subtree) — same "one ledger, shared across every role"
  // convention as apps/demo's App.tsx.
  const standingLedgerRef = useRef<StandingLedger | null>(null);
  if (standingLedgerRef.current === null) standingLedgerRef.current = new StandingLedger();
  const standingLedger = standingLedgerRef.current;
  const priorityScore = useMemo(() => bindPriorityScore(standingLedger, () => Date.now()), [standingLedger]);

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
  // Session-local live on/off — distinct from the persisted `consent`
  // decision (see useHostingConsent's doc comment: "leaving" for this
  // session shouldn't erase a standing "yes").
  const [hostingEnabled, setHostingEnabled] = useState(hostingConsent.consent === 'accepted');
  useEffect(() => {
    setHostingEnabled(hostingConsent.consent === 'accepted');
  }, [hostingConsent.consent]);

  const communal = useCommunalHost({
    enabled: hostingEnabled,
    peer,
    baseCap: props.baseCap,
    createStageWorker,
    modelId: modelConfig.modelId,
    totalLayers: modelConfig.totalLayers,
    driverLayers: modelConfig.driverLayers,
    ctxSize: modelConfig.ctxSize,
    wireDtype: 'f32',
    manifestUrl: modelConfig.manifestUrl,
    fallbackShardUrls: modelConfig.shardUrls,
    avgLayerBytes: modelConfig.avgLayerBytes,
    keepaliveEnabled: audioKeepalive.enabled,
    priorityScore,
    standingLedger,
    log,
  });

  const chat = useCommunalChat({
    peer,
    createStageWorker,
    modelId: modelConfig.modelId,
    totalLayers: modelConfig.totalLayers,
    driverLayers: modelConfig.driverLayers,
    nEmbd: modelConfig.nEmbd,
    ctxSize: modelConfig.ctxSize,
    wireDtype: 'f32',
    priorityScore,
    standingLedger,
    log,
  });

  const threads = useThreads();

  // ── User-to-user room chat — a DISTINCT surface from the AI assistant
  // above. Standing-gated rate limiting reuses the SAME contribution
  // ledger the mesh economy runs on (priorityScore), so contributors get
  // more chat headroom and newcomers less — never a hard block. ────────
  const roomChat = useUserChat({ nick: props.nick, standingOf: priorityScore });
  const [chatTab, setChatTab] = useState<'assistant' | 'room'>('assistant');
  const [roomSeenCount, setRoomSeenCount] = useState(0);
  const roomUnread = chatTab === 'room' ? 0 : Math.max(0, roomChat.messages.length - roomSeenCount);
  useEffect(() => {
    if (chatTab === 'room') setRoomSeenCount(roomChat.messages.length);
  }, [chatTab, roomChat.messages.length]);

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

  const doSend = useCallback(
    (text: string) => {
      const prompt = buildPrompt(threads.activeThread?.messages ?? [], text);
      threads.appendMessage('user', text);
      const assistantId = threads.appendMessage('assistant', '');
      setStreamingMessageId(assistantId);
      void chat.start(prompt, { maxDecodeTokens: 256 });
    },
    [threads, chat],
  );

  useEffect(() => {
    if (!streamingMessageId) return;
    threads.updateMessageContent(streamingMessageId, chat.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.text, streamingMessageId]);

  useEffect(() => {
    if (!streamingMessageId) return;
    if (chat.status.phase === 'finished' || chat.status.phase === 'aborted' || chat.status.phase === 'error') {
      if (chat.restartCount > 0) threads.markReconnected(streamingMessageId);
      void threads.flushActiveThread();
      setStreamingMessageId(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.status, chat.restartCount, streamingMessageId]);

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

  useEffect(() => {
    (window as unknown as { __legionChat?: unknown }).__legionChat = {
      selfId: peer?.selfId,
      capacityPercent: capacity.coveragePercent,
      capacityReady: capacity.ready,
      chatStatus: chat.status,
      chatText: chat.text,
      chatRestartCount: chat.restartCount,
      threadCount: threads.threads.length,
      activeThreadId: threads.activeThreadId,
      trustModalOpen: trustModal !== null,
      hostingConsent: hostingConsent.consent,
      hostingActive: communal.active,
    };
    // Separate snapshot for the user-to-user room chat e2e — kept distinct
    // from __legionChat (the AI path) exactly as the two surfaces are.
    (window as unknown as { __legionRoomChat?: unknown }).__legionRoomChat = {
      tab: chatTab,
      selfId: peer?.selfId,
      messageCount: roomChat.messages.length,
      texts: roomChat.messages.map((m) => m.text),
      lastFrom: roomChat.messages.length > 0 ? roomChat.messages[roomChat.messages.length - 1]?.nick : undefined,
      stats: roomChat.stats,
    };
    // Test-only affordance: lets the e2e flood the room from a single peer
    // faster than the composer allows, to prove the outbound rate limiter
    // throttles a flood. Returns the send-result kind.
    (window as unknown as { __legionRoomChatSend?: (t: string) => Promise<string> }).__legionRoomChatSend = async (t: string) =>
      (await roomChat.send(t)).kind;
  }, [peer, capacity, chat.status, chat.text, chat.restartCount, threads.threads, threads.activeThreadId, trustModal, hostingConsent.consent, communal.active, chatTab, roomChat.messages, roomChat.stats, roomChat.send]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-brand">Unstable Legion</span>
        <span className="app-header-sep">·</span>
        {/* Product requirement: the model this mesh is assembling/serving
         * is always named, never buried behind a status number — read
         * from chatModelSource.ts's single source of truth, not hardcoded
         * here. */}
        <span className="app-model-pill" title={`This mesh is assembling/serving ${modelConfig.modelLabel}`}>
          {modelConfig.modelLabel}
        </span>
        <span className="app-header-sep">·</span>
        <span className="app-nick">@{props.nick}</span>
        <span className="app-header-sep">·</span>
        <span className={`app-mesh-pill ${remoteCount > 0 ? 'app-mesh-ok' : 'app-mesh-cold'}`}>mesh: {remoteCount} remote</span>
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
        <div className="center-col">
          <div className="chat-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={`chat-tab ${chatTab === 'assistant' ? 'chat-tab-active' : ''}`}
              aria-selected={chatTab === 'assistant'}
              onClick={() => setChatTab('assistant')}
            >
              Assistant
            </button>
            <button
              type="button"
              role="tab"
              className={`chat-tab ${chatTab === 'room' ? 'chat-tab-active' : ''}`}
              aria-selected={chatTab === 'room'}
              onClick={() => setChatTab('room')}
            >
              Room
              {roomUnread > 0 && <span className="chat-tab-badge">{roomUnread}</span>}
            </button>
          </div>
          {chatTab === 'assistant' ? (
            <ChatPane
              messages={threads.activeThread?.messages ?? []}
              streamingMessageId={streamingMessageId}
              busy={busy}
              capacity={capacity}
              onSend={handleSend}
              onStop={() => chat.abort('user stopped')}
            />
          ) : (
            <RoomChatPanel
              messages={roomChat.messages}
              stats={roomChat.stats}
              roster={roster}
              selfId={peer?.selfId ?? ''}
              onSend={(t) => roomChat.send(t)}
            />
          )}
        </div>
        <MeshSidebar
          capacity={capacity}
          segments={segments}
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
          }}
          audioKeepalive={audioKeepalive}
          showAudioKeepalive={hostingConsent.consent === 'accepted'}
        />
      </div>
      {trustModal && <TrustInterstitial isHostSetChange={ackedHostKey !== null} onAcknowledge={handleAcknowledge} />}
    </div>
  );
}

function approxDownloadLabel(modelConfig: ReturnType<typeof resolveChatModelConfig>): string {
  const layers = modelConfig.totalLayers - modelConfig.driverLayers;
  const bytes = layers * modelConfig.avgLayerBytes;
  const gb = bytes / 1_000_000_000;
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${Math.round(bytes / 1_000_000)}MB`;
}
