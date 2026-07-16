import { useRef, type KeyboardEvent } from 'react';

export interface ComposerProps {
  disabled: boolean;
  disabledReason?: string;
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function Composer(props: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function send() {
    const el = ref.current;
    if (!el) return;
    const text = el.value.trim();
    if (!text) return;
    props.onSend(text);
    el.value = '';
    el.style.height = 'auto';
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!props.disabled && !props.busy) send();
    }
  }

  function autoGrow() {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  }

  return (
    <div className="composer">
      {props.disabled && props.disabledReason && <div className="composer-disabled-reason">{props.disabledReason}</div>}
      <div className="composer-row">
        <textarea
          ref={ref}
          className="composer-input"
          placeholder={props.disabled ? 'Chat is unavailable right now…' : 'Message the mesh…'}
          disabled={props.disabled}
          onKeyDown={handleKeyDown}
          onInput={autoGrow}
          rows={1}
        />
        {props.busy ? (
          <button type="button" className="btn btn-stop composer-stop" onClick={props.onStop}>
            Stop
          </button>
        ) : (
          <button type="button" className="btn btn-primary composer-send" disabled={props.disabled} onClick={send}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
