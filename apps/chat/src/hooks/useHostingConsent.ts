import { useCallback, useState } from 'react';
import type { HostingConsent } from '../components/HostingConsentBanner.js';

const STORAGE_KEY = 'unstable-legion-chat:hosting-consent-v1';
const CONTRIBUTION_BUDGET_STORAGE_KEY = 'unstable-legion-chat:contribution-budget-bytes-v1';
const MAX_LAYERS_OVERRIDE_STORAGE_KEY = 'unstable-legion-chat:max-layers-override-v1';

function load(): HostingConsent {
  if (typeof localStorage === 'undefined') return 'unset';
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'accepted' || raw === 'declined' ? raw : 'unset';
  } catch {
    return 'unset';
  }
}

function save(v: HostingConsent): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (v === 'unset') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* quota / privacy — silent */
  }
}

/** Sticky "Contribute more" budget override (bytes) — see
 * `ContributionPanel.tsx`. `undefined` = no override, the safe default
 * (~1.6GB / ~11 layers for Qwen3-8B) applies unchanged. */
function loadContributionBudgetBytes(): number | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(CONTRIBUTION_BUDGET_STORAGE_KEY);
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function saveContributionBudgetBytes(bytes: number | undefined): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (bytes === undefined) localStorage.removeItem(CONTRIBUTION_BUDGET_STORAGE_KEY);
    else localStorage.setItem(CONTRIBUTION_BUDGET_STORAGE_KEY, String(Math.round(bytes)));
  } catch {
    /* quota / privacy — silent */
  }
}

/** Sticky "Layers to host: N of 34" override — a direct layer-count cap
 * that supersedes the VRAM-derived (`contributionBudgetBytes`) claim
 * width, for users who'd rather just pick a layer count than reason about
 * GB. `undefined` = no override, the byte-budget-derived count applies
 * unchanged (today's only behavior, pre-this-feature). See
 * `useCommunalHost`'s `maxLayersOverride` option. */
function loadMaxLayersOverride(): number | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(MAX_LAYERS_OVERRIDE_STORAGE_KEY);
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function saveMaxLayersOverride(layers: number | undefined): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (layers === undefined) localStorage.removeItem(MAX_LAYERS_OVERRIDE_STORAGE_KEY);
    else localStorage.setItem(MAX_LAYERS_OVERRIDE_STORAGE_KEY, String(Math.round(layers)));
  } catch {
    /* quota / privacy — silent */
  }
}

export interface UseHostingConsentHandle {
  consent: HostingConsent;
  accept: () => void;
  decline: () => void;
  /** Re-open the decision from the 'declined' state without wiping the
   * user's history of having declined once already (accept()/decline()
   * both just overwrite it). */
  reconsider: () => void;
  /** Persisted "Contribute more" weight-budget override (bytes), or
   * `undefined` when using the safe default. Threaded into
   * `useCommunalHost`'s `contributionBudgetBytes` option. */
  contributionBudgetBytes: number | undefined;
  /** Set (or clear, with `undefined`) the override — persists immediately. */
  setContributionBudgetBytes: (bytes: number | undefined) => void;
  /** Persisted "Layers to host: N of 34" direct override, or `undefined`
   * when using the VRAM/byte-budget-derived count. Threaded into
   * `useCommunalHost`'s `maxLayersOverride` option. */
  maxLayersOverride: number | undefined;
  /** Set (or clear, with `undefined`) the override — persists immediately. */
  setMaxLayersOverride: (layers: number | undefined) => void;
}

/** Persisted one-time "contribute your GPU?" decision (M5 brief §4).
 * Capable-and-accepted is the ONLY state that auto-enables
 * `useCommunalHost` on a later visit — this hook only tracks the
 * decision, not the live on/off toggle (that's session-only state in
 * `App.tsx`, since "leaving" shouldn't erase a standing "yes"). Also owns
 * the "Contribute more" budget override — same sticky-localStorage
 * discipline, same file, since both are "how much of myself do I lend
 * this mesh" decisions. */
export function useHostingConsent(): UseHostingConsentHandle {
  const [consent, setConsent] = useState<HostingConsent>(() => load());
  const [contributionBudgetBytes, setContributionBudgetBytesState] = useState<number | undefined>(() => loadContributionBudgetBytes());
  const [maxLayersOverride, setMaxLayersOverrideState] = useState<number | undefined>(() => loadMaxLayersOverride());

  const accept = useCallback(() => {
    setConsent('accepted');
    save('accepted');
  }, []);
  const decline = useCallback(() => {
    setConsent('declined');
    save('declined');
  }, []);
  const reconsider = useCallback(() => {
    setConsent('unset');
    save('unset');
  }, []);
  const setContributionBudgetBytes = useCallback((bytes: number | undefined) => {
    setContributionBudgetBytesState(bytes);
    saveContributionBudgetBytes(bytes);
  }, []);
  const setMaxLayersOverride = useCallback((layers: number | undefined) => {
    setMaxLayersOverrideState(layers);
    saveMaxLayersOverride(layers);
  }, []);

  return {
    consent,
    accept,
    decline,
    reconsider,
    contributionBudgetBytes,
    setContributionBudgetBytes,
    maxLayersOverride,
    setMaxLayersOverride,
  };
}
