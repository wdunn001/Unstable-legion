import { useCallback, useState } from 'react';
import type { HostingConsent } from '../components/HostingConsentBanner.js';

const STORAGE_KEY = 'unstable-legion-chat:hosting-consent-v1';

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

export interface UseHostingConsentHandle {
  consent: HostingConsent;
  accept: () => void;
  decline: () => void;
  /** Re-open the decision from the 'declined' state without wiping the
   * user's history of having declined once already (accept()/decline()
   * both just overwrite it). */
  reconsider: () => void;
}

/** Persisted one-time "contribute your GPU?" decision (M5 brief §4).
 * Capable-and-accepted is the ONLY state that auto-enables
 * `useCommunalHost` on a later visit — this hook only tracks the
 * decision, not the live on/off toggle (that's session-only state in
 * `App.tsx`, since "leaving" shouldn't erase a standing "yes"). */
export function useHostingConsent(): UseHostingConsentHandle {
  const [consent, setConsent] = useState<HostingConsent>(() => load());

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

  return { consent, accept, decline, reconsider };
}
