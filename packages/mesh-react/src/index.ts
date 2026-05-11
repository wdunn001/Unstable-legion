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

// ── Model catalog (which web-llm models are available) ─────────────
export {
  DEFAULT_MODEL_CATALOG,
  MOBILE_MODEL_CATALOG,
  findModelEntry,
  detectMobileLikelyNeedsFp32,
  type ModelCatalogEntry,
} from './modelCatalog.js';

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

// ── UI components (host styles them via `ul-*` classes) ─────────────
export { LlmStatusPanel, type LlmStatusPanelProps } from './components/LlmStatusPanel.js';
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
} from '@unstable-legion/core';
export {
  ToolRegistry,
  registerBuiltinTools,
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
  isMirroredModelId,
  mirroredModelUrl,
} from '@unstable-legion/core';
