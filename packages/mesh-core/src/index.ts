/**
 * @unstable-legion/core — peer-to-peer browser-AI mesh.
 *
 * The wire format is just Codec msgpack frames (see `@codecai/web`). We
 * already ship Codec frames over WebRTC for the latent modality
 * (ComfyUI / diffusers forks); this package extends the same pattern
 * to the text-token modality. A peer's local LLM emits Codec frames
 * via `@codecai/web-llm`, the Trystero data channel ships those frame
 * bytes verbatim, the receiving peer's `@codecai/web` decoder reads
 * them — byte-identical to consuming from an HTTP-served vLLM.
 *
 * What this package owns:
 *
 *   1. Trystero room lifecycle + cap announcement + roster
 *   2. Four named actions (cap / cm / cf / tc) wired with type-guards
 *   3. Outbound prefilter glue (`@codecai/web-safety`)
 *
 * What this package DOESN'T own (consumers wire these):
 *
 *   - The Trystero strategy (consumer imports `trystero/torrent`,
 *     `trystero/ipfs`, `trystero/nostr`, or `trystero/mqtt`)
 *   - The local LLM engine (consumer constructs an `@mlc-ai/web-llm`
 *     engine, wraps it with `@codecai/web-llm`, and feeds the resulting
 *     Codec frames into `peer.sendFrame`)
 *   - The UI (React / Vue / vanilla — see `@unstable-legion/react`)
 *
 * For an advanced path (HELLO/READY/END handshake, stream-id
 * multiplexing, MTU chunking) the optional `webrtc-codec` helpers are
 * available — most consumers don't need them.
 */

// ── Wire types ──────────────────────────────────────────────────────
export {
  MESH_PROTOCOL_VERSION,
  type MeshChatMessage,
  type MeshLoadedStage,
  type MeshPeerCap,
  type MeshRosterEntry,
  type MeshToolCall,
  type MeshToolDescriptor,
  type MeshToolFrame,
  type MeshToolResult,
} from './types.js';

export {
  isMeshChatMessage,
  isMeshLoadedStage,
  isMeshPeerCap,
  isMeshToolCall,
  isMeshToolFrame,
  isMeshToolResult,
} from './guards.js';

// ── Trystero peer + roster ──────────────────────────────────────────
export { joinMesh, splitPeerTarget, type Peer, type PeerOptions, type JoinRoomFn, type TrysteroRoom, type SplitPeerTarget } from './peer.js';
export { Roster, type RosterOptions } from './roster.js';

// ── Phase C: pipeline-split stage-control protocol (over `tc`) ──────
// Stays MESH_PROTOCOL_VERSION-compatible (v1, additive fields only) —
// no subprotocol/generation bump implemented in this pass.
export {
  newCallId as newStageCallId,
  newSessionId as newStageSessionId,
  stageTokenCallId,
  encodeStageControl,
  decodeStageControl,
  isStageControlFrame,
  isStageLoadPayload,
  isStageReadyPayload,
  isStageStopPayload,
  isStagePingPayload,
  isStagePongPayload,
  isStageProgressPayload,
  isStageLoadProgressPayload,
  isStageTokenPayload,
  makeStageLoad,
  makeStageReady,
  makeStageStop,
  makeStagePing,
  makeStagePong,
  makeStageProgress,
  makeStageLoadProgress,
  makeStageToken,
  makeStageSessionOpen,
  makeStageSessionAccept,
  makeStageSessionBusy,
  isStageSessionOpenPayload,
  isStageSessionAcceptPayload,
  isStageSessionBusyPayload,
  type StageControlKind,
  type StageControlMessage,
  type StageControlMessageFor,
  type StageLoadPayload,
  type StageReadyPayload,
  type StageStopPayload,
  type StagePingPayload,
  type StagePongPayload,
  type StageProgressPayload,
  type StageLoadProgressPayload,
  type StageTokenPayload,
  type StageSessionOpenPayload,
  type StageSessionAcceptPayload,
  type StageSessionBusyPayload,
} from './stageControl.js';

// ── TEXT-RELAY: incremental UTF-8-safe text streaming (pure) ──────────
export {
  extractIncrementalTextDelta,
  INITIAL_TEXT_CURSOR,
  type IncrementalTextCursor,
  type IncrementalTextDeltaResult,
} from './incrementalTextStream.js';

// ── M2: sessionId envelope for the `sf` activation-frame channel ────
export {
  encodeStageFrameEnvelope,
  decodeStageFrameEnvelope,
  type DecodedStageFrameEnvelope,
} from './stageFrameEnvelope.js';

