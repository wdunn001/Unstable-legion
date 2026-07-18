/**
 * useToolContribution — the chat app's "contribute tools, no GPU needed"
 * state. Lives at App level (ABOVE MeshProvider) because the opted-in
 * descriptor list is part of the peer's cap advertisement — the provider
 * re-broadcasts whenever the cap changes, so a toggle here propagates to
 * every roster without reconnecting.
 *
 * Composes the existing runtime verbatim (no new mesh machinery):
 *   - `ToolRegistry` + `registerBuiltinTools` (current_time / ping /
 *     fetch_text) — the zero-setup contribution any tab can switch on.
 *   - `useMcpAttachments` — user-supplied MCP endpoints, discovered and
 *     registered under `mcp:<host>/<name>`, routed through the same-origin
 *     `/mcp-proxy/` nginx location (public MCP servers rarely send CORS).
 *   - Serving happens in the Dashboard via `useMeshTools` (needs mesh
 *     context); this hook only owns registry + opt-in + persistence.
 *
 * Persistence: opted-in names + MCP endpoint URLs in localStorage, so a
 * reload re-attaches and re-advertises without re-consent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ToolRegistry,
  registerBuiltinTools,
  type MeshToolDescriptor,
} from '@unstable-legion/core';
import { useMcpAttachments, type UseMcpAttachmentsHandle } from '@unstable-legion/react';

const STORAGE_KEY = 'unstable-legion-chat-tools-v1';

interface PersistedToolState {
  optedIn: string[];
  mcpEndpoints: string[];
}

function loadPersisted(): PersistedToolState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { optedIn: [], mcpEndpoints: [] };
    const parsed = JSON.parse(raw) as Partial<PersistedToolState>;
    return {
      optedIn: Array.isArray(parsed.optedIn) ? parsed.optedIn.filter((n) => typeof n === 'string') : [],
      mcpEndpoints: Array.isArray(parsed.mcpEndpoints) ? parsed.mcpEndpoints.filter((u) => typeof u === 'string') : [],
    };
  } catch {
    return { optedIn: [], mcpEndpoints: [] };
  }
}

function savePersisted(state: PersistedToolState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage full/blocked — contribution still works for this session
  }
}

export interface UseToolContributionHandle {
  registry: ToolRegistry;
  /** Names this tab advertises + serves. */
  optedIn: readonly string[];
  toggleTool: (name: string) => void;
  /** Registry descriptors for the opted-in set — goes into the peer cap. */
  descriptors: readonly MeshToolDescriptor[];
  /** The built-in (non-MCP) tools available to toggle. */
  builtinNames: readonly string[];
  /** MCP endpoint management (attach/detach/status). */
  mcp: UseMcpAttachmentsHandle;
  mcpEndpoints: readonly string[];
  addMcpEndpoint: (url: string) => void;
  removeMcpEndpoint: (url: string) => void;
  /** Calls this tab actually served (dispatched ok) this session. */
  servedCount: number;
}

export function useToolContribution(): UseToolContributionHandle {
  const registryRef = useRef<ToolRegistry | null>(null);
  const builtinNamesRef = useRef<string[]>([]);
  const [servedCount, setServedCount] = useState(0);
  if (registryRef.current === null) {
    const reg = new ToolRegistry();
    registerBuiltinTools(reg);
    builtinNamesRef.current = reg.list().map((r) => r.descriptor.name);
    // Count served calls without changing `useMeshTools` — wrap dispatch
    // once. Only a genuinely-served call (dispatch ran, not opt-in-denied)
    // increments.
    const origDispatch = reg.dispatch.bind(reg);
    reg.dispatch = (async (frame, optedIn) => {
      const result = await origDispatch(frame, optedIn);
      if (result.status === 'ok') setServedCount((c) => c + 1);
      return result;
    }) as typeof reg.dispatch;
    registryRef.current = reg;
  }
  const registry = registryRef.current;

  const [persisted, setPersisted] = useState<PersistedToolState>(() => loadPersisted());
  useEffect(() => savePersisted(persisted), [persisted]);

  const mcp = useMcpAttachments({
    registry,
    urls: persisted.mcpEndpoints,
    proxyBaseUrl: typeof window !== 'undefined' ? `${window.location.origin}/mcp-proxy/` : undefined,
  });

  // Auto-opt-in tools of a freshly attached MCP endpoint (same behavior
  // as apps/demo) — attaching IS the consent gesture for that endpoint.
  useEffect(() => {
    const mcpNames = mcp.attachedTools.map((t) => t.toolName);
    const missing = mcpNames.filter((n) => !persisted.optedIn.includes(n));
    if (missing.length > 0) {
      setPersisted((p) => ({ ...p, optedIn: [...p.optedIn, ...missing] }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcp.attachedTools]);

  const toggleTool = useCallback((name: string) => {
    setPersisted((p) => ({
      ...p,
      optedIn: p.optedIn.includes(name) ? p.optedIn.filter((n) => n !== name) : [...p.optedIn, name],
    }));
  }, []);

  const addMcpEndpoint = useCallback((url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setPersisted((p) => (p.mcpEndpoints.includes(trimmed) ? p : { ...p, mcpEndpoints: [...p.mcpEndpoints, trimmed] }));
  }, []);

  const removeMcpEndpoint = useCallback((url: string) => {
    setPersisted((p) => {
      // Also drop opt-ins for tools that endpoint registered — they're
      // gone from the registry once `useMcpAttachments` detaches it.
      const namesToDrop = new Set(mcp.attachedTools.filter((t) => t.url === url).map((t) => t.toolName));
      return {
        mcpEndpoints: p.mcpEndpoints.filter((u) => u !== url),
        optedIn: p.optedIn.filter((n) => !namesToDrop.has(n)),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcp.attachedTools]);

  // Descriptors recompute when opt-ins change OR the registry contents
  // change (MCP attach/detach) — attachedTools is the reactive signal for
  // the latter.
  const descriptors = useMemo(
    () => registry.descriptorsFor(persisted.optedIn),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registry, persisted.optedIn, mcp.attachedTools],
  );

  return {
    registry,
    optedIn: persisted.optedIn,
    toggleTool,
    descriptors,
    builtinNames: builtinNamesRef.current,
    mcp,
    mcpEndpoints: persisted.mcpEndpoints,
    addMcpEndpoint,
    removeMcpEndpoint,
    servedCount,
  };
}
