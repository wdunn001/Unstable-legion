/**
 * TrustInterstitial — blocks the first message (and re-blocks on a
 * host-set change) until the user acknowledges exactly what "communal"
 * means for their traffic. See docs/TRUST.md for the full rationale;
 * this component renders the SAME paragraphs verbatim
 * (`trustStatement.ts`), never a paraphrase.
 */
import { TRUST_STATEMENT_PARAGRAPHS, THIN_DRIVER_TRUST_ADDENDUM } from '../trustStatement.js';

export interface TrustInterstitialProps {
  /** True when this is a re-prompt because the host set serving this
   * chat changed, not the very first message. Changes the framing from
   * "before you begin" to "your hosts changed". */
  isHostSetChange: boolean;
  /** OPTIONAL-STAGE0 — true when THIS device is a thin driver (no local
   * stage; ships raw token-ids to a remote isFirst host). Shows the
   * `THIN_DRIVER_TRUST_ADDENDUM` — the stricter privacy notice — verbatim.
   * See `docs/OPTIONAL-STAGE0.md` / `docs/TRUST.md`. */
  thinDriver?: boolean;
  onAcknowledge: () => void;
}

export function TrustInterstitial(props: TrustInterstitialProps) {
  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-labelledby="trust-interstitial-title">
      <div className="modal trust-interstitial">
        <h2 id="trust-interstitial-title">
          {props.isHostSetChange ? 'Your chat just moved to new hosts' : 'Before you send your first message'}
        </h2>
        {props.isHostSetChange && (
          <p className="trust-interstitial-subhead">
            The mesh reassigned who's computing your chat. The same trust applies to the new hosts — read it again.
          </p>
        )}
        {TRUST_STATEMENT_PARAGRAPHS.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
        {props.thinDriver && (
          <p className="trust-interstitial-thin" role="note">
            <strong>{THIN_DRIVER_TRUST_ADDENDUM}</strong>
          </p>
        )}
        <button type="button" className="btn btn-primary trust-interstitial-ack" onClick={props.onAcknowledge}>
          I understand — continue
        </button>
      </div>
    </div>
  );
}
