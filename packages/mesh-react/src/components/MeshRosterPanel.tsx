/**
 * MeshRosterPanel — live peer list + aggregated public-tool registry.
 *
 * Click semantics (driven by `draftBridge`):
 *   - Click a peer row → insert `@<nick> ` into the chat composer's
 *     `/ai` prefix.
 *   - Click a tool row → fill the composer with a `/tool <peer> <name> {}`
 *     template.
 *
 * Host styles via the `ul-roster*` semantic classes.
 */
import { useEffect, useState } from 'react';
import type { MeshRosterEntry, MeshToolDescriptor } from '@unstable-legion/core';
import { useMeshContext } from '../provider.js';
import { useMeshRoster } from '../useMeshRoster.js';
import { useAggregatedTools, type AggregatedTool } from '../useAggregatedTools.js';
import { insertIntoDraft } from '../draftBridge.js';

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Width below which the panel defaults to collapsed. Matches the CSS
 * breakpoint that stacks roster + chat into a single column.
 */
const MOBILE_BREAKPOINT_PX = 720;

function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth <= MOBILE_BREAKPOINT_PX;
}

export function MeshRosterPanel() {
  const roster = useMeshRoster();
  const aggregated = useAggregatedTools();
  const { peer } = useMeshContext();
  const ready = roster.filter((p) => p.available).length;

  // Collapsed-by-default on mobile so the chat takes the visible viewport;
  // expanded-by-default on desktop where the side column is always visible.
  const [collapsed, setCollapsed] = useState<boolean>(() => isMobileViewport());

  // Re-evaluate on resize crossing the breakpoint, but only auto-collapse —
  // never auto-expand, since the user may have deliberately collapsed.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      if (isMobileViewport() && !collapsed) {
        // Heuristic: only auto-toggle when crossing into mobile and the user
        // hasn't already collapsed. Skip — the user can collapse manually.
        // Leaving this comment to document the intentional no-op.
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [collapsed]);

  return (
    <section className={collapsed ? 'ul-roster ul-roster-collapsed' : 'ul-roster'}>
      <button
        type="button"
        className="ul-roster-toggle"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="ul-roster-toggle-caret">{collapsed ? '▸' : '▾'}</span>
        <span className="ul-roster-toggle-label">
          Peers ({ready} ready / {roster.length} online) ·{' '}
          Tools ({aggregated.length})
        </span>
      </button>

      {!collapsed && (
        <>
          <h3 className="ul-roster-header">
            Peers ({ready} ready / {roster.length} online)
          </h3>
          {roster.length === 0 ? (
            <p className="ul-muted">no peers · waiting for cap announces</p>
          ) : (
            <ul className="ul-peers">
              {roster.map((p) => (
                <RosterRow
                  key={p.peerId}
                  entry={p}
                  isSelf={peer ? p.peerId === peer.selfId : false}
                />
              ))}
            </ul>
          )}
          <h3 className="ul-roster-header ul-agg-header">
            Public tools ({aggregated.length})
          </h3>
          {aggregated.length === 0 ? (
            <p className="ul-muted">no tools advertised yet.</p>
          ) : (
            <ul className="ul-agg-tools">
              {aggregated.map((t) => (
                <AggregatedToolRow key={t[0]} tool={t} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function RosterRow({ entry, isSelf }: { entry: MeshRosterEntry; isSelf: boolean }) {
  const onClick = () => {
    if (isSelf) return;
    insertIntoDraft((current) => {
      const stripped = current.replace(/^\/ai\s+(@\S+\s+)?/, '');
      return `/ai @${entry.nick} ${stripped}`.trimEnd() + ' ';
    });
  };
  return (
    <li
      className={isSelf ? 'ul-roster-row ul-roster-self' : 'ul-roster-row ul-clickable'}
      onClick={onClick}
      title={
        isSelf
          ? 'this peer is you — /ai @self isn’t supported'
          : 'click → insert @nick into the chat draft'
      }
    >
      <strong>@{entry.nick}</strong>{' '}
      <span className="ul-muted">{truncate(entry.peerId, 8)}</span>{' '}
      {isSelf && <span className="ul-self-badge">[you]</span>}{' '}
      <span className={entry.available ? 'ul-avail' : 'ul-avail ul-off'}>
        {entry.available ? '●' : '○'}
      </span>
      <div className="ul-model">{entry.modelId}</div>
      {entry.systemPromptSummary && (
        <div className="ul-muted ul-summary">"{entry.systemPromptSummary}"</div>
      )}
      {entry.skills.length > 0 && (
        <div className="ul-skills">
          {entry.skills.map((s) => (
            <span key={s} className="ul-chip">
              {s}
            </span>
          ))}
        </div>
      )}
      {entry.tools.length > 0 && (
        <div className="ul-tools">
          <span className="ul-tools-label">tools:</span>
          {entry.tools.map((t: MeshToolDescriptor) => (
            <span key={t.name} className="ul-chip ul-tool" title={t.description}>
              {t.name}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

function AggregatedToolRow({ tool }: { tool: AggregatedTool }) {
  const [name, info] = tool;
  const onClick = () => {
    const target = info.peers[0] ?? '<peer>';
    insertIntoDraft(() => `/tool ${target} ${name} {}`);
  };
  return (
    <li
      className="ul-agg-row ul-clickable"
      onClick={onClick}
      title="click → insert /tool template into chat draft"
    >
      <strong>{name}</strong>{' '}
      <span className="ul-muted">
        · {info.peers.length} peer{info.peers.length === 1 ? '' : 's'}: {info.peers.join(', ')}
      </span>
      <div className="ul-muted ul-summary">{info.description || '(no description)'}</div>
    </li>
  );
}