// ── Activation wire dispatcher (f32/f16 via stage-runtime, i8 in-repo) ──
export {
  createLegionActivationWireEncoder,
  createLegionActivationWireDecoder,
  legionActivationBytes,
  type LegionWireDtype,
  type LegionActivationWireEncoder,
  type LegionActivationWireDecoder,
  type LegionActivationWireOptions,
} from './activationWireCodec.js';
export {
  LEGION_I8_CODEC_MARKER,
  isLegionI8Header,
  measureDeflateGain,
  type DeflateGainResult,
} from './activationWireI8.js';

// ── Wire dtype inference from byte size alone (pipeline-handoff UI) ────
export { wireDtypeFromFrameBytes, type WireDtypeGuess } from './wireDtypeGuess.js';

// ── Phase C: pipeline-split planner ──────────────────────────────────
export {
  planPipeline,
  validateStagePlan,
  filterStageHosts,
  hostCapacityBytes,
  hostStabilityScore,
  layerFragmentId,
  type StagePipelineRequest,
  type StageHostCap,
  type RosterEntryWithStageHost,
  type PlanPipelineOptions,
  type PlannedStage,
  type StagePlan,
  type PlanValidity,
} from './stagePlanner.js';

// ── Phase C: driver-side stage-session orchestrator ──────────────────
export {
  runDriverStageSession,
  runCommunalDriverSession,
  computeReplanJitterMs,
  type DriverStageHooks,
  type StageOrchestratorTimeouts,
  type StageOrchestratorPeer,
  type ReplanFn,
  type DriverStageSessionOptions,
  type StageOrchestratorEvent,
  type StageOrchestratorListener,
  type StageSessionResult,
  type StageSessionHandle,
  type CommunalRoute,
  type CommunalRouteFn,
  type CommunalDriverSessionOptions,
} from './stageOrchestrator.js';

// ── M3: communal pipeline coverage/assembly (pure) ────────────────────
export {
  buildCommunalTopology,
  planCommunalRoute,
  communalAttachOrder,
  collectCommunalAds,
  deterministicHash,
  adFailureDomainId,
  distinctFailureDomainIds,
  distinctFailureDomainCount,
  // OPTIONAL-STAGE0 (thin drivers)
  planThinDriverRoute,
  thinDriverFirstStageCovered,
  type CommunalHostStageAd,
  type CommunalSegment,
  type CommunalGap,
  type CommunalTopology,
  type BuildCommunalTopologyRequest,
  type BuildCommunalTopologyOptions,
  type PlanCommunalRouteOptions,
} from './communalTopology.js';
export {
  communalHostClaim,
  DEFAULT_MAX_SPARES_PER_SEGMENT,
  DEFAULT_JITTER_BASE_MS,
  type CommunalPriorityScoreFn,
  type CommunalClaimRange,
  type CommunalHostClaimInput,
  type CommunalHostClaimResult,
} from './communalAssembly.js';

// ── Codec frame plumbing (the primary path — Codec frames over WebRTC) ──
export {
  encodeFrameBytes,
  decodeFrameBytes,
  makeOutboundEncoder,
  makeInboundAssembler,
  renderFrameForHuman,
  type CodecMsgpackFrame,
  type OutboundEncoder,
  type InboundAssembler,
  type InboundAssemblerOptions,
  type TokenizerMap,
  type Detokenizer,
} from './wire.js';

// ── Safety prefilter glue ───────────────────────────────────────────
export {
  prefilterOutbound,
  applyRedaction,
  attachSafetyVerdict,
  type OutboundDecision,
  type OutboundSafetyOptions,
  type PrefilterMatch,
  type PrefilterCategory,
} from './safety.js';

// ── Tool registry + dispatch ────────────────────────────────────────
export {
  ToolRegistry,
  PendingToolCallTracker,
  registerBuiltinTools,
  registerRouteSkillTool,
  newCallId,
  type ToolRegistration,
  type ToolHandler,
  type ToolArgValidator,
  type ToolHandlerResult,
  type RegisterRouteSkillToolOptions,
} from './tools.js';

// ── Speech mesh-capability contract (PoC) ────────────────────────────
export {
  ASR_SKILL,
  ASR_TOOL_NAME,
  TTS_SKILL,
  TTS_TOOL_NAME,
  type AsrTranscribeArgs,
  type AsrTranscribeContent,
  type AsrTranscribeSegment,
} from './speech.js';

