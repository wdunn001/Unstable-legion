import type { StandingView } from '../viewmodels/meshViewModels.js';

const TIER_LABEL: Record<StandingView['tier'], string> = {
  top: 'Top contributor',
  contributing: 'Contributing',
  newcomer: 'Newcomer',
  debt: 'Building standing',
};

export function StandingPanel(props: { standing: StandingView }) {
  const { standing } = props;
  return (
    <section className="mesh-card standing-panel">
      <h3>Your standing</h3>
      <div className={`standing-tier standing-tier-${standing.tier}`}>{TIER_LABEL[standing.tier]}</div>
      <p className="standing-message">{standing.message}</p>
      {standing.hostedRange && (
        <p className="standing-hosted">
          Hosting layers {standing.hostedRange.layerStart}–{standing.hostedRange.layerEnd} right now.
        </p>
      )}
    </section>
  );
}
