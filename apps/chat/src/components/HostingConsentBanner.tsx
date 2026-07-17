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
 * The status row is driven by `../hostingLabels.js`'s lifecycle state
 * machine (`deriveHostingLifecycleState` → `hostingStatusLabel`): the word
 * "Hosting" appears ONLY once the stage is genuinely loaded into VRAM and
 * advertising/serving — before that it reads "Downloading model…" then
 * "Loading into GPU…", so a remote caller's would-be host never looks
 * "ready" while its weights are still in flight.
 */
import type { CommunalHostPhase } from '@unstable-legion/react';
import {
  claimLayerCount,
  deriveHostingLifecycleState,
  downloadProgressFraction,
  downloadProgressLabel,
  formatGigabytes,
  hostingStatusLabel,
  type HostingLifecycleState,
} from '../hostingLabels.js';
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

/**
 * The live "what is my browser actually doing right now" readout — the whole
 * point of the hosting panel while a stage loads. Shows the SAME numbers the
 * console logs ("shard 3/12 (251/1274 MB)"), expressed in LAYER units + real
 * GB (see hostingLabels' module doc on why raw fragment counts mislead), plus
 * a percentage and a bar. During 'opening' the download is done and the
 * native load into VRAM is running — say so instead of a stuck "11 of 11".
 */
function DownloadProgressBar(props: {
  progress: NonNullable<HostingConsentBannerProps['downloadProgress']>;
  layerCount: number;
  lifecycle: HostingLifecycleState;
}) {
  const fraction = downloadProgressFraction(props.progress);
  const pct = Math.round(fraction * 100);
  const label =
    props.lifecycle === 'opening'
      ? `Loading ${props.layerCount} layer${props.layerCount === 1 ? '' : 's'} into GPU — ${formatGigabytes(
          props.progress.totalBytes ?? props.progress.bytesFetched,
        )} fetched, opening stage…`
      : `${downloadProgressLabel(props.progress, props.layerCount)} · ${pct}%`;
  return (
    <div
      className="host-download"
      role="progressbar"
      aria-valuenow={props.lifecycle === 'opening' ? 100 : pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className="host-download-label">{label}</div>
      <div className="capacity-bar-track">
        <div
          className="capacity-bar-fill capacity-bar-fill-ready"
          style={{ width: `${props.lifecycle === 'opening' ? 100 : pct}%` }}
        />
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
    // The right-drawer host lifecycle: off → Ready to host → Downloading
    // model… → Loading into GPU… → Hosting N layers. Same signals the
    // console logs, but a caller (local OR remote) now sees WHY a host isn't
    // answering yet instead of a stage that claims "ready" mid-download.
    const lifecycle = deriveHostingLifecycleState({
      hostingEnabled: props.hostingEnabled,
      phase: props.phase,
      claim: props.claim,
      downloadProgress: props.downloadProgress,
    });
    const statusLabel = hostingStatusLabel(lifecycle, {
      claim: props.claim,
      capacityPreviewLabel: props.capacitySummaryLabel.replace(/^Hosting\s+/i, ''),
    });
    return (
      <div className="consent-status" role="region" aria-label="Hosting status">
        <label className="consent-toggle">
          <input
            type="checkbox"
            checked={props.hostingEnabled}
            disabled={!props.capable}
            onChange={(e) => props.onToggleHosting(e.target.checked)}
          />
          <span className={`consent-status-label consent-status-${lifecycle}`}>{statusLabel}</span>
        </label>
        {!props.capable && <span className="consent-banner-unsupported">{props.unsupportedReason}</span>}
        <span className="consent-capacity-summary">{props.capacitySummaryLabel}</span>
        {/* The bar stays visible through 'opening' (every shard fetched, native
            load into VRAM running) so "Loading into GPU…" isn't a bare spinner.
            Layer count comes from the actual claim when we have one, so the
            readout is in the same units the rest of the panel speaks. */}
        {props.hostingEnabled && (lifecycle === 'downloading' || lifecycle === 'opening') && props.downloadProgress && (
          <DownloadProgressBar
            progress={props.downloadProgress}
            layerCount={props.claim ? claimLayerCount(props.claim) : props.downloadProgress.totalShards}
            lifecycle={lifecycle}
          />
        )}
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
