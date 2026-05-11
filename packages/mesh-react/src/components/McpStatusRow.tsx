/**
 * McpStatusRow — pills for each attached MCP endpoint showing
 * connecting / attached / error state.
 */
import type { UseMcpAttachmentsHandle } from '../useMcp.js';

export interface McpStatusRowProps {
  mcp: UseMcpAttachmentsHandle;
  /** Text shown when the operator has no endpoints configured. */
  emptyMessage?: string;
}

export function McpStatusRow(props: McpStatusRowProps) {
  const { mcp } = props;
  const emptyMessage =
    props.emptyMessage ?? 'no MCP endpoints attached.';
  const entries = [...mcp.statuses.entries()];
  if (entries.length === 0) {
    return (
      <section className="ul-mcp-row">
        <span className="ul-muted">{emptyMessage}</span>
      </section>
    );
  }
  return (
    <section className="ul-mcp-row">
      <span className="ul-mcp-label">MCP:</span>
      {entries.map(([url, status]) => {
        let host: string;
        try {
          host = new URL(url).hostname;
        } catch {
          host = url;
        }
        if (status.phase === 'connecting') {
          return (
            <span key={url} className="ul-mcp-pill ul-mcp-connecting" title={url}>
              {host} (connecting…)
            </span>
          );
        }
        if (status.phase === 'attached') {
          return (
            <span
              key={url}
              className="ul-mcp-pill ul-mcp-ok"
              title={`${url} — ${status.attachment.descriptors.length} tools`}
            >
              {host} · {status.attachment.descriptors.length} tools
            </span>
          );
        }
        if (status.phase === 'error') {
          const detail = 'detail' in status.error ? status.error.detail : '';
          return (
            <span
              key={url}
              className="ul-mcp-pill ul-mcp-err"
              title={`${url} — ${status.error.kind}: ${detail}`}
            >
              {host} ({status.error.kind})
            </span>
          );
        }
        return null;
      })}
    </section>
  );
}
