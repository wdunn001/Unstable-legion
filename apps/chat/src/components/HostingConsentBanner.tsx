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
 *
 * NOTE: `../hostingLabels.js` now has the lifecycle-aware
 * (Downloading/Loading into GPU/Hosting) + layer-count-clean label
 * helpers this component SHOULD render (see that module's doc comment
 * and its unit tests) — deliberately not wired in yet. Split out into a
 * follow-up PR so the functional load-path fixes (WebGPU device limits,
 * stall watchdog, OPFS persistence) could ship first; this component's
 * JSX is UNCHANGED pending that follow-up.
 */
import type { CommunalHostPhase } from '@unstable-legion/react';
import { ContributionPanel, type ContributionPanelProps } from './ContributionPanel.js';

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
  /** Human, model-named failure copy from `useCommunalHost` — shown as a
   * prominent error card (never a silent spinner) whenever the local host
   * is failing to load / retrying. Undefined when healthy. */
  errorMessage?: string;
  /** True while a bounded retry is scheduled (transient) — styles the card
   * as "retrying" rather than a hard "failing" state. */
  retrying?: boolean;
  /** "Hosting up to N layers (~X GB)" — always visible in the 'accepted'
   * state, computed by the caller from the CURRENT weight budget
   * (default or the "Contribute more" override). */
  capacitySummaryLabel: string;
  /** The "Contribute more" expander — undefined hides it entirely (e.g.
   * capacity math isn't ready yet). */
  contribution?: ContributionPanelProps;
  /** Live shard download/load progress for the stage this host is
   * currently loading — the SAME numbers `[stage-host] load progress`
   * logs to the console, rendered as a bar. Undefined outside a load. */
  downloadProgress?: { shardsFetched: number; totalShards: number; bytesFetched: number; totalBytes?: number };
}

/** "Downloading model layers: 17/36 · 1.8 / 4.4 GB" + a live bar. */
function DownloadProgressBar(props: { progress: NonNullable<HostingConsentBannerProps['downloadProgress']> }) {
  const { shardsFetched, totalShards, bytesFetched, totalBytes } = props.progress;
  const gb = (n: number) => (n / 1_000_000_000).toFixed(1);
  const pct = totalBytes
    ? Math.min(100, Math.round((bytesFetched / totalBytes) * 100))
    : Math.min(100, Math.round((shardsFetched / Math.max(1, totalShards)) * 100));
  return (
    <div className="host-download" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="host-download-label">
        Downloading model layers: {shardsFetched}/{totalShards}
        {totalBytes ? ` · ${gb(bytesFetched)} / ${gb(totalBytes)} GB` : ''}
      </div>
      <div className="capacity-bar-track">
        <div className="capacity-bar-fill capacity-bar-fill-ready" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** The host-failure card — rendered inside the hosting panel whenever the
 * local host can't load its claimed layers. Distinguishes transient
 * (retrying, with the countdown baked into `message`) from persistent
 * ("still failing"). Never a silent spinner. */
function HostErrorCard(props: { message: string; retrying?: boolean }) {
  return (
    <div className={`host-error-card ${props.retrying ? 'host-error-retrying' : 'host-error-failing'}`} role="alert" aria-live="polite">
      {/* Status glyph only, not a button — see ChatPane.tsx's identical
          note: a refresh-style glyph here reads as a clickable "retry"
          affordance even though nothing is wired to it. */}
      <span className="host-error-icon" aria-hidden="true">
        {props.retrying ? '⏳' : '⚠'}
      </span>
      <span className="host-error-message">{props.message}</span>
    </div>
  );
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
        <span className="consent-capacity-summary">{props.capacitySummaryLabel}</span>
        {props.hostingEnabled && props.downloadProgress && <DownloadProgressBar progress={props.downloadProgress} />}
        {props.hostingEnabled && props.errorMessage && <HostErrorCard message={props.errorMessage} retrying={props.retrying} />}
        {props.capable && props.contribution && <ContributionPanel {...props.contribution} />}
      </div>
    );
  }

  return (
    <button type="button" className="btn-link consent-reconsider" onClick={props.onReconsider}>
      Contribute your GPU to this mesh
    </button>
  );
}
