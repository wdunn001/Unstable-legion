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
  /**
   * Optional mesh worker. When present, MCP attach/detach are
   * forwarded into the worker (the worker owns the tool registry
   * and the actual fetches) and `mcpStatus` events stream back
   * here. The `registry` prop is then ignored.
   */
  worker?: Worker;
}

export function useMcpAttachments(opts: UseMcpAttachmentsOptions): UseMcpAttachmentsHandle {
  const { registry, urls, proxyBaseUrl, worker } = opts;
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
        if (worker) {
          // Worker mode: ask the worker to do the actual MCP work.
          // The worker streams back `mcpStatus` events which the
          // listener below converts into setStatus updates. The
          // promise resolves on the worker's response message; the
          // status is already updated by then via the event stream.
          await new Promise<void>((resolve, reject) => {
            const requestId = `mcp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
            const handler = (event: MessageEvent<unknown>): void => {
              const m = event.data as { kind?: string; requestId?: string; ok?: boolean; error?: string };
              if (m?.kind === 'response' && m.requestId === requestId) {
                worker.removeEventListener('message', handler);
                if (m.ok) resolve();
                else reject(new Error(m.error ?? 'mcpAttach failed'));
              }
            };
            worker.addEventListener('message', handler);
            worker.postMessage({ kind: 'mcpAttach', requestId, url });
          });
        } else {
          const attachment = await discoverMcpEndpoint(url, registry, { proxyBaseUrl });
          setStatus(url, { phase: 'attached', attachment });
        }
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
    [registry, setStatus, proxyBaseUrl, worker],
  );

  const detach = useCallback(
    (url: string) => {
      if (worker) {
        worker.postMessage({ kind: 'mcpDetach', url });
      } else {
        const status = statusesRef.current.get(url);
        if (status?.phase === 'attached') {
          detachMcpEndpoint(status.attachment, registry);
        }
      }
      setStatuses((prev) => {
        const m = new Map(prev);
        m.delete(url);
        return m;
      });
    },
    [registry, worker],
  );

  // Subscribe to mcpStatus events from the worker (worker mode only).
  useEffect(() => {
    if (!worker) return;
    const handler = (event: MessageEvent<unknown>): void => {
      const m = event.data as { kind?: string; url?: string; status?: McpAttachmentStatus };
      if (m?.kind === 'mcpStatus' && typeof m.url === 'string' && m.status) {
        setStatus(m.url, m.status);
      }
    };
    worker.addEventListener('message', handler);
    return () => {
      worker.removeEventListener('message', handler);
    };
  }, [worker, setStatus]);

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
