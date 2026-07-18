import type { ChatThread } from '../db/threadStore.js';
import { isMobileViewport, useMobileCollapse } from '../hooks/useMobileCollapse.js';

export interface ConversationListProps {
  threads: readonly ChatThread[];
  activeThreadId: string | undefined;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

export function ConversationList(props: ConversationListProps) {
  // Mobile: the list collapses to a one-line strip (`▸ Chats (N)` + a
  // compact new-chat button); desktop CSS hides the strip and always
  // shows the full list. See useMobileCollapse's doc comment.
  const [collapsed, setCollapsed] = useMobileCollapse();

  return (
    <div className="conversation-list">
      <button
        type="button"
        className="sidebar-toggle"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span> Chats ({props.threads.length})
        <span className="sidebar-toggle-spacer" />
        <span
          className="sidebar-toggle-action"
          role="button"
          aria-label="New chat"
          onClick={(e) => {
            // New chat straight from the strip — don't toggle expansion.
            e.stopPropagation();
            props.onNew();
          }}
        >
          +
        </span>
      </button>
      <div className={`conversation-list-body ${collapsed ? 'conversation-list-body-collapsed' : ''}`}>
        <button type="button" className="btn btn-primary conversation-new" onClick={props.onNew}>
          + New chat
        </button>
        <ul className="conversation-items">
          {props.threads.map((t) => (
            <li key={t.id} className={`conversation-item ${t.id === props.activeThreadId ? 'conversation-item-active' : ''}`}>
              <button
                type="button"
                className="conversation-item-select"
                onClick={() => {
                  props.onSelect(t.id);
                  // Picking a thread on a phone should return you to the
                  // chat, not leave a half-screen list overlaying it.
                  if (isMobileViewport()) setCollapsed(true);
                }}
              >
                {t.title || 'New chat'}
              </button>
              <button
                type="button"
                className="conversation-item-delete"
                aria-label={`Delete "${t.title}"`}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onDelete(t.id);
                }}
              >
                ×
              </button>
            </li>
          ))}
          {props.threads.length === 0 && <li className="conversation-empty">No conversations yet.</li>}
        </ul>
      </div>
    </div>
  );
}
