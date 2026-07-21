/**
 * @unstable-legion/react — React bindings + UI components for the
 * mesh AI library extracted from leet (1337.masszer0.com).
 *
 * Hooks own the lifecycle (Trystero peer, roster, tools, MCP attach,
 * WebGPU LLM, persona persistence). Components compose them. Host apps
 * style via the `ul-*` class names; nothing here ships CSS.
 *
 * Peer-deps (all optional, surface them only when the consumer uses
 * the matching hook / component):
 *   - @codecai/web      — Detokenizer + loadMap (useCodecMap, MeshChatPanel)
 *   - @codecai/web-llm  — wrapEngine (useLocalLlm)
 *   - @mlc-ai/web-llm   — patched fork (useLocalLlm)
 *   - react             — duh
 *
 * Pair with a Trystero strategy of your choice (`@trystero-p2p/mqtt`,
 * `trystero/ipfs`, etc.) — host passes `joinRoom` to MeshProvider.
 */

// ── Provider + room hooks ───────────────────────────────────────────
export {
  MeshProvider,
  useMeshContext,
  type MeshProviderProps,
  type MeshContextValue,
} from './provider.js';

// ── Roster ──────────────────────────────────────────────────────────
export { useMeshRoster } from './useMeshRoster.js';
export {
  useAggregatedTools,
  type AggregatedTool,
} from './useAggregatedTools.js';

// ── Chat ────────────────────────────────────────────────────────────
export { useMeshChat, type ChatHook } from './useMeshChat.js';

// ── Tools ───────────────────────────────────────────────────────────
export {
  useMeshTools,
  type UseMeshToolsOptions,
  type UseMeshToolsHandle,
} from './useMeshTools.js';
export {
  useMeshToolBus,
  type UseMeshToolBusOptions,
  type UnifiedToolHandle,
  type UnifiedToolDescriptor,
} from './useMeshToolBus.js';
export {
  useDirector,
  type UseDirectorOptions,
  type UseDirectorHandle,
  type DirectorRunResult,
} from './useDirector.js';

// ── MCP ─────────────────────────────────────────────────────────────
export {
  useMcpRegistry,
  useMcpAttachments,
  type UseMcpRegistryHandle,
  type UseMcpAttachmentsHandle,
  type UseMcpAttachmentsOptions,
  type McpAttachmentStatus,
} from './useMcp.js';

// ── Persona ─────────────────────────────────────────────────────────
export { usePersona, type UsePersonaHandle } from './usePersona.js';
export { useDeviceCompat } from './useDeviceCompat.js';
export {
  useAudioKeepalive,
  type AudioKeepaliveHandle,
} from './useAudioKeepalive.js';
export {
  AudioKeepaliveToggle,
  type AudioKeepaliveToggleProps,
} from './components/AudioKeepaliveToggle.js';

// ── Speech mesh-capability (PoC) ─────────────────────────────────────
export { useMicCapture, type MicClip, type UseMicCaptureOptions, type UseMicCaptureHandle } from './useMicCapture.js';
export {
  useSpeechHost,
  type UseSpeechHostOptions,
  type UseSpeechHostHandle,
} from './useSpeechHost.js';
export {
  useSpeechClient,
  type UseSpeechClientOptions,
  type UseSpeechClientHandle,
  type SpeechClientClip,
  type CallToolFn,
  type AsrTranscribeContentWithSource,
} from './useSpeechClient.js';
export {
  useTtsHost,
  type UseTtsHostOptions,
  type UseTtsHostHandle,
} from './useTtsHost.js';
export {
  useTtsClient,
  type UseTtsClientOptions,
  type UseTtsClientHandle,
  type TtsSynthesizeContentWithSource,
} from './useTtsClient.js';
export {
  useAudioPlayback,
  type AudioPlaybackContent,
  type UseAudioPlaybackHandle,
} from './useAudioPlayback.js';

// ── Model catalog (which web-llm models are available) ─────────────
export {
  DEFAULT_MODEL_CATALOG,
  MOBILE_MODEL_CATALOG,
  findModelEntry,
  detectMobileLikelyNeedsFp32,
  type ModelCatalogEntry,
} from './modelCatalog.js';

// ── Persona role presets ────────────────────────────────────────────
export {
  PERSONA_PRESETS,
  findPersonaPreset,
  type PersonaPreset,
} from './personaPresets.js';

// ── Browser LLM (WebGPU, leader-elected) ────────────────────────────
export {
  useLocalLlm,
  type UseLocalLlmOptions,
  type UseLocalLlmHandle,
  type LlmStatus,
} from './useLocalLlm.js';

