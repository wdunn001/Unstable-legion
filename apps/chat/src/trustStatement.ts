/**
 * The trust statement — single source of truth for the exact wording the
 * M5 brief mandates "verbatim". `TrustInterstitial` (the first-message
 * gate) and `TrustBadge` (the always-visible header pill) both read
 * this; `docs/TRUST.md` mirrors it in prose for anyone who wants the
 * long-form doc without opening the app.
 *
 * NO HEDGING — the brief is explicit: the honest claim is "readable by
 * hosts", not "may be visible". Don't soften this wording without
 * updating docs/TRUST.md to match.
 */
export const TRUST_STATEMENT_PARAGRAPHS: readonly string[] = [
  'Unstable Legion runs on a peer-to-peer mesh, not a company’s servers. When you send a message, it is processed by other members’ computers — volunteers contributing part of their machine to help run this model.',
  'The activations that pass through a volunteer’s computer can be reconstructed into the text you typed and the text you receive. Treat everything you type here as readable by the room’s hosts.',
  'A malicious host could also alter the reply before it reaches you. There is no cryptographic guarantee against this today.',
  'Do not share secrets, passwords, private keys, or anything you would not want a stranger to read.',
];

export const TRUST_BADGE_TEXT =
  'Community-powered — messages are processed on other members’ computers.';

const ACK_STORAGE_KEY = 'unstable-legion-chat:trust-ack-v1';

/** Persisted acknowledgement is keyed by the host-set the user acked
 * against (a sorted, joined list of peerIds) — re-showing the
 * interstitial "on host-set change" (per the brief) means a DIFFERENT
 * key won't match a stored ack, without needing a separate boolean plus
 * a separate "what changed" comparison. */
export function loadAckedHostSetKey(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(ACK_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveAckedHostSetKey(key: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(ACK_STORAGE_KEY, key);
  } catch {
    /* quota / privacy — silent, worst case the interstitial re-shows */
  }
}

/** Canonicalize a set of host peerIds (the non-local stages of a
 * `CommunalRoute` plan) into a stable, order-independent key. */
export function hostSetKey(peerIds: readonly string[]): string {
  return [...new Set(peerIds)].sort().join(',');
}

/** Extract the remote (non-local, `stageIndex > 0`) host peerIds from a
 * `useCommunalChat` plan — the set whose composition change should
 * re-trigger the trust interstitial. */
export function remoteHostPeerIds(plan: { stages: readonly { stageIndex: number; peerId: string }[] } | undefined): readonly string[] {
  if (!plan) return [];
  return plan.stages.filter((s) => s.stageIndex > 0).map((s) => s.peerId);
}

/** Sentinel meaning "the user acknowledged the trust statement, but no
 * route was resolved yet at that moment" (the very first message in a
 * session — the interstitial necessarily gates BEFORE `chat.start()` has
 * built a plan). Distinct from `null` ("never acknowledged at all"). */
export const ACK_PENDING_ROUTE = 'pending' as const;
export type AckedHostKey = string | typeof ACK_PENDING_ROUTE | null;

/** Pure gating decision for whether the trust interstitial must be shown
 * again before the next send. Kept separate from any component so it's
 * unit-testable without mounting React or a mesh — see
 * test/trustGate.test.ts.
 *
 *   - never acked (`null`)                      -> true
 *   - acked, route not resolved yet (`pending`)  -> false (nothing to compare)
 *   - acked against a known key, no current plan -> false (no new info)
 *   - acked against a known key, plan differs    -> true
 *   - acked against a known key, plan matches    -> false
 */
export function needsTrustAck(ackedHostKey: AckedHostKey, currentPlanHostKey: string | undefined): boolean {
  if (ackedHostKey === null) return true;
  if (ackedHostKey === ACK_PENDING_ROUTE) return false;
  if (!currentPlanHostKey) return false;
  return currentPlanHostKey !== ackedHostKey;
}
