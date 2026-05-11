/**
 * SafetyDialog — surfaces a `blocked` outbound decision so the user
 * can redact, send-anyway, or cancel. Default action is redact (the
 * safest path for the prefilter's bias toward false positives).
 */
import type { OutboundDecision } from '@unstable-legion/core';

export interface SafetyDialogProps {
  decision: Extract<OutboundDecision, { kind: 'blocked' }>;
  onRedact: () => void;
  onSendAnyway: () => void;
  onCancel: () => void;
}

export function SafetyDialog(props: SafetyDialogProps) {
  const { decision } = props;
  return (
    <div className="ul-dialog-shade" role="dialog" aria-modal="true">
      <div className="ul-dialog">
        <h4>safety prefilter caught something</h4>
        <p>
          one or more matches fired in the categories:{' '}
          {decision.categories.map((c) => (
            <span key={c} className="ul-chip ul-chip-danger">
              {c}
            </span>
          ))}
        </p>
        <div className="ul-dialog-excerpt">
          <code>{decision.text}</code>
        </div>
        <div className="ul-dialog-actions">
          <button onClick={props.onRedact} className="ul-primary">redact &amp; send</button>
          <button onClick={props.onSendAnyway}>send anyway</button>
          <button onClick={props.onCancel}>cancel</button>
        </div>
      </div>
    </div>
  );
}