// ── Tokenizer-map loading (edge detokenize) ─────────────────────────
export {
  useCodecMap,
  useCodecMapResolver,
  type UseCodecMapOptions,
  type UseCodecMapResolverOptions,
  type CodecMapHandle,
  type CodecMapResolverHandle,
} from './useCodecMap.js';

// ── Draft bridge (panel → composer wiring) ──────────────────────────
export {
  registerDraftSetter,
  insertIntoDraft,
  type DraftMutator,
} from './draftBridge.js';

// ── Phase C: pipeline-split stage hosting + driving ─────────────────
export {
  useStageHost,
  type UseStageHostOptions,
  type UseStageHostHandle,
  type UseStageHostSession,
} from './useStageHost.js';
export {
  useStagePipeline,
  type UseStagePipelineOptions,
  type UseStagePipelineHandle,
  type StagePipelineStatus,
} from './useStagePipeline.js';
export {
  buildStageHostCap,
  buildLocalCapacityCap,
  unionLoadedStages,
  planPipelineForDriver,
  sanitizeWasmHeapBudget,
  sanitizeWeightBudget,
  chooseMaxSessions,
  WASM_HEAP_CEILING_BYTES,
  CONTRIBUTION_BUDGET_CEILING_BYTES,
  DEFAULT_MAX_SESSIONS,
  MAX_SESSIONS_HARD_CAP,
  type StageHostLimits,
  type StageHostStabilityInputs,
  type StageHostSessionCapacity,
  type PlanPipelineForDriverOptions,
} from './stagePipelinePlanning.js';
export {
  canAdmitNow,
  enqueue,
  expireQueue,
  popNextByPriority,
  isSessionIdle,
  DEFAULT_QUEUE_CAP,
  DEFAULT_QUEUE_TTL_MS,
  DEFAULT_IDLE_EVICT_MS,
  type QueueEntry,
  type PriorityScoreFn,
  type EnqueueResult,
  type ExpireResult,
  type PopResult,
} from './stageSessionAdmission.js';
export {
  detectWebGpuLimits,
  isThinDriver,
  isThinDriverForModel,
  requiredStorageBufferBytesForManifest,
  USABLE_STAGE_HOST_MIN_BYTES,
  type WebGpuLimitsResult,
} from './webgpuLimits.js';

// ── Same-origin tab colocation — one shared host per browser profile ──
export {
  getOrCreateFailureDomainId,
  createColocationCoordinator,
  type SharedHostStatus,
  type ColocationCoordinatorOptions,
  type ColocationCoordinatorHandle,
} from './colocation.js';

// ── M3: communal pipeline — self-assembly host loop ─────────────────
export {
  useCommunalHost,
  resolveCommunalShardPlan,
  OPFS_QUOTA_CEILING_BYTES,
  type UseCommunalHostOptions,
  type UseCommunalHostHandle,
  type CommunalHostPhase,
} from './useCommunalHost.js';
// ── Resilience + telemetry (backoff, error copy, event shapes) ───────
export {
  computeBackoffMs,
  extractHttpStatus,
  describeHostError,
  cleanReason,
  retryCountdownSec,
  claimKey,
  claimsEqual,
  emitTelemetry,
  type BackoffOptions,
  type HostErrorInput,
  type ClaimLike,
  type MeshTelemetryEvent,
  type MeshTelemetryEventName,
  type MeshTelemetrySink,
  type StageHostLifecycleEvent,
} from './meshResilience.js';

// ── M3/M4 close-out: the driver-side communal chat caller ────────────
export {
  useCommunalChat,
  type UseCommunalChatOptions,
  type UseCommunalChatHandle,
  type CommunalChatStatus,
  type StageLoadProgressView,
  type ResidentStageZero,
} from './useCommunalChat.js';
// ── REUSE-STAGE0 Phase 1: serve the resident stage-0 worker to thin/
// text-relay clients as an isFirst communal stage ────────────────────
export {
  useLocalStageServe,
  type UseLocalStageServeOptions,
  type UseLocalStageServeHandle,
} from './useLocalStageServe.js';
export {
  createLocalStageServeEngine,
  sameServedConfig,
  type LocalStageServeEngine,
  type LocalStageServeEngineOptions,
  type ServedStageClient,
  type ServedStageConfig,
} from './localStageServeEngine.js';
export {
  STAGE_MODEL_ID,
  STAGE_TOTAL_LAYERS,
  STAGE_DRIVER_LAYERS,
  STAGE_CTX_SIZE,
  STAGE_AVG_LAYER_BYTES,
  STAGE_N_EMBD,
  stageShardPath,
  stageShardUrl,
  stageShardUrls,
  stageWasmGlueUrl,
} from './stageModelSource.js';
export { StageWorkerClient, type StageWorkerLog } from './stageWorkerClient.js';
export type { StageWorkerRequest, StageWorkerResponse, StageWorkerLoadProgress, WireActivationFrame } from './stageWorkerProtocol.js';

