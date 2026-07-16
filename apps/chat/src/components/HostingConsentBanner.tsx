/**
 * HostingConsentBanner — the sticky, one-time "contribute your GPU"
 * prompt (M5 brief §4). Three states, all driven by `App.tsx`'s
 * persisted `hostingConsent` (`localStorage`, see `useHostingConsent`):
 *
 *   - 'unset'     — first visit: full prompt, Accept/Decline.
 *   - 'accepted'  — capable + consenting: a slim status row with a live
 *                   on/off toggle (leaving is always one click, no
 *                   re-prompt) and the current claim/phase.
 *   - 'declined'  — a minimal, low-pressure link back into the prompt.
 *
 * Capability-gated per the brief ("Respect WebGPU capability — don't
 * offer hosting to a device that can't"): `capable === false` disables
 * the Accept action and explains why, in both the 'unset' and (in case a
 * capability probe resolves AFTER an earlier accept on a since-changed
 * device) 'accepted' states.
 */
import type { CommunalHostPhase } from '@unstable-legion/react';

export type HostingConsent = 'unset' | 'accepted' | 'declined';

export interface HostingConsentBannerProps {
  consent: HostingConsent;
  capable: boolean;
  unsupportedReason?: string;
  onAccept: () => void;
  onDecline: () => void;
  onReconsider: () => void;
  hostingEnabled: boolean;
  onToggleHosting: (enabled: boolean) => void;
  phase: CommunalHostPhase;
  claim?: { layerStart: number; layerEnd: number };
  approxDownloadLabel: string;
  layerRangeLabel: string;
}

export function HostingConsentBanner(props: HostingConsentBannerProps) {
  if (props.consent === 'unset') {
    return (
      <div className="consent-banner" role="region" aria-label="Contribute your GPU">
        <div className="consent-banner-body">
          <strong>Contribute your GPU to help power this model?</strong>
          <p>
            Your browser will host part of Qwen3-8B (layers {props.layerRangeLabel}, ~{props.approxDownloadLabel}) and
            process other members' messages while this tab is open. Contributors get priority when the mesh is busy —
            everyone else is still served, just later.
          </p>
          {!props.capable && <p className="consent-banner-unsupported">{props.unsupportedReason ?? 'This device cannot host a model layer.'}</p>}
        </div>
        <div className="consent-banner-actions">
          <button type="button" className="btn btn-primary consent-accept" disabled={!props.capable} onClick={props.onAccept}>
            Yes, contribute
          </button>
          <button type="button" className="btn btn-ghost consent-decline" onClick={props.onDecline}>
            Not now
          </button>
        </div>
      </div>
    );
  }

  if (props.consent === 'accepted') {
    return (
      <div className="consent-status" role="region" aria-label="Hosting status">
        <label className="consent-toggle">
          <input
            type="checkbox"
            checked={props.hostingEnabled}
            disabled={!props.capable}
            onChange={(e) => props.onToggleHosting(e.target.checked)}
          />
          <span>
            Hosting{' '}
            {props.claim
              ? `layers ${props.claim.layerStart}–${props.claim.layerEnd}`
              : props.hostingEnabled
                ? `(${props.phase}…)`
                : '(off)'}
          </span>
        </label>
        {!props.capable && <span className="consent-banner-unsupported">{props.unsupportedReason}</span>}
      </div>
    );
  }

  return (
    <button type="button" className="btn-link consent-reconsider" onClick={props.onReconsider}>
      Contribute your GPU to this mesh
    </button>
  );
}
