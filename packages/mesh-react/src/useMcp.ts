/**
 * MCP hooks for React mesh apps.
 *
 *   - useMcpRegistry()   — fetches `/.well-known/mcp/registry.json` once
 *                          and caches it (localStorage + module-level
 *                          inflight dedupe).
 *   - useMcpAttachments() — drives the discover/detach lifecycle against
 *                          a `ToolRegistry`. Hands back the live list +
 *                          per-URL status (idle/connecting/attached/error).
 *
 * The host decides which URLs to attach (the persona's `mcpEndpoints`).
 * The hook does the attach + cleanup; it does NOT decide policy.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  discoverMcpEndpoint,
  detachMcpEndpoint,
  fetchMcpRegistry,
  type McpAttachment,
  type McpError,
  type McpRegistry,
  type ToolRegistry,
} from '@unstable-legion/core';

// ── Registry browsing ────────────────────────────────────────────────────────

export interface UseMcpRegistryHandle {
  registry: McpRegistry | null;
  loading: boolean;
  error: string | null;
  /** Force a refresh (bypasses the in-memory cache; localStorage is overwritten on success). */
  reload: () => void;
}

export function useMcpRegistry(): UseMcpRegistryHandle {
  const [registry, setRegistry] = useState<McpRegistry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchMcpRegistry()
      .then((r) => setRegistry(r))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { registry, loading, error, reload: load };
}

// ── Attachment lifecycle ────────────────────────────────────────────────────

export type McpAttachmentStatus =
  | { phase: 'idle' }
  | { phase: 'connecting' }
  | { phase: 'attached'; attachment: McpAttachment }
  | { phase: 'error'; error: McpError };

export interface UseMcpAttachmentsHandle {
  /** Status map keyed by URL. */
  statuses: ReadonlyMap<string, McpAttachmentStatus>;
  /** All attached endpoints (convenience derived from `statuses`). */
  attached: ReadonlyArray<McpAttachment>;
  /** Total mesh-namespaced tools registered across all attached endpoints. */
  attachedTools: ReadonlyArray<{ url: string; toolName: string }>;
  /** Attach a new URL — discovers + registers; idempotent on re-attach. */
  attach: (url: string) => Promise<void>;
  /** Detach a URL — unregisters tools from the local registry. */
  detach: (url: string) => void;
}

export interface UseMcpAttachmentsOptions {
  registry: ToolRegistry;
  /** URLs to attach on mount. Changes here trigger attach/detach diffs. */
  urls: readonly string[];
  /**
   * Optional same-origin proxy base URL. Public MCP endpoints usually
   * lack CORS headers, so a browser fetch fails with `Failed to fetch`.
   * Set this to a path served by your nginx (e.g. `'/mcp-proxy/'`)
   * that reverse-proxies upstream — see apps/demo/nginx.conf for the
   * matching server-side rule.
   */
  proxyBaseUrl?: string;
}

export function useMcpAttachments(opts: UseMcpAttachmentsOptions): UseMcpAttachmentsHandle {
  const { registry, urls, proxyBaseUrl } = opts;
  const [statuses, setStatuses] = useState<Map<string, McpAttachmentStatus>>(
    () => new Map(),
  );

  // Keep a ref so the per-URL effect can read latest state.
  const statusesRef = useRef(statuses);
  useEffect(() => {
    statusesRef.current = statuses;
  }, [statuses]);

  // The set of URLs we've already kicked off attach for — avoids re-firing
  // on every render. Re-attach happens only if the URL is dropped + re-
  // added or an explicit `attach()` call.
  const attachInflight = useRef<Set<string>>(new Set());

  const setStatus = useCallback((url: string, next: McpAttachmentStatus) => {
    setStatuses((prev) => {
      const m = new Map(prev);
      m.set(url, next);
      return m;
    });
  }, []);

  const attach = useCallback(
    async (url: string) => {
      if (attachInflight.current.has(url)) return;
      attachInflight.current.add(url);
      setStatus(url, { phase: 'connecting' });
      try {
        const attachment = await discoverMcpEndpoint(url, registry, { proxyBaseUrl });
        setStatus(url, { phase: 'attached', attachment });
      } catch (err) {
        const typed = (err as McpError) ?? {
          kind: 'network',
          url,
          detail: err instanceof Error ? err.message : String(err),
        };
        setStatus(url, { phase: 'error', error: typed });
      } finally {
        attachInflight.current.delete(url);
      }
    },
    [registry, setStatus, proxyBaseUrl],
  );

  const detach = useCallback(
    (url: string) => {
      const status = statusesRef.current.get(url);
      if (status?.phase === 'attached') {
        detachMcpEndpoint(status.attachment, registry);
      }
      setStatuses((prev) => {
        const m = new Map(prev);
        m.delete(url);
        return m;
      });
    },
    [registry],
  );

  // Diff: ensure every URL in `urls` has been attached; drop ones removed.
  useEffect(() => {
    const want = new Set(urls);
    for (const have of statusesRef.current.keys()) {
      if (!want.has(have)) detach(have);
    }
    for (const u of urls) {
      const cur = statusesRef.current.get(u);
      if (!cur || cur.phase === 'idle') {
        void attach(u);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(urls)]);

  // Derive convenience lists.
  const attached: McpAttachment[] = [];
  const attachedTools: { url: string; toolName: string }[] = [];
  for (const [, status] of statuses) {
    if (status.phase === 'attached') {
      attached.push(status.attachment);
      for (const name of status.attachment.registeredNames) {
        attachedTools.push({ url: status.attachment.url, toolName: name });
      }
    }
  }

  return { statuses, attached, attachedTools, attach, detach };
}