// ── Load model layers from a local folder (bytes only — verified against
// the REMOTE manifest's hashes by the existing fetchAndCacheFragment path,
// never a "trust the folder" bypass — see localFolderFetch.ts's module
// doc comment for the full trust model). ────────────────────────────────
export { createLocalFolderFetch, createNullShardStore, fragmentRelativePath } from './localFolderFetch.js';

// ── WebGPU device buffer-limit patch (FIX for 8B+ models — see
// webgpuDevicePatch.ts's module doc) — installed by a stage-hosting
// worker entry point before the wasm module instantiates. ───────────────
export {
  patchWebGpuDeviceLimits,
  mergeAdapterLimitsIntoRequiredLimits,
  type WebGpuLimitKey,
  type WebGpuLimitsSource,
} from './webgpuDevicePatch.js';

// ── Progress-based stall watchdog (replaces a flat load-timeout with a
// "no progress for N ms" one — see loadWatchdog.ts's module doc). ───────
export { runWithStallWatchdog, StallTimeoutError, type StallWatchdogOptions } from './loadWatchdog.js';

// ── UI components (host styles them via `ul-*` classes) ─────────────
export { LlmStatusPanel, type LlmStatusPanelProps } from './components/LlmStatusPanel.js';
export {
  DirectorTrace,
  type DirectorTraceProps,
  type DirectorTraceStep,
} from './components/DirectorTrace.js';
export { McpStatusRow, type McpStatusRowProps } from './components/McpStatusRow.js';
export { MeshRosterPanel } from './components/MeshRosterPanel.js';
export {
  MeshChatPanel,
  type MeshChatPanelProps,
} from './components/MeshChatPanel.js';
export { SafetyDialog, type SafetyDialogProps } from './components/SafetyDialog.js';
export { PersonaForm, type PersonaFormProps } from './components/PersonaForm.js';

// ── Core re-exports for convenience ─────────────────────────────────
export type {
  MeshChatMessage,
  MeshLoadedStage,
  MeshPeerCap,
  MeshRosterEntry,
  MeshToolCall,
  MeshToolFrame,
  MeshToolResult,
  MeshToolDescriptor,
  Peer,
  CodecMsgpackFrame,
  McpAttachment,
  McpError,
  McpRegistry,
  McpRegistryEntry,
  MeshPersona,
  BootMode,
  MirroredModelConfig,
  MergeRelayUrlsOptions,
  DeviceCompat,
  DeviceCompatTier,
} from '@unstable-legion/core';
// M4: contribution economy — re-exported so consumers don't need a
// separate `@unstable-legion/core` import just to construct/bind a ledger.
export {
  StandingLedger,
  createStandingLedger,
  bindPriorityScore,
  defaultNoiseSource,
  DEFAULT_STANDING_CONFIG,
  DEFAULT_HALF_LIFE_MS,
  DEFAULT_NEWCOMER_FLOOR,
  DEFAULT_LOWEST_LANE,
  DEFAULT_NOISE_AMPLITUDE,
  DEFAULT_NOISE_BUCKET_MS,
  type StandingConfig,
  type NoiseSource,
  type RecordServiceInput,
  type RecordConsumptionInput,
  type StandingSnapshot,
} from '@unstable-legion/core';
export {
  ToolRegistry,
  registerBuiltinTools,
  registerRouteSkillTool,
  newCallId,
  type ToolHandler,
  type ToolArgValidator,
  type ToolRegistration,
  type ToolHandlerResult,
  DEFAULT_PERSONA,
  fetchMcpRegistry,
  discoverMcpEndpoint,
  detachMcpEndpoint,
  mergeRelayUrls,
  defaultTurnConfig,
  isMirroredModelId,
  mirroredModelUrl,
} from '@unstable-legion/core';
// Speech mesh-capability (PoC) contract — re-exported so consumers don't
// need a separate `@unstable-legion/core` import just for these.
export {
  ASR_SKILL,
  ASR_TOOL_NAME,
  TTS_SKILL,
  TTS_TOOL_NAME,
  type AsrTranscribeArgs,
  type AsrTranscribeContent,
  type AsrTranscribeSegment,
  type TtsSynthesizeArgs,
  type TtsSynthesizeContent,
} from '@unstable-legion/core';
export type {
  DefaultTurnConfigOptions,
  IceServerEntry,
} from '@unstable-legion/core';
