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

/**
 * OPTIONAL-STAGE0 — extra paragraph shown ONLY to a THIN driver (a device
 * with no usable WebGPU that can't run even the first stage locally — see
 * `docs/OPTIONAL-STAGE0.md`). A thin driver ships its RAW TOKEN IDS (trivially
 * its prompt text) to a remote isFirst host instead of computing the private
 * first stage locally, so the very first hop can read the prompt directly —
 * strictly weaker privacy than the capable path. Surfaced verbatim, never
 * hidden, per `docs/TRUST.md`. */
export const THIN_DRIVER_TRUST_ADDENDUM =
  'Heads up: this device can’t run any part of the model itself, so it sends your message to the mesh as raw text tokens. A remote host performs the very first step your own computer would normally do privately — which means the first host on your route can read your prompt directly, with even less standing between your words and a stranger than the notice above already describes. Everything above still applies, only more so.';

/**
 * OPTIONAL-STAGE0 Phase 2 (text-relay) — extra paragraph shown ONLY when
 * this device is running in TEXT-RELAY mode (a thin driver that additionally
 * has no tokenizer of its own — see `useCommunalChat`'s `textRelay` option
 * and `docs/OPTIONAL-STAGE0.md`). Makes the SAME underlying trust posture as
 * `THIN_DRIVER_TRUST_ADDENDUM` more literal: not just token ids (which
 * already trivially reveal the prompt) but the PROMPT TEXT ITSELF leaves
 * this device in the clear, because there is no on-device tokenizer to turn
 * it into ids first. Surfaced verbatim, never hidden, per `docs/TRUST.md`. */
export const TEXT_RELAY_TRUST_ADDENDUM =
  'This device also has no tokenizer of its own, so what leaves it isn’t even token ids — it’s your message as plain text. The remote host reads it exactly as you typed it before doing anything else with it.';

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
