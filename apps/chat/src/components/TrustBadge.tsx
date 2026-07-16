import { TRUST_BADGE_TEXT } from '../trustStatement.js';

/** Always-visible header pill — present on every screen, not just the
 * one-time interstitial. See docs/TRUST.md. */
export function TrustBadge() {
  return (
    <span className="trust-badge" title={TRUST_BADGE_TEXT}>
      <span className="trust-badge-dot" aria-hidden="true" />
      {TRUST_BADGE_TEXT}
    </span>
  );
}
