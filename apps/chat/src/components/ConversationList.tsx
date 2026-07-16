import type { ChatThread } from '../db/threadStore.js';

export interface ConversationListProps {
  threads: readonly ChatThread[];
  activeThreadId: string | undefined;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

export function ConversationList(props: ConversationListProps) {
  return (
    <div className="conversation-list">
      <button type="button" className="btn btn-primary conversation-new" onClick={props.onNew}>
        + New chat
      </button>
      <ul className="conversation-items">
        {props.threads.map((t) => (
          <li key={t.id} className={`conversation-item ${t.id === props.activeThreadId ? 'conversation-item-active' : ''}`}>
            <button type="button" className="conversation-item-select" onClick={() => props.onSelect(t.id)}>
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
  );
}