// ── Hierarchical skill resolver (Layer 4) ──────────────────────────
export {
  routeBySkill,
  SkillCache,
  RESOLVER_HOPS_KEY,
  RESOLVER_ORIGIN_KEY,
  RESOLVER_SKILL_KEY,
  type SkillResolveOptions,
  type RouteBySkillContext,
} from './skillResolver.js';

// ── MCP Streamable-HTTP client ──────────────────────────────────────
export {
  discoverMcpEndpoint,
  callMcpTool,
  detachMcpEndpoint,
  proxiedMcpUrl,
  type McpAttachment,
  type McpError,
  type McpDiscoverOptions,
} from './mcp.js';

// ── Public MCP server registry (same-origin snapshot) ───────────────
export {
  fetchMcpRegistry,
  type McpRegistry,
  type McpRegistryEntry,
  type FetchMcpRegistryOptions,
} from './mcp-registry.js';

// ── Persona persistence ─────────────────────────────────────────────
export {
  DEFAULT_PERSONA,
  loadPersona,
  savePersona,
  type BootMode,
  type MeshPersona,
} from './persona.js';

// ── Strategy-agnostic helpers ───────────────────────────────────────
export {
  mergeRelayUrls,
  type MergeRelayUrlsOptions,
} from './relays.js';
export {
  defaultTurnConfig,
  type DefaultTurnConfigOptions,
  type IceServerEntry,
} from './iceServers.js';
export {
  isMirroredModelId,
  mirroredModelUrl,
  type MirroredModelConfig,
} from './mirrored-models.js';
export {
  detectDeviceCompat,
  type DeviceCompat,
  type DeviceCompatTier,
} from './deviceCompat.js';

// ── Routing + fan-out primitives (Layer 1 of the director plan) ────
export {
  findPeersBySkill,
  findPeersByTool,
  findPeersByModelFamily,
  findDelegatingPeers,
  pickBestPeer,
  type FindPeersOptions,
} from './routing.js';
export {
  callToolFanOut,
  ensemble,
  mapReduce,
  type FanOutOptions,
  type FanOutEntry,
  type MapReduceMapTool,
} from './fanOut.js';
export {
  majorityVote,
  concatJoin,
  llmSummarize,
  type LlmSummarizeOptions,
} from './aggregators.js';

// ── M4: contribution economy ("standing") ───────────────────────────
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
  DEFAULT_TOOL_SERVICE_CREDIT,
  DEFAULT_TOOL_CONSUME_DEBIT,
  type StandingConfig,
  type NoiseSource,
  type RecordServiceInput,
  type RecordConsumptionInput,
  type RecordToolServiceInput,
  type RecordToolConsumptionInput,
  type StandingSnapshot,
} from './standing.js';

// ── TOOL-NODES: agentic tool-use in the communal chat loop ──────────────
export {
  parseToolCalls,
  firstToolCall,
  buildToolResultBlock,
  runToolRoundTrip,
  type ParsedToolCall,
  type ToolRoundTripPeer,
  type ToolRoundTripStatus,
  type ToolRoundTripResult,
  type RunToolRoundTripOptions,
} from './toolLoop.js';

// ── ICE diagnostics (installed automatically by joinMesh; exported for
// tests / non-mesh consumers) ────────────────────────────────────────
export {
  installIceDiagnostics,
  type IceDiagSummary,
  type IceConnectionRecord,
} from './iceDiagnostics.js';

// ── Optional: Codec-over-WebRTC advanced path ──────────────────────
//
// HELLO/READY handshake + stream-id multiplexing + MTU chunking, for
// consumers that need more than the "fire frame bytes through the
// data channel" path the rest of this module supports out of the box.
//
// Most mesh participants get by without these — they're useful when:
//   - multiple concurrent LLM streams between the same two peers need
//     to interleave
//   - per-stream compression negotiation matters
//   - bulk-token-id uploads exceed the WebRTC ~64 KB per-message MTU
export {
  ENVELOPE_KIND,
  WEBRTC_MTU_BYTES,
  encodeEnvelope,
  decodeEnvelope,
  makeHelloEnvelope,
  makeReadyEnvelope,
  makeEndEnvelope,
  makeDataEnvelope,
  chunkFrameForWire,
  chunkFrameIter,
  makeReassembler,
  newStreamId,
  type EnvelopeKind,
  type WebRtcEnvelope,
  type WebRtcHello,
  type WebRtcReady,
  type WebRtcEnd,
  type Reassembler,
  type ReassemblerOptions,
} from './webrtc-codec.js';
